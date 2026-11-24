// A long-lived agent over the Codex app-server protocol (JSON-RPC on stdio): one child
// process, one thread per host key, activity streamed while it works. Generalised from
// the adapters Copycat (src/live.js) and Skein (src/agent-provider.js) each wrote.
//
// What the host decides, per run: the sandbox (read-only, or workspace-write with the
// folders it names), the instructions, the input. What this adapter always does:
// - approval requests are answered by `onApproval`, which declines by default, so the
//   sandbox is the boundary;
// - raw reasoning is never read or passed on, only the summaries the agent publishes;
// - with `disableUserExtensions` (the default) the MCP servers, plugins and apps in the
//   user's own Codex configuration are switched off for these threads.
import { mkdir } from 'node:fs/promises';
import { CodexRpc } from '../codex-rpc.mjs';
import { ProviderError, inputParts } from './contract.mjs';
import { SHORT_NAME } from '../package-info.mjs';

const ZERO = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
const said = text => ({ type: 'text', text, text_elements: [] });
const words = value => typeof value === 'string' ? value : '';
// A transport error as a host should see it.
const fromRpc = error => error instanceof ProviderError ? error
  : new ProviderError(String(error?.message || error).slice(0, 300), { closed: 'unavailable', timeout: 'timeout' }[error?.code] || 'failed');

/** A command as the agent ran it, without the shell wrapper Codex puts around it. */
export const commandLine = command => (Array.isArray(command) ? command.join(' ') : String(command || ''))
  .replace(/^\/\S*\/(?:ba|z)?sh -l?c /, '').replace(/^(['"])([\s\S]*)\1$/, '$2');

export class CodexAppServerProvider {
  name = 'codex-app-server';
  capabilities = { activity: true, textStream: false, sessions: true, cancel: true, shell: true, structuredOutput: true };

  /**
   * @param {object} options
   * @param {string[]} [options.command] the app-server command; default ['codex', 'app-server']
   * @param {string} options.workDir the child's working folder, created private if missing
   * @param {{name: string, title?: string, version?: string}} [options.clientInfo] how the host names itself
   * @param {string} [options.serviceName] defaults to clientInfo.name
   * @param {object} [options.env] the child's environment; default process.env
   * @param {string[]} [options.dropEnv] names removed from it; default ['OPENAI_API_KEY'], so the signed-in account is used
   * @param {boolean} [options.disableUserExtensions] default true
   * @param {object} [options.threadConfig] extra Codex config for every thread
   * @param {string} [options.model] default: the model the app-server lists as its default
   * @param {(request: object) => object|Promise<object>} [options.onApproval] answers an approval request; default declines.
   *   A callback that throws, rejects or returns nothing declines.
   * @param {(chunk: Buffer) => void} [options.onStderr]
   * @param {number} [options.stopGrace] milliseconds a stopped run waits for the agent to confirm before it is
   *   ended anyway and its thread forgotten; default 10000. Infinity waits for the run's own timeout.
   * @param {number} [options.killGrace] milliseconds close() waits after SIGTERM before SIGKILL; default 2000
   * @param {number} [options.maxLine] characters in one line from the child; longer lines are dropped. Default 64 MB
   * @param {boolean} [options.processGroup] stop what the child started along with it; see CodexRpc. Default false
   */
  constructor({ command = ['codex', 'app-server'], workDir, clientInfo = { name: SHORT_NAME }, serviceName, env = process.env,
    dropEnv = ['OPENAI_API_KEY'], disableUserExtensions = true, threadConfig = {}, model, onApproval, onStderr, stopGrace = 10000, killGrace = 2000, maxLine, processGroup = false } = {}) {
    if (!Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string' || !part || part.includes('\0')))
      throw new ProviderError('The app-server command must be a list of non-empty strings.', 'config');
    if (typeof workDir !== 'string' || !workDir) throw new ProviderError('Give the app-server a working folder (workDir).', 'config');
    Object.assign(this, { command, workDir, serviceName: serviceName || clientInfo.name, disableUserExtensions, threadConfig, fixedModel: model, onStderr, stopGrace, killGrace, maxLine, processGroup });
    this.clientInfo = { name: clientInfo.name, title: clientInfo.title || clientInfo.name, version: clientInfo.version || '0.0.0' };
    this.env = Object.fromEntries(Object.entries(env).filter(([name]) => !dropEnv.includes(name)));
    this.onApproval = onApproval || (() => ({ decision: 'decline' }));
    this.threads = new Map();   // host key -> Codex thread id
    this.pending = new Map();   // Codex thread id -> the run in flight
    this.starting = new Set();  // host keys whose run has not reached its turn yet
    this.totals = new Map();    // Codex thread id -> cumulative token usage
    this.ready = null;
  }

  /** Starts the child and reads its defaults. Safe to call often; run() calls it. */
  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await mkdir(this.workDir, { recursive: true, mode: 0o700 });
      const rpc = this.rpc = new CodexRpc({ command: this.command, cwd: this.workDir, env: this.env, killGrace: this.killGrace, processGroup: this.processGroup, ...(this.maxLine ? { maxLine: this.maxLine } : {}) });
      // What the child sends is data: a message in an unexpected form is skipped, never thrown.
      rpc.on('notification', message => { try { this.event(message); } catch { /* skipped */ } });
      rpc.on('request', message => {
        const decline = { decision: 'decline' };
        Promise.resolve().then(() => this.onApproval(message)).then(answer => answer && typeof answer === 'object' ? answer : decline, () => decline)
          .then(answer => rpc.reply(message.id, answer)).catch(() => {});
      });
      rpc.on('stderr', chunk => { try { this.onStderr?.(chunk); } catch { /* a host's handler must not break the child's output */ } });
      const child = rpc.start();
      const failed = () => {
        if (this.rpc !== rpc) return;
        for (const run of [...this.pending.values()]) run.finish(new ProviderError('The agent connection stopped.', 'unavailable'));
        this.pending.clear(); this.threads.clear(); this.totals.clear(); this.ready = null; this.rpc = null;
      };
      child.on('exit', failed); child.on('error', failed);
      await rpc.call('initialize', { clientInfo: this.clientInfo, capabilities: null });
      rpc.notify('initialized', {});
      this.disabled = {};
      if (this.disableUserExtensions) {
        // An empty table would merge with the user's config, so each configured server and
        // plugin is named and switched off.
        const settings = await rpc.call('config/read', { includeLayers: false }).catch(() => ({}));
        const off = table => Object.fromEntries(Object.keys(table || {}).map(name => [name, { enabled: false }]));
        this.disabled = { 'features.apps': false, apps: { _default: { enabled: false } },
          mcp_servers: off(settings?.config?.mcp_servers), plugins: off(settings?.config?.plugins) };
      }
      const models = this.fixedModel ? null : await rpc.call('model/list', {}).catch(() => null);
      this.model = this.fixedModel || models?.data?.find(m => m.isDefault)?.id;
    })();
    const ready = this.ready = this.ready.catch(error => {
      // Only the attempt that failed is cleaned up: a later start() may already be under way.
      if (this.ready === ready) { this.rpc?.close(); this.rpc = null; this.ready = null; }
      throw error instanceof ProviderError ? error : new ProviderError(`The agent could not start: ${error.message}`, 'unavailable');
    });
    return this.ready;
  }

  /**
   * Runs one request on the thread for `key`, starting the thread on first use.
   * Extras beyond the common request:
   * @param {object} request
   * @param {'low'|'medium'|'high'|string} [request.effort] reasoning effort; default 'low'
   * @param {{mode?: 'read-only'|'workspace-write', cwd?: string, writableRoots?: string[], network?: boolean}} [request.sandbox]
   *   default read-only in workDir. `instructions`, `sandbox.mode` and `threadConfig` apply
   *   when the thread starts; later runs on the same key keep them.
   * @param {object} [request.outputSchema] a JSON Schema for the final message
   * @param {object} [request.threadConfig] extra Codex config for this key's thread
   * @param {string} [request.model] a model for this run, instead of the provider's
   * @param {number} [request.idleTimeout] milliseconds without any word from the agent about this run after which
   *   it is stopped with code 'timeout', as when `timeout` passes. Default: none
   */
  async run({ key, instructions, input, effort = 'low', sandbox = {}, outputSchema, threadConfig, model: asked, onEvent = () => {}, signal, timeout = 900000, idleTimeout } = {}) {
    if (typeof key !== 'string' || !key) throw new ProviderError('Give the run a conversation key.', 'config');
    const parts = inputParts(input);
    if (!parts.length) throw new ProviderError('Give the run some input.', 'config');
    if (signal?.aborted) throw new ProviderError('Stopped.', 'stopped');
    if (this.starting.has(key) || [...this.pending.values()].some(run => run.key === key)) throw new ProviderError('That conversation already has a request running.', 'busy');
    // The key is taken from here on, so a second run cannot slip in while this one starts.
    this.starting.add(key);
    let halt;
    const halted = new Promise((_, reject) => { halt = () => reject(new ProviderError('Stopped.', 'stopped')); });
    halted.catch(() => {});
    signal?.addEventListener('abort', halt, { once: true });
    try {
      // Starting the child and the thread is given up at once on an abort; both carry on
      // behind it, so the next run finds them ready.
      const started = this.start(); started.catch(() => {});
      await Promise.race([started, halted]);
      const rpc = this.rpc;
      if (!rpc) throw new ProviderError('The agent connection was closed.', 'unavailable');
      const write = sandbox.mode === 'workspace-write';
      const cwd = sandbox.cwd || this.workDir;
      const policy = write
        ? { type: 'workspaceWrite', writableRoots: sandbox.writableRoots || [], networkAccess: !!sandbox.network, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
        : { type: 'readOnly', ...(sandbox.network ? { networkAccess: true } : {}) };
      const named = asked || this.model;
      const model = named ? { model: named } : {};
      let threadId = this.threads.get(key);
      if (!threadId) {
        const thread = rpc.call('thread/start', { cwd, approvalPolicy: 'never', sandbox: write ? 'workspace-write' : 'read-only',
          ...(instructions ? { developerInstructions: instructions } : {}), serviceName: this.serviceName,
          config: { ...this.disabled, ...this.threadConfig, ...threadConfig }, ...model }).then(response => {
          const id = response?.thread?.id;
          if (typeof id !== 'string' || !id) throw new ProviderError('The agent did not start a thread.', 'failed');
          if (this.rpc === rpc) this.threads.set(key, id);
          return id;
        }, error => { throw fromRpc(error); });
        thread.catch(() => {});
        threadId = await Promise.race([thread, halted]);
      }
      if (signal?.aborted) throw new ProviderError('Stopped.', 'stopped');
      if (this.rpc !== rpc) throw new ProviderError('The agent connection was closed.', 'unavailable');
      return this.turn({ rpc, key, threadId, cwd, parts, effort, policy, outputSchema, model, asked, onEvent, signal, timeout, idleTimeout });
    } finally { this.starting.delete(key); signal?.removeEventListener('abort', halt); }
  }

  // Starts the turn and returns the promise that settles when it ends. The run is in
  // `pending` before this returns, so the key stays taken without a gap.
  turn({ rpc, key, threadId, cwd, parts, effort, policy, outputSchema, model, asked, onEvent, signal, timeout, idleTimeout }) {
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel(key);
      const run = { key, threadId, model: asked, text: '', turnId: null, cancelled: false, onEvent, parts: new Set(), usageStart: this.totals.get(threadId) || ZERO,
        finish: (error, result) => {
          if (this.pending.get(threadId) !== run) return;
          clearTimeout(run.timer); clearTimeout(run.grace); clearTimeout(run.idle); signal?.removeEventListener('abort', abort); this.pending.delete(threadId);
          error ? reject(error) : resolve(result);
        } };
      run.timer = setTimeout(() => { this.cancel(key); this.threads.delete(key); run.finish(new ProviderError('The request ran out of time and was stopped.', 'timeout')); }, Math.min(Math.max(0, Number(timeout) || 0), 2 ** 31 - 1));
      const expire = () => { this.cancel(key); this.threads.delete(key); run.finish(new ProviderError('The agent went quiet and was stopped.', 'timeout')); };
      // Called for every notification about this run: the quiet period starts again.
      run.heard = () => { if (!(idleTimeout > 0)) return; clearTimeout(run.idle); run.idle = setTimeout(expire, Math.min(idleTimeout, 2 ** 31 - 1)); };
      run.heard();
      this.pending.set(threadId, run);
      signal?.addEventListener('abort', abort, { once: true });
      rpc.call('turn/start', { threadId, cwd, input: parts.map(said), effort, summary: 'auto', sandboxPolicy: policy,
        ...(outputSchema ? { outputSchema } : {}), ...model }).then(result => {
          run.turnId ||= result?.turn?.id;
          if (run.cancelled && run.turnId) this.interrupt(run);
        }, error => run.finish(fromRpc(error)));
    });
  }

  // Asked once per run: a cancel can arrive before the turn's id is known, and the id then
  // comes from two places (the reply to turn/start and the turn/started notification).
  interrupt(run) {
    if (run.interrupted || !run.turnId) return;
    run.interrupted = true;
    this.rpc?.call('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => {});
  }

  /** Asks the agent to stop the run for `key`. The run then rejects with code 'stopped'. */
  cancel(key) {
    const run = [...this.pending.values()].find(r => r.key === key); if (!run) return false;
    run.cancelled = true;
    if (run.turnId) this.interrupt(run);
    // An agent that never confirms the stop must not hold the run open. Its thread is in
    // an unknown state by then, so it is forgotten: the next run on this key starts afresh.
    if (!run.grace && Number.isFinite(this.stopGrace)) {
      run.grace = setTimeout(() => {
        if (this.pending.get(run.threadId) !== run) return;
        if (this.threads.get(key) === run.threadId) this.reset(key);
        run.finish(new ProviderError('Stopped.', 'stopped'));
      }, Math.max(0, this.stopGrace));
      run.grace.unref?.();
    }
    return true;
  }

  // Turns app-server notifications into ActivityEvents and settles the run.
  event(message) {
    const method = message?.method, p = message?.params && typeof message.params === 'object' ? message.params : {};
    const threadId = p.threadId || p.turn?.threadId;
    if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.total && typeof p.tokenUsage.total === 'object') this.totals.set(threadId, p.tokenUsage.total);
    const run = this.pending.get(threadId); if (!run) return;
    run.heard?.();
    const emit = event => { try { run.onEvent(event); } catch { /* a host's handler must not break the run */ } };
    const item = p.item && typeof p.item === 'object' ? p.item : {};
    if (method === 'turn/started') {
      run.turnId = p.turn?.id || run.turnId;
      if (run.cancelled && run.turnId) this.interrupt(run);
    }
    if (method === 'item/reasoning/summaryTextDelta') {
      const part = `${p.itemId}:${p.summaryIndex}`;
      emit({ id: p.itemId, kind: 'reasoning', append: (p.summaryIndex > 0 && !run.parts.has(part) ? '\n' : '') + words(p.delta), status: 'running' });
      run.parts.add(part);
    }
    if (method === 'item/started' || method === 'item/completed') {
      const done = method === 'item/completed';
      const status = !done ? 'running' : item.status === 'failed' || (item.exitCode ?? 0) !== 0 ? 'failed' : 'done';
      if (item.type === 'reasoning') emit({ id: item.id, kind: 'reasoning', status: status === 'failed' ? 'done' : status,
        ...(Array.isArray(item.summary) && item.summary.length ? { text: item.summary.map(s => typeof s === 'string' ? s : words(s?.text)).filter(Boolean).join('\n') } : {}) });
      else if (item.type === 'agentMessage' && done) {
        // A message marked as commentary, and every message but the last, is a note along
        // the way; the last one is the reply.
        if (item.phase === 'commentary') emit({ id: item.id, kind: 'activity', title: 'Agent note', text: words(item.text), status: 'done' });
        else {
          if (run.text) emit({ id: `${item.id}-note`, kind: 'activity', title: 'Agent note', text: run.text, status: 'done' });
          run.text = words(item.text);
        }
      } else if (item.type === 'commandExecution') emit({ id: item.id, kind: 'activity', command: commandLine(Array.isArray(item.command) ? item.command.map(String) : words(item.command)), status,
        ...(done ? { output: words(item.aggregatedOutput).slice(-1500) } : {}) });
      else if (item.type === 'fileChange') emit({ id: item.id, kind: 'activity', paths: (Array.isArray(item.changes) ? item.changes : []).map(c => c?.path).filter(path => typeof path === 'string'), status });
      else if (item.type === 'webSearch') emit({ id: item.id, kind: 'activity', title: 'Searching the web', text: words(item.query), status });
      else if (item.type === 'plan') emit({ id: item.id, kind: 'activity', title: 'Plan', text: words(item.text), status });
      else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') emit({ id: item.id, kind: 'activity', title: 'Using a tool',
        text: [item.server, item.tool].filter(part => typeof part === 'string' && part).join(' · '), status });
    }
    if (method === 'error' && !p.willRetry) run.finish(new ProviderError(p.error?.message || 'The agent could not complete the request.', 'failed'));
    if (method === 'turn/completed') {
      if (p.turn?.status !== 'completed') return run.finish(p.turn?.status === 'interrupted'
        ? new ProviderError('Stopped.', 'stopped') : new ProviderError(p.turn?.error?.message || 'The request stopped.', 'failed'));
      const total = this.totals.get(threadId);
      const usage = total ? Object.fromEntries(Object.keys(ZERO).map(name => [name, Math.max(0, (Number(total[name]) || 0) - (Number(run.usageStart[name]) || 0))])) : undefined;
      run.finish(null, { message: run.text, provenance: { provider: this.name, model: run.model || this.model || 'provider default', threadId }, ...(usage ? { usage } : {}) });
    }
  }

  /** Forgets the thread for `key`: the next run on it starts a fresh agent. */
  reset(key) { const threadId = this.threads.get(key); this.threads.delete(key); if (threadId) this.totals.delete(threadId); }
  close() {
    const rpc = this.rpc; this.rpc = null; this.ready = null;
    for (const run of [...this.pending.values()]) run.finish(new ProviderError('The agent connection was closed.', 'unavailable'));
    this.pending.clear(); this.threads.clear(); this.totals.clear();
    rpc?.close();
  }
}
