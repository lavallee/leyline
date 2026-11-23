// A stand-in for `codex app-server` in tests: JSON-RPC on stdio, no model. What it does
// with a turn is chosen by the turn's input text. Everything it receives is appended to
// the file named by FAKE_LOG, one JSON value per line.
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const log = value => { if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, JSON.stringify(value) + '\n'); };
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const note = (method, params) => send({ method, params });
const threads = new Map();   // thread id -> { turns, total }
const hanging = new Map();   // thread id -> turn id
let seq = 0;

log({ env: { hasOpenAiKey: 'OPENAI_API_KEY' in process.env } });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); log(message);
  const { id, method, params } = message;
  if (method === undefined) return;                       // a reply to one of our requests
  if (method === 'initialize') return send({ id, result: {} });
  if (method === 'initialized') return;
  if (method === 'config/read') return send({ id, result: { config: { mcp_servers: { notes: {}, mail: {} }, plugins: { helper: {} } } } });
  if (method === 'model/list') return send({ id, result: { data: [{ id: 'other' }, { id: 'fake-model', isDefault: true }] } });
  if (method === 'thread/start') { const thread = `t${++seq}`; threads.set(thread, { turns: 0, total: 0 }); return send({ id, result: { thread: { id: thread } } }); }
  if (method === 'turn/interrupt') {
    send({ id, result: {} });
    if (hanging.get(params.threadId) === params.turnId) { hanging.delete(params.threadId); note('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } }); }
    return;
  }
  if (method === 'turn/start') {
    const threadId = params.threadId, state = threads.get(threadId), turnId = `turn${++seq}`;
    const text = params.input.map(part => part.text).join(' | ');
    state.turns++;
    send({ id, result: { turn: { id: turnId } } });
    note('turn/started', { threadId, turn: { id: turnId } });
    if (text.includes('hang')) return hanging.set(threadId, turnId);
    if (text.includes('die')) return process.exit(1);
    if (text.includes('fail')) return note('error', { threadId, willRetry: false, error: { message: 'The model is unavailable.' } });
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
    state.total += 100;
    note('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: state.total * 1.5, inputTokens: state.total, cachedInputTokens: 0, outputTokens: state.total / 2, reasoningOutputTokens: 10 * state.turns }, last: {} } });
    note('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
  }
});
