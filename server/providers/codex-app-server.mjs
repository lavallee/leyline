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

const ZERO = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
const said = text => ({ type: 'text', text, text_elements: [] });

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
   * @param {(request: object) => object} [options.onApproval] answers an approval request; default declines
   * @param {(chunk: Buffer) => void} [options.onStderr]
   */
  constructor({ command = ['codex', 'app-server'], workDir, clientInfo = { name: 'agent-chat' }, serviceName, env = process.env,
    dropEnv = ['OPENAI_API_KEY'], disableUserExtensions = true, threadConfig = {}, model, onApproval, onStderr } = {}) {
    if (!Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string' || !part || part.includes('\0')))
      throw new ProviderError('The app-server command must be a list of non-empty strings.', 'config');
    if (typeof workDir !== 'string' || !workDir) throw new ProviderError('Give the app-server a working folder (workDir).', 'config');
    Object.assign(this, { command, workDir, serviceName: serviceName || clientInfo.name, disableUserExtensions, threadConfig, fixedModel: model, onStderr });
    this.clientInfo = { name: clientInfo.name, title: clientInfo.title || clientInfo.name, version: clientInfo.version || '0.0.0' };
    this.env = Object.fromEntries(Object.entries(env).filter(([name]) => !dropEnv.includes(name)));
    this.onApproval = onApproval || (() => ({ decision: 'decline' }));
    this.threads = new Map();   // host key -> Codex thread id
    this.pending = new Map();   // Codex thread id -> the run in flight
    this.totals = new Map();    // Codex thread id -> cumulative token usage
    this.ready = null;
  }

  /** Starts the child and reads its defaults. Safe to call often; run() calls it. */
  start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      await mkdir(this.workDir, { recursive: true, mode: 0o700 });
      const rpc = this.rpc = new CodexRpc({ command: this.command, cwd: this.workDir, env: this.env });
      rpc.on('notification', message => this.event(message));
      rpc.on('request', message => {
        let answer; try { answer = this.onApproval(message); } catch { answer = null; }
        rpc.reply(message.id, answer || { decision: 'decline' });
      });
      const child = rpc.start();
      child.stderr.on('data', chunk => this.onStderr?.(chunk));
      const failed = () => {
        if (this.rpc !== rpc) return;
        for (const run of [...this.pending.values()]) run.finish(new ProviderError('The agent connection stopped.', 'unavailable'));
        this.pending.clear(); this.threads.clear(); this.totals.clear(); this.ready = null;
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
    })().catch(error => { this.rpc?.close(); this.ready = null; throw error instanceof ProviderError ? error : new ProviderError(`The agent could not start: ${error.message}`, 'unavailable'); });
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
   */
  async run({ key, instructions, input, effort = 'low', sandbox = {}, outputSchema, threadConfig, onEvent = () => {}, signal, timeout = 900000 } = {}) {
    if (typeof key !== 'string' || !key) throw new ProviderError('Give the run a conversation key.', 'config');
    const parts = inputParts(input);
    if (!parts.length) throw new ProviderError('Give the run some input.', 'config');
    if (signal?.aborted) throw new ProviderError('Stopped.', 'stopped');
    if ([...this.pending.values()].some(run => run.key === key)) throw new ProviderError('That conversation already has a request running.', 'busy');
    await this.start();
    const write = sandbox.mode === 'workspace-write';
    const cwd = sandbox.cwd || this.workDir;
    const policy = write
      ? { type: 'workspaceWrite', writableRoots: sandbox.writableRoots || [], networkAccess: !!sandbox.network, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : { type: 'readOnly', ...(sandbox.network ? { networkAccess: true } : {}) };
    const model = this.model ? { model: this.model } : {};
    let threadId = this.threads.get(key);
    if (!threadId) {
      const response = await this.rpc.call('thread/start', { cwd, approvalPolicy: 'never', sandbox: write ? 'workspace-write' : 'read-only',
        ...(instructions ? { developerInstructions: instructions } : {}), serviceName: this.serviceName,
        config: { ...this.disabled, ...this.threadConfig, ...threadConfig }, ...model });
      threadId = response.thread.id; this.threads.set(key, threadId);
    }
    if (signal?.aborted) throw new ProviderError('Stopped.', 'stopped');
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel(key);
      const run = { key, threadId, text: '', turnId: null, cancelled: false, onEvent, parts: new Set(), usageStart: this.totals.get(threadId) || ZERO,
        finish: (error, result) => {
          if (this.pending.get(threadId) !== run) return;
          clearTimeout(run.timer); signal?.removeEventListener('abort', abort); this.pending.delete(threadId);
          error ? reject(error) : resolve(result);
        } };
      run.timer = setTimeout(() => { this.cancel(key); this.threads.delete(key); run.finish(new ProviderError('The request ran out of time and was stopped.', 'timeout')); }, timeout);
      this.pending.set(threadId, run);
      signal?.addEventListener('abort', abort, { once: true });
      this.rpc.call('turn/start', { threadId, cwd, input: parts.map(said), effort, summary: 'auto', sandboxPolicy: policy,
        ...(outputSchema ? { outputSchema } : {}), ...model }).then(result => {
          run.turnId ||= result.turn?.id;
          if (run.cancelled && run.turnId) this.interrupt(run);
        }, error => run.finish(new ProviderError(error.message, 'failed')));
    });
  }

  interrupt(run) { this.rpc?.call('turn/interrupt', { threadId: run.threadId, turnId: run.turnId }).catch(() => {}); }

  /** Asks the agent to stop the run for `key`. The run then rejects with code 'stopped'. */
  cancel(key) {
    const run = [...this.pending.values()].find(r => r.key === key); if (!run) return false;
    run.cancelled = true;
    if (run.turnId) this.interrupt(run);
    return true;
  }

  // Turns app-server notifications into ActivityEvents and settles the run.
  event({ method, params: p = {} }) {
    const threadId = p.threadId || p.turn?.threadId;
    if (method === 'thread/tokenUsage/updated' && p.tokenUsage?.total) this.totals.set(threadId, p.tokenUsage.total);
    const run = this.pending.get(threadId); if (!run) return;
    const emit = event => { try { run.onEvent(event); } catch { /* a host's handler must not break the run */ } };
    const item = p.item || {};
    if (method === 'turn/started') {
      run.turnId = p.turn?.id;
      if (run.cancelled && run.turnId) this.interrupt(run);
    }
    if (method === 'item/reasoning/summaryTextDelta') {
      const part = `${p.itemId}:${p.summaryIndex}`;
      emit({ id: p.itemId, kind: 'reasoning', append: (p.summaryIndex > 0 && !run.parts.has(part) ? '\n' : '') + p.delta, status: 'running' });
      run.parts.add(part);
    }
    if (method === 'item/started' || method === 'item/completed') {
      const done = method === 'item/completed';
      const status = !done ? 'running' : item.status === 'failed' || (item.exitCode ?? 0) !== 0 ? 'failed' : 'done';
      if (item.type === 'reasoning') emit({ id: item.id, kind: 'reasoning', status: status === 'failed' ? 'done' : status,
        ...(item.summary?.length ? { text: item.summary.map(s => typeof s === 'string' ? s : s.text || '').join('\n') } : {}) });
      else if (item.type === 'agentMessage' && done) {
        // A message marked as commentary, and every message but the last, is a note along
        // the way; the last one is the reply.
        if (item.phase === 'commentary') emit({ id: item.id, kind: 'activity', title: 'Agent note', text: item.text || '', status: 'done' });
        else {
          if (run.text) emit({ id: `${item.id}-note`, kind: 'activity', title: 'Agent note', text: run.text, status: 'done' });
          run.text = item.text || '';
        }
      } else if (item.type === 'commandExecution') emit({ id: item.id, kind: 'activity', command: commandLine(item.command), status,
        ...(done ? { output: (item.aggregatedOutput || '').slice(-1500) } : {}) });
      else if (item.type === 'fileChange') emit({ id: item.id, kind: 'activity', paths: (item.changes || []).map(c => c.path), status });
      else if (item.type === 'webSearch') emit({ id: item.id, kind: 'activity', title: 'Searching the web', text: item.query || '', status });
      else if (item.type === 'plan') emit({ id: item.id, kind: 'activity', title: 'Plan', text: item.text || '', status });
      else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') emit({ id: item.id, kind: 'activity', title: 'Using a tool',
        text: [item.server, item.tool].filter(Boolean).join(' · '), status });
    }
    if (method === 'error' && !p.willRetry) run.finish(new ProviderError(p.error?.message || 'The agent could not complete the request.', 'failed'));
    if (method === 'turn/completed') {
      if (p.turn?.status !== 'completed') return run.finish(p.turn?.status === 'interrupted'
        ? new ProviderError('Stopped.', 'stopped') : new ProviderError(p.turn?.error?.message || 'The request stopped.', 'failed'));
      const total = this.totals.get(threadId);
      const usage = total ? Object.fromEntries(Object.keys(ZERO).map(name => [name, Math.max(0, (total[name] || 0) - (run.usageStart[name] || 0))])) : undefined;
      run.finish(null, { message: run.text, provenance: { provider: this.name, model: this.model || 'provider default', threadId }, ...(usage ? { usage } : {}) });
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
