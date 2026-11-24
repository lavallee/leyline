// Dispatch: work a person (or an agent) sends from a document to a runner, the record of
// what was sent, and what the runner says became of it. The contract a runner speaks is in
// docs/dispatch.md: one command per destination, run once per operation (submit, status,
// cancel) with JSON on stdin and JSON on stdout. Nothing here knows what a runner does.
//
// Destinations come from the host's configuration, never from a request: which runner, where
// the work may happen, and whether an item waits for the owner before it is sent.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { safeName, readJson, writeJson, setAside, corruptError } from './files.mjs';
import { track } from './children.mjs';

export const RUNNER_STATUSES = ['queued', 'running', 'needs-review', 'done', 'failed', 'cancelled'];
const OPEN = ['queued', 'running', 'needs-review'];
const LIMITS = { title: 200, brief: 20_000, summary: 2000, message: 20_000, link: 2000, links: 20, files: 200, error: 1000 };

/** A failure the host can show as it is (a refusal, or what a runner said). */
export class DispatchError extends Error {
  constructor(message, code = 'refused') { super(message); this.code = code; }
}

const clip = (value, max) => typeof value === 'string' ? value.replace(/\0/g, '').slice(0, max) : undefined;
const isUrl = value => { try { return ['http:', 'https:', 'file:'].includes(new URL(value).protocol); } catch { return false; } };

/** A runner's answer, kept to what the contract allows. Anything else in it is dropped. */
function cleanAnswer(answer, { needId = true } = {}) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new DispatchError('The runner did not answer with a JSON object.', 'runner');
  if (needId && (typeof answer.id !== 'string' || !answer.id || answer.id.length > 200)) throw new DispatchError('The runner did not give the job an id.', 'runner');
  if (!RUNNER_STATUSES.includes(answer.status)) throw new DispatchError(`The runner answered with a status this does not know (${String(answer.status).slice(0, 40)}).`, 'runner');
  const out = { status: answer.status };
  if (needId) out.job = answer.id;
  if (isUrl(answer.link)) out.link = clip(answer.link, LIMITS.link);
  if (typeof answer.summary === 'string') out.summary = clip(answer.summary, LIMITS.summary);
  const r = answer.result;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    out.result = {
      ...(typeof r.message === 'string' ? { message: clip(r.message, LIMITS.message) } : {}),
      links: (Array.isArray(r.links) ? r.links : []).filter(l => l && isUrl(l.url)).slice(0, LIMITS.links).map(l => ({ label: clip(String(l.label ?? l.url), LIMITS.title), url: clip(l.url, LIMITS.link) })),
      files: (Array.isArray(r.files) ? r.files : []).filter(f => f && typeof f.path === 'string').slice(0, LIMITS.files).map(f => ({ path: clip(f.path, 500), change: clip(String(f.change ?? ''), LIMITS.title) })),
    };
  }
  return out;
}

/**
 * Runs a runner's command for one operation. Resolves with its parsed answer; rejects with
 * a DispatchError carrying the runner's own last line when it fails.
 */
export function callRunner(command, operation, payload, { timeout = 30, env } = {}) {
  if (!Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string' || !part)) return Promise.reject(new DispatchError('This destination has no runner command.', 'config'));
  return new Promise((resolve, reject) => {
    let child;
    try { child = track(spawn(command[0], [...command.slice(1), operation], { stdio: ['pipe', 'pipe', 'pipe'], env: env ?? process.env, windowsHide: true })); }
    catch (error) { reject(new DispatchError(`The runner could not be started: ${error.message}`, 'runner')); return; }
    let out = '', err = '', done = false;
    const finish = fn => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(() => reject(new DispatchError(`The runner did not answer within ${timeout} seconds.`, 'runner'))); }, timeout * 1000);
    child.stdout.on('data', d => { out += d; if (out.length > 4_000_000) child.kill('SIGKILL'); });
    child.stderr.on('data', d => { err = (err + d).slice(-8000); });
    child.on('error', error => finish(() => reject(new DispatchError(`The runner could not be started: ${error.message}`, 'runner'))));
    child.on('close', code => finish(() => {
      const last = (err || out).trim().split('\n').filter(Boolean).at(-1) || '';
      if (code !== 0) return reject(new DispatchError(`The runner refused ${operation}${last ? `: ${last.slice(0, LIMITS.error)}` : ` (exit ${code})`}.`, 'runner'));
      try { resolve(JSON.parse(out.trim())); } catch { reject(new DispatchError(`The runner's answer to ${operation} was not JSON.`, 'runner')); }
    }));
    child.stdin.on('error', () => { /* a runner that exits without reading its input is judged by its exit */ });
    child.stdin.end(JSON.stringify({ v: 1, ...payload }));
  });
}

/**
 * @param {object} options
 * @param {string} options.dir where items are kept, one file per document
 * @param {Record<string, {label?: string, runner: string[], where?: {root?: string, paths?: string[]}, approval?: 'owner'|'none', agentApproval?: 'owner'|'none', timeout?: number, env?: object}>} options.destinations
 */
export function createDispatch({ dir, destinations = {}, now = () => Date.now() } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('Give dispatch a directory.');
  const queues = new Map();   // document -> the promise of its last change: one change at a time per document
  const fileOf = document => path.join(dir, `${safeName(document)}.json`);

  function read(document) {
    const file = fileOf(document);
    try { return readJson(file, { items: [] }); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; throw corruptError('The work list', setAside(file)); }
  }
  const write = (document, store) => writeJson(fileOf(document), store);
  function changing(document, fn) {
    const next = (queues.get(document) || Promise.resolve()).catch(() => {}).then(() => fn());
    queues.set(document, next);
    return next;
  }
  const stamp = () => new Date(now()).toISOString();
  function destinationOf(name) {
    const d = typeof name === 'string' && Object.hasOwn(destinations, name) ? destinations[name] : null;
    if (!d) throw new DispatchError('That destination is not set up for this document.', 'unknown');
    return d;
  }
  const find = (store, id) => { const item = store.items.find(i => i.id === id); if (!item) throw new DispatchError('That item is not in this document’s work.', 'unknown'); return item; };
  const update = (document, id, fn) => changing(document, () => { const store = read(document), item = find(store, id); fn(item); item.updatedAt = stamp(); write(document, store); return { ...item }; });

  /** The destinations a person may choose, as a page shows them. */
  const choices = () => Object.entries(destinations).map(([name, d]) => ({ name, label: d.label || name, approval: d.approval || 'owner' }));

  async function submit(document, id) {
    const item = await update(document, id, i => {
      if (i.status !== 'held') throw new DispatchError('Only an item that is waiting can be sent.', 'state');
      i.status = 'sending'; delete i.error;
    });
    const d = destinationOf(item.destination);
    try {
      const answer = cleanAnswer(await callRunner(d.runner, 'submit', { key: item.key, title: item.title, brief: item.brief, from: item.from, where: d.where || {}, by: item.by }, d));
      return await update(document, id, i => { Object.assign(i, answer, { sentAt: stamp() }); });
    } catch (error) {
      // Nothing is lost: the item waits again, with what the runner said.
      await update(document, id, i => { i.status = 'held'; i.error = clip(error.message, LIMITS.error); });
      throw error;
    }
  }

  return {
    choices,

    /** The document's items, newest first. */
    list: document => read(document).items.slice().reverse(),

    /**
     * Records an item and, unless it must wait for the owner, sends it. Returns the item;
     * a runner that fails leaves it waiting, with the reason in `error`.
     */
    async create(document, { destination, title, brief, from = {}, by = 'person' } = {}) {
      const d = destinationOf(destination);
      if (typeof brief !== 'string' || !brief.trim()) throw new DispatchError('Say what should be done.');
      if (!['person', 'agent'].includes(by)) throw new DispatchError('An item is sent by a person or an agent.');
      const at = stamp();
      const item = { id: `w${randomBytes(5).toString('hex')}`, key: `${safeName(document).slice(0, 24)}-${randomBytes(6).toString('hex')}`, destination,
        title: clip((typeof title === 'string' && title.trim()) || brief.trim().split('\n')[0], LIMITS.title), brief: clip(brief.trim(), LIMITS.brief),
        from: Object.fromEntries(['document', 'url', 'file', 'quote'].filter(k => typeof from[k] === 'string').map(k => [k, clip(from[k], k === 'quote' ? 4000 : 500)])
          .concat(['start', 'end'].filter(k => Number.isInteger(from[k])).map(k => [k, from[k]]))),
        by, createdAt: at, updatedAt: at, status: 'held' };
      await changing(document, () => { const store = read(document); store.items.push(item); write(document, store); });
      const waits = (by === 'agent' ? d.agentApproval || 'owner' : d.approval || 'owner') === 'owner';
      if (waits) return { ...item };
      try { return await submit(document, item.id); } catch (error) { if (error instanceof DispatchError) return read(document).items.find(i => i.id === item.id); throw error; }
    },

    /** Sends an item that was waiting for the owner. */
    send: submit,

    /** Asks the runner what became of open items (or one), and records it. */
    async refresh(document, id) {
      const open = read(document).items.filter(i => (id ? i.id === id : true) && i.job && OPEN.includes(i.status));
      for (const item of open) {
        const d = destinations[item.destination];
        if (!d) continue;
        try {
          const answer = cleanAnswer({ id: item.job, ...await callRunner(d.runner, 'status', { id: item.job }, d) });
          delete answer.job;
          await update(document, item.id, i => { Object.assign(i, answer); delete i.error; });
        } catch (error) { await update(document, item.id, i => { i.error = clip(error.message, LIMITS.error); }); }
      }
      return read(document).items.slice().reverse();
    },

    /** Drops an item that is waiting, or asks the runner to stop one that was sent. */
    async cancel(document, id) {
      const item = find(read(document), id);
      if (item.status === 'held') return update(document, id, i => { i.status = 'cancelled'; });
      if (!item.job || !OPEN.includes(item.status)) throw new DispatchError('That item is no longer open.', 'state');
      const d = destinationOf(item.destination);
      const answer = cleanAnswer({ id: item.job, ...await callRunner(d.runner, 'cancel', { id: item.job }, d) });
      delete answer.job;
      return update(document, id, i => { Object.assign(i, answer); });
    },
  };
}
