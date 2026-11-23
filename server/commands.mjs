// How an agent with a shell reaches the host it is working for: a small command-line
// program calls the host's server over loopback with a private key. Generalised from
// Copycat's bin/copycat-doc.mjs and its /agent/ route.
//
// Host side:   issueKey(), writeSession(), verifyRequest() or createCommandEndpoint()
// Agent side:  call(), from the host's own CLI script
//
// The operations themselves (what "show" or "edit" means) stay in the host. This module
// only makes sure a request comes from this machine and carries the key.
//
// What the checks are worth: they keep out web pages (which cannot avoid sending an
// Origin header on a cross-origin POST, and cannot read the session file) and other
// machines. They do not keep out other programs run by the same user, which can read
// the session file just as the agent's command does.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const digest = value => createHash('sha256').update(String(value)).digest();

/** A new random key: 48 hex characters. */
export const issueKey = () => randomBytes(24).toString('hex');

/** Compares two secrets without leaking, through timing, where or whether they differ. */
export const sameSecret = (given, secret) => typeof given === 'string' && typeof secret === 'string' && secret.length > 0 && timingSafeEqual(digest(given), digest(secret));

/** The user's state directory: $XDG_STATE_HOME, or ~/.local/state. */
export const stateHome = (env = process.env) => env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(os.homedir(), '.local', 'state');

/**
 * Where a session file lives: `<state dir>/<app>/<name>.json`. `app` is the host's name
 * and `name` tells sessions apart, for example `agent-4173` for the server on that port.
 */
export function sessionFile({ app, name, stateDir = stateHome() }) {
  if (!NAME.test(app || '') || !NAME.test(name || '')) throw new TypeError('A session needs a plain app name and session name.');
  return path.join(stateDir, app, `${name}.json`);
}

/** Writes { url, key } for the agent's command to find. The file is private (0600) in a private folder (0700). */
export async function writeSession({ app, name, url, key, stateDir }) {
  const file = sessionFile({ app, name, stateDir });
  if (!isLoopbackUrl(url)) throw new TypeError('A session URL must be a loopback http address.');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Written beside the real file and renamed, so the mode is right even when an older
  // file with a looser one is being replaced, and a reader never sees half a file.
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temporary, JSON.stringify({ url, key }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  return file;
}

export async function readSession({ app, name, stateDir }) {
  const session = JSON.parse(await readFile(sessionFile({ app, name, stateDir }), 'utf8'));
  if (typeof session?.url !== 'string' || typeof session?.key !== 'string') throw new Error('The session file is not in the expected form.');
  return session;
}

export const removeSession = ({ app, name, stateDir }) => rm(sessionFile({ app, name, stateDir }), { force: true });

function isLoopbackUrl(value) {
  try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); } catch { return false; }
}

/**
 * True when a request may use the agent's commands: it comes from a loopback address,
 * names this server by a loopback Host header, carries no Origin header (so it is not
 * from a web page), and its bearer key matches.
 * @param {object} req a Node http IncomingMessage
 * @param {{key: string, port: number}} options
 */
export function verifyRequest(req, { key, port }) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!LOOPBACK.includes(req.socket?.remoteAddress)) return false;
  if (!hosts.includes(req.headers.host)) return false;
  if (req.headers.origin !== undefined) return false;
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') && sameSecret(header.slice(7), key);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(new Error('The request is too large.'), { status: 413 })); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('The request body is not JSON.'), { status: 400 })); } });
    req.on('error', reject);
  });
}

/**
 * The host side as one piece: a handler for `POST <prefix><operation>` requests.
 * @param {object} options
 * @param {number|(() => number)} options.port the port the host's server listens on
 * @param {Record<string, (data: object, req: object) => any>} options.operations the host's table
 * @param {string} [options.key] default: a new key
 * @param {string} [options.prefix] default '/agent/'
 * @param {number} [options.maxBody] bytes; default 2,000,000
 * @returns {{key: string, handle: (req, res) => Promise<boolean>}} `handle` resolves false,
 *   having done nothing, when the path is not under the prefix; otherwise it answers and
 *   resolves true. A request that fails the checks gets a plain 404, the same as an unknown path.
 *   An operation that throws answers `{ error }` with the error's `status` (default 500);
 *   only errors that carry a status have their message passed on.
 */
export function createCommandEndpoint({ port, operations, key = issueKey(), prefix = '/agent/', maxBody = 2_000_000 }) {
  const table = new Map(Object.entries(operations || {}));
  const send = (res, status, value) => { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body); };
  return { key, async handle(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!pathname.startsWith(prefix)) return false;
    try {
      const operation = table.get(pathname.slice(prefix.length));
      if (!verifyRequest(req, { key, port: typeof port === 'function' ? port() : port }) || !operation) return send(res, 404, { error: 'Not found.' }), true;
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) return send(res, 405, { error: 'Use a JSON POST request.' }), true;
      const data = await readBody(req, maxBody);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { error: 'Send a JSON object.' }), true;
      send(res, 200, await operation(data, req) ?? {});
    } catch (error) {
      const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
      if (!res.headersSent) send(res, status, { error: Number.isInteger(error?.status) ? String(error.message) : 'The command failed.' });
    }
    return true;
  } };
}

/**
 * The agent side: one call from a CLI to the host that left a session file.
 * Throws an Error whose message is fit to print: the host's own `error` text when it
 * sent one.
 * @param {object} options
 * @param {string} options.app
 * @param {string} options.name
 * @param {string} options.operation
 * @param {object} [options.data]
 * @param {string} [options.prefix] default '/agent/'
 * @param {number} [options.timeout] milliseconds; default 120000
 */
export async function call({ app, name, operation, data = {}, prefix = '/agent/', stateDir, timeout = 120000, fetch: fetcher = globalThis.fetch }) {
  let session;
  try { session = await readSession({ app, name, stateDir }); } catch { throw new Error(`No ${app} session found for "${name}". Is its server running?`); }
  // The key is only ever sent to this machine.
  if (!isLoopbackUrl(session.url)) throw new Error('The session file does not point at this machine.');
  let response;
  try {
    response = await fetcher(`${session.url.replace(/\/+$/, '')}${prefix}${encodeURIComponent(operation)}`, { method: 'POST', signal: AbortSignal.timeout(timeout),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.key}` }, body: JSON.stringify(data) });
  } catch (error) { throw new Error(`Could not reach ${app}: ${String(error?.cause?.message || error?.message || error).slice(0, 200)}`); }
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || `${app} answered ${response.status}.`);
  return result ?? {};
}

/** Reads all of stdin as text: for commands that take JSON on stdin. */
export async function readStdin(stream = process.stdin) { let data = ''; for await (const chunk of stream) data += chunk; return data; }
