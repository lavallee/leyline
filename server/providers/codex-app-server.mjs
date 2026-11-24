// A long-lived agent over the Codex app-server protocol (JSON-RPC on stdio): one child
// process, one thread per host key, activity streamed while it works. Generalised from
// the adapters Copycat (src/live.js) and Skein (src/agent-provider.js) each wrote.
//
// What the host decides, per run: the sandbox (read-only, or workspace-write with the
// folders it names), the instructions, the input. What this adapter always does:
// - a request the agent makes of the client (an approval, a question) is answered in the
//   shape that request expects. It goes to the run's `onAsk`, which may wait for a person;
//   with no `onAsk` it is declined, so the sandbox is the boundary. Approvals are only
//   asked for at all when a run sets `approvalPolicy` to something other than 'never';
// - raw reasoning is never read or passed on, only the summaries the agent publishes;
// - with `disableUserExtensions` (the default) the MCP servers, plugins and apps in the
//   user's own Codex configuration are switched off for these threads.
import { mkdir } from 'node:fs/promises';
import { CodexRpc } from '../codex-rpc.mjs';
import { ProviderError, chosenOption, createBatcher, inputParts } from './contract.mjs';
import { SHORT_NAME } from '../package-info.mjs';

const ZERO = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
const said = text => ({ type: 'text', text, text_elements: [] });
const words = value => typeof value === 'string' ? value : '';
// A transport error as a host should see it.
const fromRpc = error => error instanceof ProviderError ? error
  : new ProviderError(String(error?.message || error).slice(0, 300), { closed: 'unavailable', timeout: 'timeout' }[error?.code] || 'failed');

// ---------------------------------------------------------------- requests the agent makes of the client
// Checked against the types `codex app-server generate-ts` writes for Codex CLI 0.171.0
// (ServerRequest.ts and the v2 params and response types it names). Each entry says what
// the request asks of a person and what a reply to it looks like; a reply of another shape
// is an error on the agent's side.
const text = value => typeof value === 'string' ? value : undefined;
const clean = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));
const option = (id, label) => ({ id, label });
const APPROVAL = [option('accept', 'Allow'), option('acceptForSession', 'Allow for this session'), option('decline', 'Decline'), option('cancel', 'Decline and stop')];
const approval = answer => { const chosen = chosenOption(answer); return ['accept', 'acceptForSession', 'decline', 'cancel'].includes(chosen) ? chosen : 'decline'; };
// The older approval requests answer in an older vocabulary (ReviewDecision).
const review = answer => ({ accept: 'approved', acceptForSession: 'approved_for_session', cancel: 'abort' })[approval(answer)] || { denied: { rejection: 'Declined.' } };
export const CODEX_REQUESTS = {
  // CommandExecutionRequestApprovalResponse: { decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' | { ...amendment } }
  'item/commandExecution/requestApproval': { kind: 'command',
    ask: p => ({ title: 'Run a command', detail: clean({ command: p.command === undefined || p.command === null ? undefined : commandLine(p.command), cwd: text(p.cwd), reason: text(p.reason), itemId: text(p.itemId) }), options: APPROVAL }),
    reply: answer => ({ decision: approval(answer) }) },
  // FileChangeRequestApprovalResponse: { decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' }
  'item/fileChange/requestApproval': { kind: 'file-change',
    ask: p => ({ title: 'Change files', detail: clean({ reason: text(p.reason), grantRoot: text(p.grantRoot), itemId: text(p.itemId) }), options: APPROVAL }),
    reply: answer => ({ decision: approval(answer) }) },
  // PermissionsRequestApprovalResponse: { permissions: GrantedPermissionProfile, scope: 'turn' | 'session' }
  'item/permissions/requestApproval': { kind: 'permissions',
    ask: p => ({ title: 'Grant more access', detail: clean({ reason: text(p.reason), cwd: text(p.cwd), permissions: p.permissions }), options: APPROVAL.slice(0, 3) }),
    reply: (answer, p) => { const chosen = approval(answer), granted = chosen === 'accept' || chosen === 'acceptForSession';
      return { permissions: granted && p.permissions && typeof p.permissions === 'object' ? clean({ network: p.permissions.network, fileSystem: p.permissions.fileSystem }) : {}, scope: chosen === 'acceptForSession' ? 'session' : 'turn' }; } },
  // ToolRequestUserInputResponse: { answers: { [questionId]: { answers: string[] } } }
  'item/tool/requestUserInput': { kind: 'input',
    ask: p => ({ title: 'A question from the agent', detail: {}, options: [option('accept', 'Answer'), option('decline', 'Do not answer')],
      questions: (Array.isArray(p.questions) ? p.questions : []).filter(q => q && typeof q.id === 'string').map(q => ({ id: q.id, header: text(q.header) || '', question: text(q.question) || '',
        options: Array.isArray(q.options) ? q.options.filter(Boolean).map(o => ({ label: String(o.label ?? ''), description: String(o.description ?? '') })) : null, other: !!q.isOther, secret: !!q.isSecret })) }),
    reply: answer => { const given = approval(answer) === 'accept' && answer && typeof answer.answers === 'object' && answer.answers ? answer.answers : {};
      return { answers: Object.fromEntries(Object.entries(given).filter(([, value]) => typeof value === 'string' || Array.isArray(value)).map(([id, value]) => [id, { answers: (Array.isArray(value) ? value : [value]).map(String) }])) }; } },
  // McpServerElicitationRequestResponse: { action: 'accept' | 'decline' | 'cancel', content, _meta }
  'mcpServer/elicitation/request': { kind: 'elicitation',
    ask: p => ({ title: `A question from ${text(p.serverName) || 'a tool'}`, detail: clean({ server: text(p.serverName), message: text(p.message), mode: text(p.mode), url: text(p.url), schema: p.requestedSchema }),
      options: [option('accept', 'Answer'), option('decline', 'Decline'), option('cancel', 'Cancel')] }),
    reply: answer => { const chosen = approval(answer), action = chosen === 'acceptForSession' ? 'accept' : chosen;
      return { action, content: action === 'accept' ? (answer && typeof answer === 'object' && answer.content !== undefined ? answer.content : {}) : null, _meta: null }; } },
  // ExecCommandApprovalResponse and ApplyPatchApprovalResponse: { decision: ReviewDecision }
  execCommandApproval: { kind: 'command', ask: p => ({ title: 'Run a command', detail: clean({ command: p.command === undefined ? undefined : commandLine(p.command), cwd: text(p.cwd), reason: text(p.reason) }), options: APPROVAL }), reply: answer => ({ decision: review(answer) }) },
  applyPatchApproval: { kind: 'file-change', ask: p => ({ title: 'Change files', detail: clean({ reason: text(p.reason), grantRoot: text(p.grantRoot) }), options: APPROVAL }), reply: answer => ({ decision: review(answer) }) },
  // DynamicToolCallResponse: { contentItems, success }. This client offers the agent no tools of its own.
  'item/tool/call': { reply: () => ({ contentItems: [{ type: 'inputText', text: 'This client offers no tools.' }], success: false }) },
};
const RESOLVED = Symbol('resolved');

/** A command as the agent ran it, without the shell wrapper Codex puts around it. */
export const commandLine = command => (Array.isArray(command) ? command.join(' ') : String(command || ''))
  .replace(/^\/\S*\/(?:ba|z)?sh -l?c /, '').replace(/^(['"])([\s\S]*)\1$/, '$2');

export class CodexAppServerProvider {
  name = 'codex-app-server';
  capabilities = { activity: true, textStream: true, sessions: true, cancel: true, shell: true, structuredOutput: true, asks: true, steer: true };

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
   * @param {(request: object) => object|Promise<object>} [options.onApproval] the older hook, kept for hosts that have one:
   *   it sees every request the agent makes, as the raw JSON-RPC message, before anything else does, and an object it
   *   returns is sent back as the reply exactly as given. When it returns nothing, or throws, the request goes on to the
   *   run's `onAsk` and from there to a decline. New hosts should use `onAsk`.
   * @param {(chunk: Buffer) => void} [options.onStderr]
   * @param {number} [options.stopGrace] milliseconds a stopped run waits for the agent to confirm before it is
   *   ended anyway and its thread forgotten; default 10000. Infinity waits for the run's own timeout.
   * @param {number} [options.killGrace] milliseconds close() waits after SIGTERM before SIGKILL; default 2000
   * @param {number} [options.maxLine] characters in one line from the child; longer lines are dropped. Default 64 MB
   * @param {boolean} [options.processGroup] stop what the child started along with it; see CodexRpc. Default false
   * @param {{ms?: number, chars?: number}} [options.streamBatch] how streamed text is gathered before it is passed on: for
   *   up to `ms` milliseconds or until `chars` characters are waiting. Default { ms: 40, chars: 400 }; `ms: 0` passes on
   *   every delta as it arrives.
   */
  constructor({ command = ['codex', 'app-server'], workDir, clientInfo = { name: SHORT_NAME }, serviceName, env = process.env,
    dropEnv = ['OPENAI_API_KEY'], disableUserExtensions = true, threadConfig = {}, model, onApproval, onStderr, stopGrace = 10000, killGrace = 2000, maxLine, processGroup = false, streamBatch } = {}) {
    if (!Array.isArray(command) || !command.length || command.some(part => typeof part !== 'string' || !part || part.includes('\0')))
      throw new ProviderError('The app-server command must be a list of non-empty strings.', 'config');
    if (typeof workDir !== 'string' || !workDir) throw new ProviderError('Give the app-server a working folder (workDir).', 'config');
    Object.assign(this, { command, workDir, serviceName: serviceName || clientInfo.name, disableUserExtensions, threadConfig, fixedModel: model, onStderr, stopGrace, killGrace, maxLine, processGroup, streamBatch });
    this.clientInfo = { name: clientInfo.name, title: clientInfo.title || clientInfo.name, version: clientInfo.version || '0.0.0' };
    this.env = Object.fromEntries(Object.entries(env).filter(([name]) => !dropEnv.includes(name)));
    this.onApproval = typeof onApproval === 'function' ? onApproval : null;
    this.threads = new Map();   // host key -> Codex thread id
    this.pending = new Map();   // Codex thread id -> the run in flight
    this.starting = new Set();  // host keys whose run has not reached its turn yet
    this.arriving = new Map();  // host key -> a promise that settles when such a run has reached its turn, or failed to
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
      rpc.on('request', message => { this.request(rpc, message).catch(() => {}); });
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
   * @param {'never'|'on-request'|'untrusted'|object} [request.approvalPolicy] when the agent asks before acting
   *   (Codex's AskForApproval). Default 'never': it never asks, and what the sandbox forbids simply fails. With
   *   'on-request' or 'untrusted' it sends approval requests, which go to `onAsk`.
   * @param {(ask: object, context: {signal: AbortSignal}) => any} [request.onAsk] answers a request the agent makes of a
   *   person; see "Asks" in ./contract.mjs. May return a promise: the turn waits, and the idle timeout is paused
   *   meanwhile. Without it every such request is declined at once. `signal` aborts when the answer is no longer
   *   wanted (the turn was stopped, or the agent withdrew the request).
   * @param {(piece: string, at: {segment: number}) => void} [request.onText] the reply as it is written. Messages the
   *   agent marks as commentary are not passed here; they arrive through onEvent as an "Agent note" that grows.
   * @param {boolean} [request.streamOutput] also pass on a command's output while it runs, as `append` events on the
   *   command's activity item (the item then holds the output as it came, instead of only its tail at the end).
   *   Default false, so a host's activity list is unchanged unless it asks.
   */
  async run({ key, instructions, input, effort = 'low', sandbox = {}, outputSchema, threadConfig, model: asked, onEvent = () => {}, onText, streamOutput = false, onAsk, approvalPolicy = 'never', signal, timeout = 900000, idleTimeout } = {}) {
    if (typeof key !== 'string' || !key) throw new ProviderError('Give the run a conversation key.', 'config');
    const parts = inputParts(input);
    if (!parts.length) throw new ProviderError('Give the run some input.', 'config');
    if (signal?.aborted) throw new ProviderError('Stopped.', 'stopped');
    if (this.starting.has(key) || [...this.pending.values()].some(run => run.key === key)) throw new ProviderError('That conversation already has a request running.', 'busy');
    // The key is taken from here on, so a second run cannot slip in while this one starts.
    this.starting.add(key);
    let halt, arrived;
    this.arriving.set(key, new Promise(done => { arrived = done; }));
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
        const thread = rpc.call('thread/start', { cwd, approvalPolicy, sandbox: write ? 'workspace-write' : 'read-only',
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
      return this.turn({ rpc, key, threadId, cwd, parts, effort, policy, outputSchema, model, asked, onEvent, onText, streamOutput, onAsk, approvalPolicy, signal, timeout, idleTimeout });
    } finally { this.starting.delete(key); this.arriving.delete(key); arrived(); signal?.removeEventListener('abort', halt); }
  }

  // Starts the turn and returns the promise that settles when it ends. The run is in
  // `pending` before this returns, so the key stays taken without a gap.
  turn({ rpc, key, threadId, cwd, parts, effort, policy, outputSchema, model, asked, onEvent, onText, streamOutput, onAsk, approvalPolicy, signal, timeout, idleTimeout }) {
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel(key);
      const run = { key, threadId, model: asked, text: '', turnId: null, cancelled: false, onEvent, parts: new Set(), usageStart: this.totals.get(threadId) || ZERO,
        onAsk: typeof onAsk === 'function' ? onAsk : null, asking: new Map(), waiting: 0,
        onText: typeof onText === 'function' ? onText : null, streamOutput: !!streamOutput, batch: createBatcher(this.streamBatch), messages: new Map(), segments: 0, streamed: new Set(),
        finish: (error, result) => {
          if (this.pending.get(threadId) !== run) return;
          run.name();
          run.batch.flush();                                     // text still being gathered goes out before the result
          for (const asked of [...run.asking.values()]) asked.settle('cancel');   // nobody is waiting for these answers any more
          clearTimeout(run.timer); clearTimeout(run.grace); clearTimeout(run.idle); signal?.removeEventListener('abort', abort); this.pending.delete(threadId);
          error ? reject(error) : resolve(result);
        } };
      run.named = new Promise(done => { run.name = done; });   // settles when the agent has named the turn, or the run is over
      run.timer = setTimeout(() => { this.cancel(key); this.threads.delete(key); run.finish(new ProviderError('The request ran out of time and was stopped.', 'timeout')); }, Math.min(Math.max(0, Number(timeout) || 0), 2 ** 31 - 1));
      const expire = () => { this.cancel(key); this.threads.delete(key); run.finish(new ProviderError('The agent went quiet and was stopped.', 'timeout')); };
      // Called for every notification about this run: the quiet period starts again.
      // While the agent is waiting on a person it is not the agent that is quiet: the clock is paused.
      run.heard = () => { clearTimeout(run.idle); if (!(idleTimeout > 0) || run.waiting > 0) return; run.idle = setTimeout(expire, Math.min(idleTimeout, 2 ** 31 - 1)); };
      run.heard();
      this.pending.set(threadId, run);
      signal?.addEventListener('abort', abort, { once: true });
      rpc.call('turn/start', { threadId, cwd, input: parts.map(said), effort, summary: 'auto', sandboxPolicy: policy, approvalPolicy,
        ...(outputSchema ? { outputSchema } : {}), ...model }).then(result => {
          run.turnId ||= result?.turn?.id;
          if (run.turnId) run.name();
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

  /**
   * Sends more input into the turn that is running for `key`, without ending it (Codex's
   * `turn/steer`). The agent takes it up at its next step. The request names the turn it
   * is meant for, so input sent as a turn ends is refused by the agent rather than starting
   * a turn nobody asked for: that, and there being no run at all, rejects with code 'ended'.
   * @param {string} key
   * @param {string|string[]} input
   * @param {{clientUserMessageId?: string}} [options] an id of the host's for this message, passed to the agent
   * @returns {Promise<{turnId: string}>} the agent's id for the turn that took the input
   */
  async steer(key, input, { clientUserMessageId } = {}) {
    const parts = inputParts(input);
    if (!parts.length) throw new ProviderError('Give the steer some input.', 'config');
    const ended = () => new ProviderError('That request is no longer running, so there is nothing to steer.', 'ended');
    // A run that is still starting (the child, the thread) has no turn to address the input to
    // yet, and nor has one the agent has not named; a moment later there will be one.
    if (this.starting.has(key)) await this.arriving.get(key);
    const run = [...this.pending.values()].find(r => r.key === key), rpc = this.rpc;
    if (run && !run.turnId && !run.cancelled) await run.named;
    if (!run || !rpc || !run.turnId || run.cancelled || this.pending.get(run.threadId) !== run) throw ended();
    try {
      const answer = await rpc.call('turn/steer', { threadId: run.threadId, input: parts.map(said), expectedTurnId: run.turnId, ...(typeof clientUserMessageId === 'string' ? { clientUserMessageId } : {}) });
      return { turnId: typeof answer?.turnId === 'string' ? answer.turnId : run.turnId };
    } catch (error) {
      // The agent refuses a steer whose turn is not the active one. If our run has gone too, that is why.
      if (this.pending.get(run.threadId) !== run || error?.code === 'closed') throw ended();
      throw Object.assign(fromRpc(error), { cause: error });
    }
  }

  /** Asks the agent to stop the run for `key`. The run then rejects with code 'stopped'. */
  cancel(key) {
    const run = [...this.pending.values()].find(r => r.key === key); if (!run) return false;
    run.cancelled = true;
    if (run.turnId) this.interrupt(run);
    for (const asked of [...run.asking.values()]) asked.settle('cancel');   // a question still open is answered: decline, and stop
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

  // A request from the agent: answered in the shape its method expects, after asking whoever the run names.
  async request(rpc, message) {
    const method = message?.method, id = message?.id, p = message?.params && typeof message.params === 'object' ? message.params : {};
    const reply = result => { if (this.rpc === rpc) rpc.reply(id, result); };
    if (this.onApproval) {
      const given = await Promise.resolve().then(() => this.onApproval(message)).catch(() => undefined);
      if (given && typeof given === 'object') return reply(given);
    }
    const kind = Object.hasOwn(CODEX_REQUESTS, method) ? CODEX_REQUESTS[method] : null;
    // A method this client does not know is refused as JSON-RPC says to, so the agent is not left waiting.
    if (!kind) { if (this.rpc === rpc) rpc.send({ id, error: { code: -32601, message: `Method not found: ${String(method).slice(0, 100)}` } }); return; }
    if (!kind.ask) return reply(kind.reply(undefined, p));
    const run = this.pending.get(p.threadId || p.conversationId);
    let answer = 'decline';
    if (run?.onAsk && !run.cancelled) {
      const controller = new AbortController(), asked = {};
      const settled = new Promise(resolve => { asked.settle = value => { controller.abort(); resolve(value); }; });
      run.asking.set(id, asked); run.waiting++; clearTimeout(run.idle);
      try { answer = await Promise.race([Promise.resolve().then(() => run.onAsk({ id: `ask-${id}`, provider: this.name, method, kind: kind.kind, ...kind.ask(p) }, { signal: controller.signal })), settled]); }
      catch { answer = 'decline'; }
      finally { run.asking.delete(id); run.waiting--; if (this.pending.get(run.threadId) === run) run.heard(); }
      if (answer === RESOLVED) return;                         // the agent withdrew the request: it expects no reply
    }
    // An object with `reply` is sent as it is, for the answers this table does not name (a policy amendment, say).
    reply(answer && typeof answer === 'object' && answer.reply && typeof answer.reply === 'object' ? answer.reply : kind.reply(answer, p));
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
    // Streamed text is gathered for a moment before it is passed on; anything else about
    // the run goes out after the text that came before it.
    if (method === 'item/agentMessage/delta' || method === 'item/commandExecution/outputDelta') {
      const id = p.itemId, delta = words(p.delta);
      if ((typeof id !== 'string' && typeof id !== 'number') || !delta) return;
      if (method === 'item/commandExecution/outputDelta') {
        if (!run.streamOutput) return;
        run.streamed.add(id);
        return run.batch.add(`output:${id}`, delta, piece => emit({ id, kind: 'activity', append: piece, status: 'running' }));
      }
      let message = run.messages.get(id);
      if (!message) run.messages.set(id, message = { commentary: false, segment: run.segments++ });
      if (message.commentary) return run.batch.add(`note:${id}`, delta, piece => emit({ id, kind: 'activity', title: 'Agent note', append: piece, status: 'running' }));
      if (run.onText) run.batch.add(`text:${id}`, delta, piece => run.onText(piece, { segment: message.segment }));
      return;
    }
    run.batch.flush();
    if (method === 'serverRequest/resolved') return void run.asking.get(p.requestId)?.settle(RESOLVED);
    if (method === 'item/started' && item.type === 'agentMessage' && !run.messages.has(item.id)) run.messages.set(item.id, item.phase === 'commentary' ? { commentary: true } : { commentary: false, segment: run.segments++ });
    if (method === 'turn/started') {
      run.turnId = p.turn?.id || run.turnId;
      if (run.turnId) run.name();
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
        // Output that was passed on as it came is already in the item.
        ...(done && !run.streamed.has(item.id) ? { output: words(item.aggregatedOutput).slice(-1500) } : {}) });
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
