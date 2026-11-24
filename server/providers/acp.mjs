// Any coding agent that speaks the Agent Client Protocol (ACP), behind the provider
// contract: one child process, one ACP session per host key, text and activity streamed
// while it works. This module is the *client* side of the protocol (the side an editor
// plays), written on the transport in ../jsonrpc-stdio.mjs with no dependencies.
//
// Implemented against ACP protocol version 1 (the integer sent in `initialize`), read on
// 2026-11-23 from the specification and its JSON Schema (schema release v1.35.0):
//   https://agentclientprotocol.com/protocol/v1/overview
//   https://agentclientprotocol.com/protocol/v1/initialization
//   https://agentclientprotocol.com/protocol/v1/session-setup
//   https://agentclientprotocol.com/protocol/v1/prompt-turn
//   https://agentclientprotocol.com/protocol/v1/tool-calls
//   https://agentclientprotocol.com/protocol/v1/file-system
//   https://agentclientprotocol.com/protocol/v1/terminals
//   https://agentclientprotocol.com/protocol/v1/authentication
//   https://agentclientprotocol.com/protocol/v1/error
//   https://agentclientprotocol.com/protocol/v1/transports
//   https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json
//   https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/meta.json
// Version 2 of the protocol was a beta on that date (schema-v2.0.0-beta.4) and is not spoken here.
//
// Methods used:  initialize, authenticate (only when the host names a method), session/new,
//                session/load, session/resume, session/prompt, session/cancel, session/close
// Methods served: session/update, session/request_permission, fs/read_text_file,
//                fs/write_text_file, terminal/* (only when the host supplies all five hooks)
//
// What the host decides: the agent command, the folders, the hooks below. What this
// adapter always does:
// - a capability is advertised only when there is something behind it: file reads when
//   the host gives `roots` or `readFile`, file writes only with `writeFile`, terminals
//   only with all five terminal hooks. An agent that calls a method that was not
//   advertised is refused;
// - a permission request is answered by `onPermission`, and otherwise by the `permission`
//   policy, which refuses by default. Nothing here ever answers "allow always" by itself;
// - it never signs in for a person. An agent that wants authentication gets a
//   ProviderError with code 'auth' that names the methods the agent offered.
//
// What the protocol does not have: steering. Version 1 gives a client one thing to send
// while a prompt turn is running, `session/cancel` ("Clients MAY cancel an ongoing prompt
// turn at any time", protocol/v1/prompt-turn, read again on 2026-11-24 with the schema's
// list of client methods); there is no way to add input to a running turn, so
// `capabilities.steer` is false and this adapter has no steer(). A host sends the input as
// the next request.
//
// What it cannot do: confine the agent. An ACP agent runs its own tools in its own
// process, with the access of the user who started it. The hooks decide what the agent
// gets *through the client* (the live draft, a write turned into a proposal); the
// agent's own permission mode and the permission hook decide the rest. A host that
// needs a hard boundary must run the agent command inside one.
import { mkdir, readFile as readDisk, realpath } from 'node:fs/promises';
import path from 'node:path';
import { JsonRpcStdio, RpcError } from '../jsonrpc-stdio.mjs';
import { ProviderError, chosenOption, inputParts } from './contract.mjs';
import { SHORT_NAME, PACKAGE_VERSION } from '../package-info.mjs';

export const ACP_PROTOCOL_VERSION = 1;

// JSON-RPC error codes the specification names (protocol/v1/error), and one of this
// adapter's own, outside the reserved ranges, for "the host does not allow that".
const AUTH_REQUIRED = -32000, NOT_FOUND = -32002, NO_METHOD = -32601, BAD_PARAMS = -32602, INTERNAL = -32603, REFUSED = 4030;
const refusal = (code, message) => Object.assign(new Error(message), { rpcCode: code });

const STATUS = { pending: 'running', in_progress: 'running', completed: 'done', failed: 'failed' };
const TITLES = { read: 'Reading', edit: 'Editing', delete: 'Deleting', move: 'Moving', search: 'Searching', execute: 'Running a command',
  think: 'Thinking', fetch: 'Fetching', switch_mode: 'Switching mode', other: 'Using a tool' };
const PLAN_MARKS = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
const TERMINAL = { 'terminal/create': 'create', 'terminal/output': 'output', 'terminal/wait_for_exit': 'waitForExit', 'terminal/kill': 'kill', 'terminal/release': 'release' };
const OPTION_KINDS = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];
const CANCELLED = { outcome: { outcome: 'cancelled' } };

const textOf = block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
const present = value => value !== undefined && value !== null;
const inside = (root, target) => { const rel = path.relative(root, target); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); };
const count = (body, needle) => { let n = 0; for (let at = body.indexOf(needle); at >= 0; at = body.indexOf(needle, at + 1)) n++; return n; };
const detail = error => {
  const data = error?.data, more = typeof data === 'string' ? data : data?.details || data?.message;
  return typeof more === 'string' && more && !error.message.includes(more) ? `${error.message}: ${more}`.slice(0, 2000) : error.message;
};

/**
 * Turns an ACP `diff` (path, oldText, newText) into the find-and-replace text edit of
 * `../proposals.mjs`, when that is well defined. Agents differ in what they put in
 * `oldText`: some send the whole file, some only the lines they changed. Either way the
 * edit returned is the smallest run of whole lines that covers the change and occurs
 * exactly once, so it stays valid while a person edits elsewhere in the document.
 *
 * @param {{path: string, oldText?: string|null, newText: string}} diff
 * @param {object} [options]
 * @param {string} [options.file] the document's name for this path; default the path
 * @param {string} [options.current] the text the edit will be applied to (the live draft).
 *   With it, "exactly once" is judged against the draft rather than against `oldText`.
 * @returns {{ok: true, edit: {file: string, find: string, replace: string}} | {ok: false, code: string, problem: string}}
 *   codes: 'invalid', 'new-file', 'empty-file', 'no-change', 'not-found', 'ambiguous', 'too-large'
 */
export function diffToEdit(diff, { file, current } = {}) {
  const no = (code, problem) => ({ ok: false, code, problem });
  if (!diff || typeof diff.path !== 'string' || typeof diff.newText !== 'string') return no('invalid', 'A diff needs a path and its new text.');
  const { oldText, newText } = diff, name = typeof file === 'string' && file ? file : diff.path;
  if (typeof oldText !== 'string') return no('new-file', 'The diff creates a file, so there is no existing text to find and replace.');
  if (oldText === newText) return no('no-change', 'Nothing changes.');
  if (!oldText) return no('empty-file', 'The text before the change was empty, so there is nothing to find and replace.');
  const against = typeof current === 'string' ? current : oldText, size = oldText.length;
  // The changed span: what is left after the common start and the common end.
  const most = Math.min(size, newText.length);
  let head = 0; while (head < most && oldText[head] === newText[head]) head++;
  let tail = 0; while (tail < most - head && oldText[size - 1 - tail] === newText[newText.length - 1 - tail]) tail++;
  // Widened to whole lines, then by a line each way until it is found exactly once.
  let start = head === 0 ? 0 : oldText.lastIndexOf('\n', head - 1) + 1;
  let end = oldText.indexOf('\n', size - tail); if (end < 0) end = size;
  for (let round = 0; round < 400; round++) {
    const find = oldText.slice(start, end), times = find ? count(against, find) : 0;
    if (find && times === 1) {
      const replace = newText.slice(start, newText.length - (size - end));
      if (name.length > 500 || find.length > 100000 || replace.length > 200000) return no('too-large', 'The change is too large for one text edit.');
      if ([name, find, replace].some(part => part.includes('\0'))) return no('invalid', 'The change contains a NUL character.');
      return { ok: true, edit: { file: name, find, replace } };
    }
    if (find && times === 0) return no('not-found', 'The text the agent changed is not in the document as it is now.');
    if (start === 0 && end === size) break;
    if (start > 0) start = start === 1 ? 0 : oldText.lastIndexOf('\n', start - 2) + 1;
    if (end < size) { const next = oldText.indexOf('\n', end + 1); end = next < 0 ? size : next; }
  }
  return no('ambiguous', 'The text the agent changed occurs more than once in the document, so the edit has no single place to go.');
}

/** A slice of a text by 1-based first line and a line count, as fs/read_text_file asks for it. */
export function sliceLines(content, line, limit) {
  const from = Number.isInteger(line) && line > 1 ? line - 1 : 0, some = Number.isInteger(limit) && limit >= 0;
  if (!from && !some) return content;
  return content.split('\n').slice(from, some ? from + limit : undefined).join('\n');
}

export class AcpProvider {
  name = 'acp';
  capabilities = { activity: true, textStream: true, sessions: true, cancel: true, shell: true, structuredOutput: false, asks: true, steer: false };

  /**
   * @param {object} options
   * @param {string[]} options.command the agent's ACP command: an absolute path, then its arguments, for example
   *   ['/usr/local/bin/gemini', '--acp']. It comes from the host's configuration, never from a browser. No shell is used.
   * @param {string} options.workDir the child's working folder and the default session folder; created private if missing
   * @param {{name: string, title?: string, version?: string}} [options.clientInfo] how the host names itself
   * @param {object} [options.env] the child's environment; default process.env
   * @param {string[]} [options.dropEnv] names removed from it; default none
   * @param {string[]} [options.roots] folders the default file reader may read; default none
   * @param {(path: string, context: object) => string|undefined|Promise<string|undefined>} [options.readFile]
   *   serves fs/read_text_file. Return the text (a live draft, say); return undefined to leave the path to the default
   *   reader (`roots`); throw to refuse, with a message the agent will see. context: { key, sessionId, line, limit }
   * @param {(path: string, content: string, context: object) => void|Promise<void>} [options.writeFile]
   *   serves fs/write_text_file. Without it the capability is not advertised and writes are refused. Throw to refuse.
   * @param {'deny'|'allow-read'} [options.permission] what to answer a permission request the hook does not decide.
   *   'deny' (default) rejects. 'allow-read' allows once a tool call whose kind is `read` or `search` and whose
   *   reported locations all lie in the session folder or `roots`, and rejects the rest.
   * @param {(request: object, context: {signal: AbortSignal}) => any} [options.onPermission] decides a permission
   *   request; may return a promise, so a person can be asked. request: { key, sessionId, toolCall, options, diffs }.
   *   Return one of the request's optionIds, or a kind ('allow_once', 'allow_always', 'reject_once', 'reject_always')
   *   to pick the first option of that kind, or 'cancelled'; return nothing to leave it to `permission`. A throw rejects.
   * @param {{create: Function, output: Function, waitForExit: Function, kill: Function, release: Function}} [options.terminal]
   *   serves the five terminal/* methods; each receives the method's params and a context and returns its result.
   *   Without all five the terminal capability is not advertised.
   * @param {object[]} [options.mcpServers] MCP servers passed to every session, in ACP's shape; default none
   * @param {string} [options.authMethodId] an `agent`-type method id to send to `authenticate` after `initialize`. Set
   *   it only for a method that needs no person (an API key in the environment, a cached sign-in).
   * @param {'last'|'all'} [options.reply] which agent text is the reply: the last message of the turn (default; earlier
   *   ones become "Agent note" activity) or every message joined by blank lines
   * @param {number} [options.idleTimeout] default idle limit for runs, in milliseconds; 0 (default) is none
   * @param {number} [options.startTimeout] for initialize and authenticate; default 60000
   * @param {number} [options.sessionTimeout] for session/new, session/load and session/resume; default 120000
   * @param {number} [options.cancelGrace] how long a stopped run waits for the agent to confirm; default 10000
   * @param {(chunk: Buffer) => void} [options.onStderr]
   * @param {(line: string) => void} [options.onNoise] a line on the agent's stdout that was not a protocol message
   */
  constructor({ command, workDir, clientInfo = { name: SHORT_NAME, version: PACKAGE_VERSION }, env = process.env, dropEnv = [], roots = [], readFile, writeFile,
    permission = 'deny', onPermission, terminal, mcpServers = [], authMethodId, reply = 'last', idleTimeout = 0, startTimeout = 60000,
    sessionTimeout = 120000, cancelGrace = 10000, onStderr, onNoise } = {}) {
    if (!Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string' || !part || part.includes('\0')))
      throw new ProviderError('The agent command must be a list of non-empty strings.', 'config');
    if (!path.isAbsolute(command[0])) throw new ProviderError('Give the agent command as an absolute path.', 'config');
    if (typeof workDir !== 'string' || !path.isAbsolute(workDir)) throw new ProviderError('Give the agent a working folder (workDir), as an absolute path.', 'config');
    if (!['deny', 'allow-read'].includes(permission)) throw new ProviderError("The permission policy is 'deny' or 'allow-read'.", 'config');
    if (!Array.isArray(roots) || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new ProviderError('Roots are absolute folder paths.', 'config');
    if (!Array.isArray(mcpServers)) throw new ProviderError('mcpServers is a list.', 'config');
    for (const [name, hook] of Object.entries({ readFile, writeFile, onPermission }))
      if (hook !== undefined && typeof hook !== 'function') throw new ProviderError(`${name} must be a function.`, 'config');
    const terminals = terminal && Object.values(TERMINAL).every(name => typeof terminal[name] === 'function') ? terminal : null;
    if (terminal && !terminals) throw new ProviderError(`Terminal support needs all of: ${Object.values(TERMINAL).join(', ')}.`, 'config');
    Object.assign(this, { command, workDir, roots: roots.map(root => path.resolve(root)), readHook: readFile, writeHook: writeFile, permission, onPermission,
      terminals, mcpServers, authMethodId, reply, idleTimeout, startTimeout, sessionTimeout, cancelGrace, onStderr, onNoise });
    this.clientInfo = { name: clientInfo.name, title: clientInfo.title || clientInfo.name, version: clientInfo.version || '0.0.0' };
    this.env = Object.fromEntries(Object.entries(env).filter(([name]) => !dropEnv.includes(name)));
    this.clientCapabilities = { fs: { readTextFile: !!(readFile || roots.length), writeTextFile: !!writeFile }, terminal: !!terminals };
    this.sessions = new Map();  // host key -> { sessionId, cwd, model, roots, first }
    this.known = new Map();     // host key -> the last session id, kept across a crash so the session can be loaded again
    this.keys = new Map();      // session id -> host key
    this.runs = new Map();      // host key -> the run in flight
    this.agent = null;          // { info, capabilities, authMethods } once initialised
    this.ready = null;
  }

  /** Starts the child and negotiates. Safe to call often; run() calls it. Resolves to { info, capabilities, authMethods }. */
  start() {
    if (this.ready) return this.ready;
    let rpc;
    this.ready = (async () => {
      await mkdir(this.workDir, { recursive: true, mode: 0o700 });
      rpc = this.rpc = new JsonRpcStdio({ command: this.command, cwd: this.workDir, env: this.env });
      rpc.on('notification', message => this.notified(message));
      rpc.on('request', message => this.requested(rpc, message));
      rpc.on('noise', line => { try { this.onNoise?.(line); } catch { /* a host's handler must not break the connection */ } });
      rpc.on('exit', () => {
        if (this.rpc !== rpc) return;
        this.rpc = null; this.ready = null; this.agent = null; this.sessions.clear(); this.keys.clear();
        for (const run of [...this.runs.values()]) run.finish(new ProviderError('The agent connection stopped.', 'unavailable'));
      });
      rpc.start().stderr.on('data', chunk => { try { this.onStderr?.(chunk); } catch { /* as above */ } });
      const answer = await rpc.call('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: this.clientCapabilities, clientInfo: this.clientInfo }, this.startTimeout);
      if (answer?.protocolVersion !== ACP_PROTOCOL_VERSION)
        throw new ProviderError(`The agent answered with ACP protocol version ${JSON.stringify(answer?.protocolVersion)}; this adapter speaks version ${ACP_PROTOCOL_VERSION} only.`, 'unavailable');
      this.agent = { info: answer.agentInfo || null, capabilities: answer.agentCapabilities || {}, authMethods: Array.isArray(answer.authMethods) ? answer.authMethods : [] };
      if (this.authMethodId) {
        const method = this.agent.authMethods.find(m => m?.id === this.authMethodId);
        if (!method || method.type === 'terminal') throw this.authError(`The sign-in method "${this.authMethodId}" is not one this adapter can use with this agent.`);
        await rpc.call('authenticate', { methodId: this.authMethodId }, this.startTimeout).catch(error => { throw this.authError(`The agent did not accept the sign-in method "${this.authMethodId}" (${detail(error)}).`); });
      }
      return this.agent;
    })().catch(error => {
      if (this.rpc === rpc) { this.rpc = null; this.ready = null; this.agent = null; }
      rpc?.close();
      throw error instanceof ProviderError ? error : new ProviderError(`The agent could not start: ${error.message}`, 'unavailable');
    });
    return this.ready;
  }

  // An error with code 'auth' that names what the agent offered. Signing in is a person's to do.
  authError(lead = 'The agent needs signing in before it can be used.') {
    const offered = (this.agent?.authMethods || []).filter(m => typeof m?.id === 'string').map(m => `${m.id}${m.type && m.type !== 'agent' ? ` (${m.type})` : ''}`);
    const error = new ProviderError(`${lead} ${offered.length ? `It offers these sign-in methods: ${offered.join(', ')}.` : 'It named no sign-in method.'} Sign in with the agent's own program, then try again.`, 'auth');
    error.authMethods = offered;
    return error;
  }

  /**
   * Runs one request in the session for `key`, creating or loading the session on first use.
   * Extras beyond the common request:
   * @param {object} request
   * @param {string} [request.cwd] the session's folder (absolute); default workDir. Applies when the session starts.
   * @param {string} [request.sessionId] a session id saved from an earlier `provenance.sessionId`. Used when this
   *   provider has no session for the key and the agent can load or resume one; if that fails, a new session starts
   *   and `provenance.session` says 'new'.
   * @param {object[]} [request.mcpServers] MCP servers for this key's session, instead of the provider's
   * @param {string[]} [request.additionalDirectories] more session roots, sent when the agent advertises support
   * @param {(diff: object) => void} [request.onDiff] called with each `diff` an agent attaches to a tool call:
   *   { id, toolCallId, index, path, oldText, newText, status, title, toolKind, key, sessionId }. `status` is ACP's
   *   ('pending', 'in_progress', 'completed', 'failed'); the same id is reported again when its text or status changes.
   * @param {(ask: object, context: {signal: AbortSignal}) => any} [request.onAsk] answers a permission request in the
   *   provider-neutral shape ("Asks" in ./contract.mjs): kind 'permission', the agent's own options (their ids are the
   *   agent's optionIds, each with its ACP `kind`). It is asked after `onPermission` when that hook leaves the request
   *   undecided, and before the `permission` policy. The answer is one of the option ids, or 'accept' (the first
   *   allow_once option), 'acceptForSession' (the first allow_always), 'decline' or 'cancel'.
   * @param {(update: object) => void} [request.onUpdate] every raw `session/update` payload of the turn, unmapped
   * @param {number} [request.idleTimeout] stop the run when the agent sends nothing for this long; 0 is no limit.
   *   The clock is paused while a hook (a permission question, a file read) is being answered.
   * `instructions` go in `systemPrompt` when the agent advertises it, and otherwise at the head of the first
   * prompt of a new session. `onText(piece, { segment })` receives agent text as it arrives; `segment` counts the
   * agent's messages within the turn, so a host showing a preview can tell when a new one begins.
   */
  run({ key, input, instructions, cwd, sessionId, mcpServers, additionalDirectories, onEvent, onText, onDiff, onUpdate, onAsk, signal, timeout = 900000, idleTimeout = this.idleTimeout } = {}) {
    try {
      if (typeof key !== 'string' || !key) throw new ProviderError('Give the run a conversation key.', 'config');
      const parts = inputParts(input);
      if (!parts.length) throw new ProviderError('Give the run some input.', 'config');
      if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) throw new ProviderError('The session folder (cwd) must be an absolute path.', 'config');
      if (signal?.aborted) throw new ProviderError('Stopped.', 'stopped');
      if (this.runs.has(key)) throw new ProviderError('That conversation already has a request running.', 'busy');
      return new Promise((resolve, reject) => {
        const abort = () => this.cancel(key);
        const run = { key, parts, instructions, cwd, savedId: sessionId, mcpServers, additionalDirectories, onEvent, onText, onDiff, onUpdate, onAsk: typeof onAsk === 'function' ? onAsk : null, idleTimeout,
          phase: 'setup', sessionId: null, how: null, cancelled: false, over: false, waiting: 0, asking: new Set(), tools: new Map(),
          text: '', all: '', segment: 0, messageId: null, boundary: false, thought: null, thoughts: 0, notes: 0, context: null,
          finish: (error, result) => {
            if (run.over) return;
            run.over = true;
            clearTimeout(run.timer); clearTimeout(run.idle); clearTimeout(run.grace); signal?.removeEventListener('abort', abort);
            for (const stop of [...run.asking]) stop();
            if (this.runs.get(key) === run) this.runs.delete(key);
            error ? reject(error) : resolve(result);
          } };
        this.runs.set(key, run);
        run.timer = setTimeout(() => this.expire(run, 'The request ran out of time and was stopped.'), timeout);
        signal?.addEventListener('abort', abort, { once: true });
        this.drive(run).catch(error => run.finish(error instanceof ProviderError ? error : new ProviderError(detail(error), 'failed')));
      });
    } catch (error) { return Promise.reject(error); }
  }

  async drive(run) {
    await this.start();
    const rpc = this.rpc;
    if (!rpc) throw new ProviderError('The agent connection stopped.', 'unavailable');
    const session = await this.session(rpc, run);
    if (run.over) return;
    run.sessionId = session.sessionId; run.phase = 'prompt';
    const prompt = run.parts.map(text => ({ type: 'text', text }));
    if (session.first) { prompt.unshift({ type: 'text', text: session.first }); session.first = null; }
    this.arm(run);
    let result;
    try { result = await rpc.call('session/prompt', { sessionId: session.sessionId, prompt }); }
    catch (error) {
      if (run.over) return;
      if (run.cancelled) return run.finish(new ProviderError('Stopped.', 'stopped'));
      if (error instanceof RpcError) return run.finish(error.code === AUTH_REQUIRED ? this.authError() : new ProviderError(detail(error), 'failed'));
      return run.finish(new ProviderError('The agent connection stopped.', 'unavailable'));
    }
    if (run.over) return;
    this.settleThought(run);
    const stop = result?.stopReason;
    if (stop === 'cancelled') return run.finish(new ProviderError('Stopped.', 'stopped'));
    if (stop === 'refusal') return run.finish(new ProviderError('The agent declined the request.', 'failed'));
    const info = this.agent?.info || {};
    const counts = result?.usage && typeof result.usage === 'object' ? Object.fromEntries(Object.entries(result.usage).filter(([, n]) => typeof n === 'number')) : {};
    const usage = { ...counts, ...(run.context ? { contextTokens: run.context.used, contextSize: run.context.size, ...(run.context.cost ? { cost: run.context.cost } : {}) } : {}) };
    run.finish(null, { message: this.reply === 'all' ? run.all : run.text,
      provenance: { provider: this.name, agent: info.name || path.basename(this.command[0]), ...(info.version ? { agentVersion: info.version } : {}),
        model: session.model || 'agent default', sessionId: session.sessionId, session: run.how, protocolVersion: ACP_PROTOCOL_VERSION, stopReason: stop || 'end_turn' },
      ...(Object.keys(usage).length ? { usage } : {}) });
  }

  // The session for a run's key: the live one, or a saved one loaded or resumed, or a new one.
  async session(rpc, run) {
    const live = this.sessions.get(run.key);
    if (live) { run.how = 'kept'; return live; }
    const caps = this.agent.capabilities, can = caps.sessionCapabilities || {};
    const cwd = run.cwd || this.workDir, servers = this.checkServers(run.mcpServers ?? this.mcpServers, caps.mcpCapabilities || {});
    const more = (run.additionalDirectories || []).filter(dir => typeof dir === 'string' && path.isAbsolute(dir));
    const system = run.instructions && can.systemPrompt ? { systemPrompt: { mode: 'append', content: [{ type: 'text', text: run.instructions }] } } : {};
    const params = { cwd, mcpServers: servers, ...(more.length && can.additionalDirectories ? { additionalDirectories: more } : {}), ...system };
    const model = answer => answer?.models?.currentModelId || (answer?.configOptions || []).find(option => option?.category === 'model')?.currentValue || null;
    const keep = (sessionId, answer, first) => {
      const session = { sessionId, cwd, model: model(answer), roots: [cwd, ...(params.additionalDirectories || [])].map(dir => path.resolve(dir)), first };
      // A run stopped or timed out while its session was being set up does not keep it.
      if (this.rpc === rpc && (!run.over || run.cancelled)) { this.sessions.set(run.key, session); this.known.set(run.key, sessionId); this.keys.set(sessionId, run.key); }
      else this.keys.delete(sessionId);
      return session;
    };
    const saved = run.savedId || this.known.get(run.key);
    if (typeof saved === 'string' && saved && (can.resume || caps.loadSession)) {
      // session/load replays the conversation as session/update notifications before it
      // answers. They are routed to this run while its phase is 'setup', and dropped.
      this.keys.set(saved, run.key);
      try {
        const answer = await rpc.call(can.resume ? 'session/resume' : 'session/load', { sessionId: saved, ...params }, this.sessionTimeout);
        run.how = can.resume ? 'resumed' : 'loaded';
        return keep(saved, answer, null);
      } catch (error) {
        this.keys.delete(saved);
        if (this.rpc !== rpc) throw new ProviderError('The agent connection stopped.', 'unavailable');
        if (error instanceof RpcError && error.code === AUTH_REQUIRED) throw this.authError();
        // Anything else (the session is unknown, or its file is gone): start again, and say so in provenance.
      }
    }
    let answer;
    try { answer = await rpc.call('session/new', params, this.sessionTimeout); }
    catch (error) {
      if (this.rpc !== rpc) throw new ProviderError('The agent connection stopped.', 'unavailable');
      if (error instanceof RpcError && error.code === AUTH_REQUIRED) throw this.authError();
      throw new ProviderError(`The agent could not start a session: ${detail(error)}`, error instanceof RpcError ? 'failed' : 'unavailable');
    }
    if (typeof answer?.sessionId !== 'string' || !answer.sessionId) throw new ProviderError('The agent started a session without naming it.', 'failed');
    run.how = 'new';
    return keep(answer.sessionId, answer, run.instructions && !can.systemPrompt ? run.instructions : null);
  }

  // MCP servers in ACP's shape. stdio is always allowed; http and sse only when the agent advertises them.
  checkServers(servers, can) {
    if (!Array.isArray(servers)) throw new ProviderError('mcpServers is a list.', 'config');
    return servers.map(server => {
      if (!server || typeof server.name !== 'string' || !server.name) throw new ProviderError('Each MCP server needs a name.', 'config');
      if (server.type === 'http' || server.type === 'sse') {
        if (!can[server.type]) throw new ProviderError(`This agent does not connect to MCP servers over ${server.type} (server "${server.name}").`, 'config');
        if (typeof server.url !== 'string') throw new ProviderError(`MCP server "${server.name}" needs a url.`, 'config');
        return { ...server, headers: server.headers || [] };
      }
      if (typeof server.command !== 'string' || !path.isAbsolute(server.command)) throw new ProviderError(`MCP server "${server.name}" needs its command as an absolute path.`, 'config');
      return { ...server, args: server.args || [], env: server.env || [] };
    });
  }

  // The idle clock: restarted by each message about this run's session, paused while the agent waits on us.
  arm(run) {
    clearTimeout(run.idle);
    if (run.over || run.phase !== 'prompt' || !(run.idleTimeout > 0) || run.waiting > 0) return;
    run.idle = setTimeout(() => this.expire(run, `The agent sent nothing for ${Math.round(run.idleTimeout / 100) / 10} seconds and was stopped.`), run.idleTimeout);
  }

  // A run out of time: the agent is told to stop, and the session is dropped so the next run starts clean.
  expire(run, message) {
    if (run.over) return;
    if (run.phase === 'prompt' && run.sessionId) this.rpc?.notify('session/cancel', { sessionId: run.sessionId });
    run.finish(new ProviderError(message, 'timeout'));
    this.reset(run.key);
  }

  /** Asks the agent to stop the run for `key`. The run then rejects with code 'stopped'. */
  cancel(key) {
    const run = this.runs.get(key); if (!run || run.over) return false;
    if (run.cancelled) return true;
    run.cancelled = true;
    for (const stop of [...run.asking]) stop();   // the protocol: pending permission requests are answered 'cancelled'
    if (run.phase !== 'prompt') { run.finish(new ProviderError('Stopped.', 'stopped')); return true; }
    this.rpc?.notify('session/cancel', { sessionId: run.sessionId });
    // The agent confirms by ending the prompt with stopReason 'cancelled'. One that never does loses its session.
    run.grace = setTimeout(() => { run.finish(new ProviderError('Stopped.', 'stopped')); this.reset(key); }, this.cancelGrace);
    return true;
  }

  emit(run, event) { try { run.onEvent?.(event); } catch { /* a host's handler must not break the run */ } }
  settleThought(run) { if (run.thought) { this.emit(run, { id: run.thought, kind: 'reasoning', status: 'done' }); run.thought = null; } }

  // session/update notifications, turned into text, ActivityEvents and diffs.
  notified({ method, params }) {
    if (method !== 'session/update' || !params || typeof params !== 'object') return;
    const run = this.runs.get(this.keys.get(params.sessionId));
    if (!run || run.over || run.phase !== 'prompt' || run.sessionId !== params.sessionId) return;
    this.arm(run);
    const update = params.update || {};
    try { run.onUpdate?.(update); } catch { /* as above */ }
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = textOf(update.content); if (!text) return;
        this.settleThought(run);
        const id = present(update.messageId) ? String(update.messageId) : null;
        if (run.text && (run.boundary || (id !== null && run.messageId !== null && id !== run.messageId))) {
          // A new message after a tool call or under a new message id: the earlier one was a note along the way.
          if (this.reply !== 'all') this.emit(run, { id: `note-${++run.notes}`, kind: 'activity', title: 'Agent note', text: run.text, status: 'done' });
          run.text = ''; run.all += '\n\n'; run.segment++;
        }
        run.boundary = false; run.messageId = id; run.text += text; run.all += text;
        try { run.onText?.(text, { segment: run.segment }); } catch { /* as above */ }
        return;
      }
      case 'agent_thought_chunk': {
        const text = textOf(update.content); if (!text) return;
        run.thought ||= `thought-${++run.thoughts}`;
        return this.emit(run, { id: run.thought, kind: 'reasoning', append: text, status: 'running' });
      }
      case 'tool_call': case 'tool_call_update': return this.tool(run, update);
      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        return this.emit(run, { id: 'plan', kind: 'activity', title: 'Plan', text: entries.map(entry => `${PLAN_MARKS[entry?.status] || '[ ]'} ${entry?.content ?? ''}`).join('\n'),
          status: entries.length && entries.every(entry => entry?.status === 'completed') ? 'done' : 'running' });
      }
      case 'usage_update':
        if (typeof update.used === 'number' && typeof update.size === 'number') run.context = { used: update.used, size: update.size, cost: update.cost || null };
    }
  }

  // One tool call as it changes. An update carries only the fields that changed, so the call is kept whole here.
  tool(run, update) {
    if (!present(update.toolCallId)) return null;
    const id = String(update.toolCallId);
    let call = run.tools.get(id);
    if (!call) {
      call = { toolCallId: id, title: '', kind: 'other', status: 'pending', content: [], locations: [], sent: new Map() };
      run.tools.set(id, call); run.boundary = true; this.settleThought(run);
    }
    for (const field of ['title', 'kind', 'status', 'name', 'rawInput', 'rawOutput']) if (present(update[field])) call[field] = update[field];
    for (const field of ['content', 'locations']) if (Array.isArray(update[field])) call[field] = update[field];
    const diffs = call.content.filter(item => item?.type === 'diff' && typeof item.path === 'string' && typeof item.newText === 'string');
    const paths = [...new Set([...call.locations.map(place => place?.path), ...diffs.map(diff => diff.path)].filter(p => typeof p === 'string'))];
    const said = call.content.filter(item => item?.type === 'content').map(item => textOf(item.content)).filter(Boolean).join('\n');
    const command = call.kind === 'execute' ? call.rawInput?.command : undefined;
    this.emit(run, { id, kind: 'activity', status: STATUS[call.status] || 'running', title: call.title || TITLES[call.kind] || TITLES.other, toolKind: call.kind,
      ...(typeof command === 'string' || Array.isArray(command) ? { command: Array.isArray(command) ? command.join(' ') : command } : {}),
      ...(paths.length ? { paths } : {}), ...(Array.isArray(update.content) && said ? { text: said } : {}) });
    diffs.forEach((diff, index) => {
      const oldText = typeof diff.oldText === 'string' ? diff.oldText : null, mark = JSON.stringify([diff.path, oldText, diff.newText, call.status]);
      if (call.sent.get(index) === mark) return;
      call.sent.set(index, mark);
      try { run.onDiff?.({ id: `${id}:${index}`, toolCallId: id, index, path: diff.path, oldText, newText: diff.newText, status: call.status, title: call.title, toolKind: call.kind, key: run.key, sessionId: run.sessionId }); }
      catch { /* as above */ }
    });
    return call;
  }

  // Requests the agent makes of the client. Each is answered, with a result or an error; none is left hanging.
  requested(rpc, { id, method, params }) {
    const p = params && typeof params === 'object' ? params : {};
    const key = this.keys.get(p.sessionId), run = key === undefined ? undefined : this.runs.get(key);
    const live = run && !run.over && run.sessionId === p.sessionId ? run : null;
    const context = { key, sessionId: p.sessionId };
    const answer = async () => {
      if (key === undefined) throw refusal(NOT_FOUND, 'That session is not one this client holds.');
      if (method === 'session/request_permission') return this.permit(live, p, context);
      if (method === 'fs/read_text_file') {
        if (!this.clientCapabilities.fs.readTextFile) throw refusal(NO_METHOD, 'This client does not serve file reads.');
        return { content: await this.read(p, context) };
      }
      if (method === 'fs/write_text_file') {
        if (!this.writeHook) throw refusal(NO_METHOD, 'This client does not accept file writes.');
        if (typeof p.path !== 'string' || !path.isAbsolute(p.path) || typeof p.content !== 'string') throw refusal(BAD_PARAMS, 'A write needs an absolute path and its content.');
        await this.writeHook(p.path, p.content, context);
        return {};
      }
      if (TERMINAL[method]) {
        if (!this.terminals) throw refusal(NO_METHOD, 'This client does not offer terminals.');
        return (await this.terminals[TERMINAL[method]](p, context)) ?? {};
      }
      throw refusal(NO_METHOD, `Method not found: ${method}`);
    };
    if (live) { live.waiting++; clearTimeout(live.idle); }
    answer().then(result => rpc.reply(id, result), error => rpc.refuse(id, Number.isInteger(error?.rpcCode) ? error.rpcCode : INTERNAL, String(error?.message || 'Refused.').slice(0, 2000)))
      .finally(() => { if (live) { live.waiting--; this.arm(live); } });
  }

  // fs/read_text_file: the host's hook first, then the default reader, which reads only inside `roots`.
  async read(p, context) {
    if (typeof p.path !== 'string' || !path.isAbsolute(p.path)) throw refusal(BAD_PARAMS, 'A read needs an absolute path.');
    let content = this.readHook ? await this.readHook(p.path, { ...context, line: p.line ?? null, limit: p.limit ?? null }) : undefined;
    if (typeof content !== 'string') {
      // Checked twice: as written, so nothing outside the roots is even looked for, and
      // again after links are resolved, so a link inside a root cannot lead out of it.
      const target = path.resolve(p.path), outside = refusal(REFUSED, 'That file is outside the folders this agent may read through the client.');
      if (!this.roots.some(root => inside(root, target))) throw outside;
      const real = await realpath(target).catch(() => { throw refusal(NOT_FOUND, 'There is no such file.'); });
      const roots = (await Promise.all(this.roots.map(root => realpath(root).catch(() => null)))).filter(Boolean);
      if (!roots.some(root => inside(root, real))) throw outside;
      content = await readDisk(real, 'utf8').catch(() => { throw refusal(NOT_FOUND, 'That file could not be read.'); });
    }
    return sliceLines(content, p.line, p.limit);
  }

  // session/request_permission: the host's hook, then the policy. A stopped turn answers 'cancelled'.
  async permit(run, p, context) {
    if (!run || run.cancelled || run.phase !== 'prompt') return CANCELLED;
    const call = (p.toolCall && this.tool(run, p.toolCall)) || { toolCallId: null, title: '', kind: 'other', status: 'pending', content: [], locations: [] };
    const options = (Array.isArray(p.options) ? p.options : []).filter(option => option && typeof option.optionId === 'string');
    const first = kind => options.find(option => option.kind === kind);
    const select = option => option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : null;
    const reject = () => select(first('reject_once') || first('reject_always')) || CANCELLED;
    const { sent, ...toolCall } = call;
    const request = { ...context, toolCall, options, diffs: call.content.filter(item => item?.type === 'diff') };
    let choice;
    // Asks one hook, giving up the moment the turn is stopped.
    const consult = async hook => {
      const controller = new AbortController();
      let stop;
      const stopped = new Promise(resolve => { stop = () => { controller.abort(); resolve('cancelled'); }; });
      run.asking.add(stop);
      try { return await Promise.race([Promise.resolve().then(() => hook({ signal: controller.signal })), stopped]); }
      catch { return 'reject_once'; }
      finally { run.asking.delete(stop); }
    };
    if (this.onPermission) choice = await consult(context => this.onPermission(request, context));
    if (!present(choice) && run.onAsk && !run.over && !run.cancelled) {
      // The same question in the shape every provider uses, so one panel can show an ACP agent's and a Codex agent's alike.
      const places = [...new Set([...call.locations.map(place => place?.path), ...request.diffs.map(diff => diff.path)].filter(p => typeof p === 'string'))];
      const ask = { id: `ask-${present(call.toolCallId) ? call.toolCallId : ++run.notes}`, provider: this.name, method: 'session/request_permission', kind: 'permission',
        title: call.title || TITLES[call.kind] || TITLES.other, detail: { toolKind: call.kind, ...(places.length ? { paths: places } : {}), ...(request.diffs.length ? { diffs: request.diffs.length } : {}) },
        options: options.map(option => ({ id: option.optionId, label: typeof option.name === 'string' ? option.name : option.optionId, kind: option.kind })) };
      const given = await consult(context => run.onAsk(ask, context));
      // No answer at all leaves the request to the `permission` policy, as with onPermission.
      if (present(given)) { const answer = chosenOption(given); choice = { accept: 'allow_once', acceptForSession: 'allow_always', decline: 'reject_once', cancel: 'cancelled', cancelled: 'cancelled' }[answer] || answer; }
    }
    if (run.over || run.cancelled || choice === 'cancelled') return CANCELLED;
    if (!present(choice)) {
      const places = call.locations.map(place => place?.path).filter(p => typeof p === 'string');
      const roots = [...(this.sessions.get(run.key)?.roots || []), ...this.roots];
      const readOnly = ['read', 'search'].includes(call.kind) && places.every(place => path.isAbsolute(place) && roots.some(root => inside(root, path.resolve(place))));
      choice = this.permission === 'allow-read' && readOnly ? 'allow_once' : 'reject_once';
    }
    const chosen = options.find(option => option.optionId === choice);
    if (chosen) return select(chosen);
    // A kind picks the first option of exactly that kind: "once" is never widened to "always".
    return (OPTION_KINDS.includes(choice) && select(first(choice))) || reject();
  }

  /** Forgets the session for `key`: the next run on it starts a fresh one. The agent is told to close it where it can. */
  reset(key) {
    const session = this.sessions.get(key);
    this.sessions.delete(key); this.known.delete(key);
    if (!session) return;
    this.keys.delete(session.sessionId);
    if (this.rpc && this.agent?.capabilities?.sessionCapabilities?.close) this.rpc.call('session/close', { sessionId: session.sessionId }, 10000).catch(() => {});
  }

  close() {
    const rpc = this.rpc; this.rpc = null; this.ready = null; this.agent = null;
    for (const run of [...this.runs.values()]) run.finish(new ProviderError('The agent connection was closed.', 'unavailable'));
    this.runs.clear(); this.sessions.clear(); this.known.clear(); this.keys.clear();
    rpc?.close();
  }
}
