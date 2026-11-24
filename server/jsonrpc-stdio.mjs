// A JSON-RPC 2.0 connection to a child process over stdio: one JSON message per line,
// in both directions. It is the transport of the Agent Client Protocol
// (https://agentclientprotocol.com/protocol/v1/transports: "Messages are delimited by
// newlines and MUST NOT contain embedded newlines").
//
// It sits beside codex-rpc.mjs instead of changing it, because it differs in four ways
// that existing callers of that transport would notice: every message carries
// `"jsonrpc": "2.0"`; an error reply keeps its `code` and `data` (RpcError); a request
// from the child can be refused with an error object; and a call has no timeout unless
// one is asked for (a prompt turn may run for a long time). A line that is not a JSON-RPC
// message is not fatal: it is skipped and reported on 'noise', since agents do sometimes
// print a banner or a log line on stdout.
//
// Events: 'request' (message), 'notification' (message), 'message' (any valid message,
// for an idle clock), 'noise' (line), 'exit' ({ code, signal, error }).
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

/** An error reply from the other side. `code` and `data` are the JSON-RPC error's. */
export class RpcError extends Error {
  constructor(message, code, data) { super(message); this.name = 'RpcError'; this.code = code; this.data = data; }
}

export class JsonRpcStdio extends EventEmitter {
  /**
   * @param {object} options
   * @param {string[]} options.command the program and its arguments; run without a shell
   * @param {string} [options.cwd]
   * @param {object} [options.env] default process.env
   * @param {number} [options.killAfter] milliseconds between closing stdin and killing the child; default 1500
   */
  constructor({ command, cwd, env = process.env, killAfter = 1500 }) {
    super(); Object.assign(this, { command, cwd, env, killAfter }); this.seq = 0; this.calls = new Map(); this.proc = null;
  }

  start() {
    if (this.proc) return this.proc;
    const [file, ...args] = this.command;
    const proc = this.proc = spawn(file, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    readline.createInterface({ input: proc.stdout }).on('line', line => {
      if (!line.trim()) return;
      let msg; try { msg = JSON.parse(line); } catch { msg = null; }
      const isObject = msg && typeof msg === 'object' && !Array.isArray(msg);
      const hasId = isObject && (typeof msg.id === 'string' || typeof msg.id === 'number');
      if (!isObject || (typeof msg.method !== 'string' && !hasId)) return void this.emit('noise', line);
      this.emit('message', msg);
      if (typeof msg.method !== 'string') {
        const call = this.calls.get(msg.id); if (!call) return;
        clearTimeout(call.timer); this.calls.delete(msg.id);
        if (msg.error) call.reject(new RpcError(String(msg.error.message || 'The agent reported an error.'), msg.error.code, msg.error.data));
        else call.resolve(msg.result);
        return;
      }
      this.emit(hasId ? 'request' : 'notification', msg);
    });
    let over = false;
    const ended = (error, code = null, signal = null) => {
      if (over) return; over = true;
      const reason = error || new Error('The agent connection stopped.');
      for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(reason); }
      this.calls.clear(); clearTimeout(this.killTimer);
      if (this.proc === proc) this.proc = null;
      this.emit('exit', { code, signal, error: error || null });
    };
    proc.on('error', error => ended(error));
    proc.on('exit', (code, signal) => ended(null, code, signal));
    proc.stdin.on('error', () => {});
    return proc;
  }

  /** Sends a request. Rejects with RpcError on an error reply; `timeout` 0 waits for as long as the child lives. */
  call(method, params, timeout = 0) {
    if (!this.proc) return Promise.reject(new Error('The agent connection is not running.'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => { this.calls.delete(id); reject(new Error(`Agent request timed out: ${method}`)); }, timeout) : null;
      this.calls.set(id, { resolve, reject, timer }); this.send({ id, method, params });
    });
  }
  send(message) { const proc = this.proc; if (proc?.stdin.writable) proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); }
  notify(method, params) { this.send({ method, params }); }
  reply(id, result) { this.send({ id, result: result ?? {} }); }
  refuse(id, code, message, data) { this.send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } }); }

  /** Closes the child's stdin, which is how the protocol ends a connection, and kills it if it stays. */
  close() {
    const proc = this.proc; if (!proc) return;
    proc.stdin.end();
    this.killTimer = setTimeout(() => proc.kill(), this.killAfter);
    this.killTimer.unref?.();
  }
}
