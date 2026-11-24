// A stand-in for `codex app-server` in tests: JSON-RPC on stdio, no model. What it does
// with a turn is chosen by the turn's input text. Everything it receives is appended to
// the file named by FAKE_LOG, one JSON value per line.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

// With FAKE_THREADS (a file), threads outlive the process, as Codex's rollouts do: thread/resume finds them again.
const kept = () => { try { return JSON.parse(readFileSync(process.env.FAKE_THREADS, 'utf8')); } catch { return {}; } };
const keep = (id, state) => { if (process.env.FAKE_THREADS) writeFileSync(process.env.FAKE_THREADS, JSON.stringify({ ...kept(), [id]: state })); };
const log = value => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(value) + '\n'); };
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const note = (method, params) => send({ method, params });
const threads = new Map();   // thread id -> { turns, total }
const hanging = new Map();   // thread id -> turn id
const steerable = new Map(); // thread id -> the turn that takes steers
const asking = new Map();    // request id -> { threadId, turnId, wait: the ids still unanswered, replies }
// The requests an app-server makes of its client, by the name a test's input gives them.
const ASKS = {
  command: (threadId, turnId) => ['item/commandExecution/requestApproval', { threadId, turnId, itemId: 'c7', startedAtMs: 1, environmentId: null, command: "/bin/bash -lc 'touch /etc/x'", cwd: '/work', reason: 'This writes outside the workspace.' }],
  file: (threadId, turnId) => ['item/fileChange/requestApproval', { threadId, turnId, itemId: 'f7', startedAtMs: 1, reason: 'Outside the writable folders.', grantRoot: '/etc' }],
  perms: (threadId, turnId) => ['item/permissions/requestApproval', { threadId, turnId, itemId: 'p7', environmentId: null, startedAtMs: 1, cwd: '/work', reason: 'Needs the network.', permissions: { network: { enabled: true }, fileSystem: null } }],
  input: (threadId, turnId) => ['item/tool/requestUserInput', { threadId, turnId, itemId: 'u7', isBlocking: true, autoResolutionMs: null, questions: [
    { id: 'tone', header: 'Tone', question: 'Which tone?', isOther: false, isSecret: false, options: [{ label: 'Formal', description: 'As for a report' }, { label: 'Plain', description: '' }] },
    { id: 'token', header: 'Key', question: 'The token?', isOther: true, isSecret: true, options: null }] }],
  elicit: (threadId, turnId) => ['mcpServer/elicitation/request', { threadId, turnId, serverName: 'notes', environmentId: null, mode: 'form', _meta: null, message: 'Which notebook?', requestedSchema: { type: 'object', properties: { notebook: { type: 'string' } } } }],
  legacy: threadId => ['execCommandApproval', { conversationId: threadId, callId: 'x', command: ['rm', 'x'], cwd: '/work', reason: null }],
  tool: (threadId, turnId) => ['item/tool/call', { threadId, turnId, callId: 'd7', tool: 'lookup', arguments: {} }],
  unknown: () => ['attestation/generate', {}],
};
// A reply to one of our requests: when the turn has all of them, it ends with what it was told.
function answered(message) {
  const waiting = asking.get(message.id); if (!waiting) return;
  asking.delete(message.id);
  waiting.replies.push(message.error ? { error: message.error.code } : message.result);
  waiting.wait.delete(message.id);
  if (waiting.wait.size || !hanging.has(waiting.threadId)) return;
  hanging.delete(waiting.threadId);
  note('item/completed', { threadId: waiting.threadId, item: { id: 'm9', type: 'agentMessage', text: JSON.stringify(waiting.replies) } });
  note('turn/completed', { threadId: waiting.threadId, turn: { id: waiting.turnId, status: 'completed' } });
}
let seq = 0;

log({ env: { hasOpenAiKey: 'OPENAI_API_KEY' in process.env } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params } = message;
  if (method === undefined) return answered(message);     // a reply to one of our requests
  if (method === 'initialize') return setTimeout(() => send({ id, result: {} }), Number(process.env.FAKE_SLOW_INIT || 0));
  if (method === 'initialized') return;
  if (method === 'config/read') return send({ id, result: { config: { mcp_servers: { notes: {}, mail: {} }, plugins: { helper: {} } } } });
  if (method === 'model/list') return send({ id, result: { data: [{ id: 'other' }, { id: 'fake-model', isDefault: true }] } });
  if (method === 'thread/start') {
    if (process.env.FAKE_DIE_ON_THREAD) return process.exit(1);
    const thread = process.env.FAKE_THREADS ? `t-${process.pid}-${++seq}` : `t${++seq}`; threads.set(thread, { turns: 0, total: 0 }); keep(thread, threads.get(thread));
    return setTimeout(() => send({ id, result: { thread: { id: thread } } }), Number(process.env.FAKE_SLOW_THREAD || 0));
  }
  if (method === 'thread/resume') {
    const state = threads.get(params.threadId) || (process.env.FAKE_THREADS ? kept()[params.threadId] : null);
    if (!state) return send({ id, error: { code: -32600, message: `no rollout found for thread id ${params.threadId}` } });
    threads.set(params.threadId, state);
    return send({ id, result: { thread: { id: params.threadId, turns: [] } } });
  }
  if (method === 'turn/interrupt') {
    send({ id, result: {} });
    steerable.delete(params.threadId);
    if (hanging.get(params.threadId) === params.turnId) { hanging.delete(params.threadId); note('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } }); }
    return;
  }
  if (method === 'turn/steer') {
    // As Codex does: the steer must name the turn that is active, or it is refused.
    const active = steerable.get(params.threadId);
    if (!active || active !== params.expectedTurnId) return send({ id, error: { code: -32600, message: `expected active turn id \`${params.expectedTurnId}\` but found \`${active ?? 'none'}\`` } });
    send({ id, result: { turnId: active } });
    const said = params.input.map(part => part.text).join(' | ');
    note('item/completed', { threadId: params.threadId, item: { id: `u${++seq}`, type: 'userMessage', content: params.input } });
    if (!said.includes('finish')) return;                   // steered, and still going
    steerable.delete(params.threadId); hanging.delete(params.threadId);
    note('item/completed', { threadId: params.threadId, item: { id: 'm9', type: 'agentMessage', text: `steered: ${said}` } });
    return note('turn/completed', { threadId: params.threadId, turn: { id: active, status: 'completed' } });
  }
  if (method === 'turn/start') {
    const threadId = params.threadId, state = threads.get(threadId), turnId = `turn${++seq}`;
    const text = params.input.map(part => part.text).join(' | ');
    state.turns++;
    send({ id, result: { turn: { id: turnId } } });
    note('turn/started', { threadId, turn: { id: turnId } });
    const asks = [...text.matchAll(/ask-(\w+)/g)].map(match => match[1]).filter(name => ASKS[name] || name === 'withdrawn');
    if (asks.length) {
      // Each request is sent and the turn waits for every answer (an interrupt ends it, as for 'hang').
      const waiting = { threadId, turnId, wait: new Set(), replies: [] };
      hanging.set(threadId, turnId);
      for (const name of asks) {
        const requestId = 9000 + ++seq, [asked, askedParams] = ASKS[name === 'withdrawn' ? 'command' : name](threadId, turnId);
        send({ id: requestId, method: asked, params: askedParams });
        if (name === 'withdrawn') {
          // The agent takes the question back (it was answered somewhere else, say) and carries on.
          note('serverRequest/resolved', { threadId, requestId });
          hanging.delete(threadId);
          note('item/completed', { threadId, item: { id: 'm9', type: 'agentMessage', text: 'withdrawn' } });
          return note('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
        }
        waiting.wait.add(requestId); asking.set(requestId, waiting);
      }
      return;
    }
    if (text.includes('steerable')) { steerable.set(threadId, turnId); return hanging.set(threadId, turnId); }
    if (text.includes('hang')) return hanging.set(threadId, turnId);
    if (text.includes('deaf')) return;                      // never finishes, and an interrupt changes nothing
    if (text.includes('garbage')) {
      process.stdout.write('null\n[]\n"text"\n');
      send({ method: 'item/completed', params: null });
      send({ method: 'item/completed' });
      note('item/completed', { threadId, item: null });
      note('item/completed', { threadId, item: { id: 'g1', type: 'fileChange', changes: [null, 7, { path: '/work/ok.md' }] } });
      note('item/completed', { threadId, item: { id: 'g2', type: 'commandExecution', command: { not: 'a command' }, aggregatedOutput: { not: 'text' } } });
      note('item/completed', { threadId, item: { id: 'g3', type: 'reasoning', summary: [null, 5, { text: 'kept' }] } });
      note('item/reasoning/summaryTextDelta', { threadId, itemId: 'g4', summaryIndex: 0, delta: { not: 'text' } });
      note('thread/tokenUsage/updated', { threadId, tokenUsage: { total: 'many' } });
      note('turn/started', { threadId, turn: null });
    }
    if (text.includes('die')) return process.exit(1);
    if (text.includes('fail')) return note('error', { threadId, willRetry: false, error: { message: 'The model is unavailable.' } });
    if (text.includes('stream')) {
      // A reply written piece by piece, with a note before it and a command whose output arrives as it runs.
      note('item/started', { threadId, item: { id: 'n1', type: 'agentMessage', phase: 'commentary', text: '' } });
      for (const delta of ['Looking ', 'first.']) note('item/agentMessage/delta', { threadId, turnId, itemId: 'n1', delta });
      note('item/completed', { threadId, item: { id: 'n1', type: 'agentMessage', phase: 'commentary', text: 'Looking first.' } });
      note('item/started', { threadId, item: { id: 'x1', type: 'commandExecution', command: 'make test' } });
      for (const delta of ['compiling\n', 'testing\n', { not: 'text' }, 'ok\n']) note('item/commandExecution/outputDelta', { threadId, turnId, itemId: 'x1', delta });
      note('item/completed', { threadId, item: { id: 'x1', type: 'commandExecution', command: 'make test', exitCode: 0, aggregatedOutput: 'compiling\ntesting\nok\n' } });
      note('item/started', { threadId, item: { id: 's1', type: 'agentMessage', phase: null, text: '' } });
      for (const delta of ['Half', 'way ', 'there.']) note('item/agentMessage/delta', { threadId, turnId, itemId: 's1', delta });
      note('item/completed', { threadId, item: { id: 's1', type: 'agentMessage', text: 'Halfway there.' } });
      for (const delta of ['The ', 'tests ', 'pass.']) note('item/agentMessage/delta', { threadId, turnId, itemId: 's2', delta });   // no item/started: the delta is the first word of it
      note('item/agentMessage/delta', { threadId, turnId, itemId: null, delta: 'dropped' });
      note('item/completed', { threadId, item: { id: 's2', type: 'agentMessage', text: 'The tests pass.' } });
      note('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 0 }, last: {} } });
      return note('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
    }
    if (text.includes('approve')) send({ id: 9000 + seq, method: 'item/commandExecution/requestApproval', params: { threadId, command: 'rm -rf /' } });
    note('item/started', { threadId, item: { id: 'r1', type: 'reasoning' } });
    note('item/reasoning/summaryTextDelta', { threadId, itemId: 'r1', summaryIndex: 0, delta: 'Reading' });
    note('item/reasoning/summaryTextDelta', { threadId, itemId: 'r1', summaryIndex: 0, delta: ' the text.' });
    note('item/reasoning/summaryTextDelta', { threadId, itemId: 'r1', summaryIndex: 1, delta: 'Deciding.' });
    note('item/reasoning/textDelta', { threadId, itemId: 'r1', delta: 'RAW REASONING MUST NOT LEAK' });
    note('item/completed', { threadId, item: { id: 'r1', type: 'reasoning', summary: ['Reading the text.', { text: 'Deciding.' }] } });
    note('item/started', { threadId, item: { id: 'c1', type: 'commandExecution', command: ['/bin/bash', '-lc', 'ls notes'] } });
    note('item/completed', { threadId, item: { id: 'c1', type: 'commandExecution', command: "/bin/bash -lc 'ls notes'", exitCode: 0, aggregatedOutput: 'a.md\nb.md' } });
    note('item/completed', { threadId, item: { id: 'c2', type: 'commandExecution', command: 'false', exitCode: 1, aggregatedOutput: '' } });
    note('item/completed', { threadId, item: { id: 'f1', type: 'fileChange', changes: [{ path: '/work/notes/a.md' }] } });
    note('item/completed', { threadId, item: { id: 'w1', type: 'webSearch', query: 'tide tables' } });
    note('item/completed', { threadId, item: { id: 'm0', type: 'agentMessage', phase: 'commentary', text: 'Looking around first.' } });
    note('item/completed', { threadId, item: { id: 'm1', type: 'agentMessage', text: 'Halfway there.' } });
    note('item/completed', { threadId, item: { id: 'm2', type: 'agentMessage', text: `turn ${state.turns}: ${text}` } });
    state.total += 100; keep(threadId, state);
    note('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: state.total * 1.5, inputTokens: state.total, cachedInputTokens: 0, outputTokens: state.total / 2, reasoningOutputTokens: 10 * state.turns },
      last: { totalTokens: 150, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 } } });
    note('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  }
});
