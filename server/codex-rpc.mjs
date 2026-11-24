import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { track, terminate } from './children.mjs';

/**
 * An error from the transport. `code` is stable:
 *   'closed'   the child is not running, or stopped before it answered
 *   'timeout'  no answer within the call's time limit
 *   'rpc'      the child answered with an error (`rpcCode` is its own code, when it sent one)
 *   'invalid'  the request could not be turned into JSON
 */
export class RpcError extends Error {
  constructor(message, code, extra) { super(message); this.name = 'RpcError'; this.code = code; Object.assign(this, extra); }
}

/**
 * Splits a byte stream into lines, however the bytes arrive: a line may span any number
 * of chunks and a multi-byte character may be cut anywhere. Blank lines are skipped and
 * a trailing carriage return is removed. A line longer than `maxLine` characters is
 * dropped, without being held in memory, and reported to `onOversize`.
 * @returns {{push: (chunk: Buffer|string) => void, end: () => void}}
 */
export function createLineReader(onLine, { maxLine = 64 << 20, onOversize = () => {} } = {}) {
  const decoder = new StringDecoder('utf8');
  let held = [], size = 0, skipping = false;
  const emit = line => {
    if (line.length > maxLine) return onOversize(line.length);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line) onLine(line);
  };
  const feed = text => {
    let from = 0, at;
    while ((at = text.indexOf('\n', from)) >= 0) {
      const piece = text.slice(from, at); from = at + 1;
      if (skipping) { skipping = false; continue; }
      if (size) { held.push(piece); const line = held.join(''); held = []; size = 0; emit(line); } else emit(piece);
    }
    if (from >= text.length || skipping) return;
    const rest = from ? text.slice(from) : text;
    size += rest.length;
    if (size > maxLine) { skipping = true; held = []; onOversize(size); size = 0; } else held.push(rest);
  };
  return {
    push: chunk => feed(typeof chunk === 'string' ? chunk : decoder.write(chunk)),
    end() { feed(decoder.end()); if (size && !skipping) { const line = held.join(''); held = []; size = 0; emit(line); } },
  };
}

// Shared stdio JSON-RPC transport. Each host supplies its thread policies and
// event adapter; no document paths, permissions or agent instructions live here.
//
// Events: 'notification' and 'request' (messages from the child), 'stderr' (chunks of the
// child's stderr, which is always drained so the child cannot block on it), 'oversize'
// (a line over `maxLine` was dropped), 'unparsed' (a line that was not a JSON object, with
// its text: a child printing a warning on stdout, say) and 'fault' (a listener threw; the
// reader carries on).
export class CodexRpc extends EventEmitter {
  /**
   * @param {object} options
   * @param {string[]} [options.command] default ['codex', 'app-server']
   * @param {string} [options.cwd]
   * @param {object} [options.env] default process.env
   * @param {number} [options.maxLine] characters in one line from the child; longer lines are dropped. Default 64 MB
   * @param {number} [options.killGrace] milliseconds close() waits after SIGTERM before SIGKILL; default 2000
   * @param {boolean} [options.processGroup] start the child in a process group of its own and signal the whole
   *   group on close(), so that what the child started stops with it. Default false, because such a child no
   *   longer receives a Ctrl-C typed at the host's terminal: only close() and a normal exit of the host stop it.
   */
  constructor({ command = ['codex', 'app-server'], cwd, env = process.env, maxLine = 64 << 20, killGrace = 2000, processGroup = false }) {
    super(); this.command = command; this.cwd = cwd; this.env = env; this.maxLine = maxLine; this.killGrace = killGrace; this.processGroup = !!processGroup; this.seq = 0; this.calls = new Map();
  }
  start() {
    if (this.proc) return this.proc;
    const [file, ...args] = this.command;
    const proc = this.proc = track(spawn(file, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: this.processGroup }), { group: this.processGroup });
    const reader = createLineReader(line => this.dispatch(line), { maxLine: this.maxLine, onOversize: length => this.tell('oversize', length) });
    proc.stdout.on('data', reader.push);
    proc.stdout.on('end', reader.end);
    proc.stdout.on('error', () => {});
    proc.stderr.on('data', chunk => this.tell('stderr', chunk));
    proc.stderr.on('error', () => {});
    const failed = error => {
      if (this.proc === proc) this.proc = null;
      this.fail(proc, error);
    };
    proc.on('error', error => failed(new RpcError(String(error?.message || error), 'closed')));
    proc.on('exit', () => failed(new RpcError('The agent connection stopped.', 'closed')));
    proc.stdin.on('error', () => {});
    return proc;
  }
  // Rejects every call that was waiting on this child.
  fail(proc, error) {
    for (const [id, call] of this.calls) if (call.proc === proc) { clearTimeout(call.timer); this.calls.delete(id); call.reject(error); }
  }
  // Tells listeners, none of which may break the reader: what one throws is reported as a 'fault'.
  tell(name, value) {
    try { this.emit(name, value); }
    catch (error) { if (name !== 'fault') try { this.emit('fault', error); } catch { /* nothing more to do */ } }
  }
  /** Takes one line from the child. Anything that is not a JSON object is ignored. */
  dispatch(line) {
    let msg; try { msg = JSON.parse(line); } catch { return this.tell('unparsed', line); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return this.tell('unparsed', line);
    if (msg.id !== undefined && !msg.method) {
      const call = this.calls.get(msg.id); if (!call) return;
      clearTimeout(call.timer); this.calls.delete(msg.id);
      if (!msg.error) return call.resolve(msg.result);
      const detail = typeof msg.error === 'string' ? msg.error : msg.error?.message;
      return call.reject(new RpcError(typeof detail === 'string' && detail ? detail : 'The agent refused the request.', 'rpc', { rpcCode: msg.error?.code }));
    }
    this.tell(msg.id !== undefined ? 'request' : 'notification', msg);
  }
  call(method, params, timeout = 30000) {
    const proc = this.proc;
    if (!proc) return Promise.reject(new RpcError('The agent connection is not running.', 'closed'));
    const id = ++this.seq;
    let text;
    try { text = JSON.stringify({ method, id, params }) + '\n'; }
    catch (error) { return Promise.reject(new RpcError(`The request could not be sent: ${error.message}`, 'invalid')); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new RpcError(`Agent request timed out: ${method}`, 'timeout')); }, timeout);
      this.calls.set(id, { resolve, reject, timer, proc });
      this.write(text);
    });
  }
  write(text) { const stdin = this.proc?.stdin; if (stdin?.writable) stdin.write(text); }
  send(message) { this.write(JSON.stringify(message) + '\n'); }
  notify(method, params) { this.send({ method, params }); }
  reply(id, result) { this.send({ id, result }); }
  /** Stops the child: SIGTERM, then SIGKILL after `killGrace`. Calls still waiting are rejected with code 'closed'. */
  close() {
    const proc = this.proc; if (!proc) return;
    this.proc = null;
    this.fail(proc, new RpcError('The agent connection stopped.', 'closed'));
    terminate(proc, this.killGrace, { group: this.processGroup });
  }
}
