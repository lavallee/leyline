// Requests that wait for a person: the provider-neutral ask channel, from an agent's
// request, through the store, to an answer in the shape the agent expects.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexAppServerProvider, CODEX_REQUESTS } from '../server/providers/codex-app-server.mjs';
import { AcpProvider } from '../server/providers/acp.mjs';
import { chosenOption } from '../server/providers/contract.mjs';
import { createConversationStore as create, readConversation } from '../server/conversations.mjs';
import { fixture, tempDir, until, readLines, beforeCleanup, deferred } from './helpers.mjs';

const createConversationStore = options => { const store = create(options); beforeCleanup(() => store.close()); return store; };
const settled = turn => until(() => ['succeeded', 'failed', 'stopped'].includes(turn.status));
async function codex(t, options = {}) {
  const dir = await tempDir(t), log = path.join(dir, 'log.jsonl');
  const provider = new CodexAppServerProvider({ command: [process.execPath, fixture('fake-app-server.mjs')], workDir: path.join(dir, 'work'), env: { ...process.env, FAKE_LOG: log }, ...options });
  t.after(() => provider.close());
  // What the client answered to the agent's own requests (their ids start above 9000).
  return { provider, dir, replies: async () => (await readLines(log)).filter(m => m.method === undefined && m.id > 9000).sort((a, b) => a.id - b.id).map(m => m.error ? { error: m.error.code } : m.result),   // in the order they were asked
    sent: async method => (await readLines(log)).filter(m => m.method === method) };
}

test('Codex: every kind of request reaches onAsk in one shape and is answered in the shape its method expects', async t => {
  const { provider, replies, sent } = await codex(t), asks = [];
  const answers = { command: 'acceptForSession', 'file-change': { option: 'accept' }, permissions: 'acceptForSession', input: { option: 'accept', answers: { tone: 'Plain', token: ['s3cret'], ignored: 7 } },
    elicitation: { option: 'accept', content: { notebook: 'field notes' } } };
  const result = await provider.run({ key: 'a', input: 'ask-command ask-file ask-perms ask-input ask-elicit ask-tool ask-unknown', approvalPolicy: 'on-request',
    onAsk: async (ask, context) => { asks.push(ask); assert.equal(context.signal.aborted, false); return answers[ask.kind]; } });
  assert.deepEqual(await replies(), [
    { decision: 'acceptForSession' },                                      // CommandExecutionRequestApprovalResponse
    { decision: 'accept' },                                                // FileChangeRequestApprovalResponse
    { permissions: { network: { enabled: true } }, scope: 'session' },     // PermissionsRequestApprovalResponse: only what was asked for, nulls left out
    { answers: { tone: { answers: ['Plain'] }, token: { answers: ['s3cret'] } } },   // ToolRequestUserInputResponse
    { action: 'accept', content: { notebook: 'field notes' }, _meta: null },         // McpServerElicitationRequestResponse
    { contentItems: [{ type: 'inputText', text: 'This client offers no tools.' }], success: false },   // DynamicToolCallResponse, with nobody asked
    { error: -32601 },                                                     // a method this client does not know is refused, not left hanging
  ]);
  assert.deepEqual(JSON.parse(result.message).map(r => JSON.stringify(r)).sort(), (await replies()).map(r => JSON.stringify(r)).sort(), 'the agent received exactly those');
  assert.deepEqual(asks.map(a => [a.kind, a.method, a.provider]), [['command', 'item/commandExecution/requestApproval', 'codex-app-server'], ['file-change', 'item/fileChange/requestApproval', 'codex-app-server'],
    ['permissions', 'item/permissions/requestApproval', 'codex-app-server'], ['input', 'item/tool/requestUserInput', 'codex-app-server'], ['elicitation', 'mcpServer/elicitation/request', 'codex-app-server']]);
  assert.deepEqual(asks[0], { id: asks[0].id, provider: 'codex-app-server', method: 'item/commandExecution/requestApproval', kind: 'command', title: 'Run a command',
    detail: { command: 'touch /etc/x', cwd: '/work', reason: 'This writes outside the workspace.', itemId: 'c7' },
    options: [{ id: 'accept', label: 'Allow' }, { id: 'acceptForSession', label: 'Allow for this session' }, { id: 'decline', label: 'Decline' }, { id: 'cancel', label: 'Decline and stop' }] });
  assert.equal(new Set(asks.map(a => a.id)).size, 5, 'each ask has an id of its own');
  assert.deepEqual(asks[3].questions, [{ id: 'tone', header: 'Tone', question: 'Which tone?', options: [{ label: 'Formal', description: 'As for a report' }, { label: 'Plain', description: '' }], other: false, secret: false },
    { id: 'token', header: 'Key', question: 'The token?', options: null, other: true, secret: true }]);
  assert.deepEqual(asks[4].detail, { server: 'notes', message: 'Which notebook?', mode: 'form', schema: { type: 'object', properties: { notebook: { type: 'string' } } } });
  assert.equal((await sent('thread/start'))[0].params.approvalPolicy, 'on-request');
  assert.equal((await sent('turn/start'))[0].params.approvalPolicy, 'on-request');
});

test('Codex: with nobody to ask, and for every way of not answering, each request is declined in its own shape', async t => {
  const declined = [{ decision: 'decline' }, { decision: 'decline' }, { permissions: {}, scope: 'turn' }, { answers: {} }, { action: 'decline', content: null, _meta: null }, { decision: { denied: { rejection: 'Declined.' } } }];
  const input = 'ask-command ask-file ask-perms ask-input ask-elicit ask-legacy';
  const silent = await codex(t);
  await silent.provider.run({ key: 'a', input });
  assert.deepEqual(await silent.replies(), declined, 'no onAsk: the default, and what 0.6.0 hosts get');
  assert.equal((await silent.sent('thread/start'))[0].params.approvalPolicy, 'never', 'and approvals are not asked for unless a run says so');
  for (const onAsk of [() => undefined, () => { throw new Error('the panel broke'); }, async () => 'no such option', () => ({ nonsense: true }), () => 'decline']) {
    const { provider, replies } = await codex(t);
    await provider.run({ key: 'a', input, onAsk });
    assert.deepEqual(await replies(), declined, String(onAsk));
  }
  // 'cancel' is decline-and-stop where the request has such an answer, and a plain refusal where it has not.
  const stop = await codex(t);
  await stop.provider.run({ key: 'a', input, onAsk: () => 'cancel' });
  assert.deepEqual(await stop.replies(), [{ decision: 'cancel' }, { decision: 'cancel' }, { permissions: {}, scope: 'turn' }, { answers: {} }, { action: 'cancel', content: null, _meta: null }, { decision: 'abort' }]);
  // An answer may carry the reply itself, for the answers the table does not name.
  const exact = await codex(t), amendment = { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch'] } } };
  await exact.provider.run({ key: 'a', input: 'ask-command', onAsk: () => ({ reply: amendment }) });
  assert.deepEqual(await exact.replies(), [amendment]);
  assert.deepEqual(Object.keys(CODEX_REQUESTS).sort(), ['applyPatchApproval', 'execCommandApproval', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/call', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']);
  assert.deepEqual(['accept', { option: 'cancel' }, { decision: 'accept' }, undefined, 7, {}].map(chosenOption), ['accept', 'cancel', 'accept', 'decline', 'decline', 'decline']);
});

test('Codex: an answer may take as long as a person does; the idle timeout waits, a stop answers "cancel", a withdrawn request is dropped', async t => {
  const { provider, replies } = await codex(t), gate = deferred();
  let asked = 0; const began = Date.now();
  const slow = provider.run({ key: 'a', input: 'ask-command', idleTimeout: 120, onAsk: () => { asked++; return gate.promise; } });
  await until(() => asked === 1 && Date.now() - began > 400);          // well past the idle limit, with the agent silent throughout
  gate.resolve('accept');
  assert.equal((await slow).message, '[{"decision":"accept"}]', 'the run was still there to be answered');
  // Stopped while a question is open: the question is answered so the agent is not left waiting, and the listener is told.
  let signal;
  const stopped = provider.run({ key: 'b', input: 'ask-file', onAsk: (ask, context) => { signal = context.signal; return new Promise(() => {}); } });
  await until(() => signal);
  provider.cancel('b');
  await assert.rejects(stopped, { code: 'stopped' });
  assert.equal(signal.aborted, true);
  await until(async () => (await replies()).length === 2);   // the agent's record of the reply is written a moment after the run rejects
  assert.deepEqual((await replies()).at(-1), { decision: 'cancel' });
  // The agent takes a question back: nothing is sent in reply, and the listener is told.
  const count = (await replies()).length;
  let withdrawn;
  const result = await provider.run({ key: 'c', input: 'ask-withdrawn', onAsk: (ask, context) => { withdrawn = context.signal; return new Promise(() => {}); } });
  assert.equal(result.message, 'withdrawn');
  assert.equal(withdrawn.aborted, true);
  assert.equal((await replies()).length, count, 'no reply to a request the agent withdrew');
});

test('Codex: the older onApproval hook still has the first word, and its reply goes out exactly as given', async t => {
  const seen = [], asks = [];
  const { provider, replies } = await codex(t, { onApproval: request => { seen.push(request.method); return request.method.includes('commandExecution') ? { decision: 'accept', extra: 'as given' } : undefined; } });
  await provider.run({ key: 'a', input: 'ask-command ask-file', onAsk: ask => { asks.push(ask.kind); return 'acceptForSession'; } });
  assert.deepEqual(seen, ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
  assert.deepEqual(await replies(), [{ decision: 'accept', extra: 'as given' }, { decision: 'acceptForSession' }], 'what it leaves undecided goes on to onAsk');
  assert.deepEqual(asks, ['file-change']);
});

test('the store: an ask is recorded on the turn, waits for answer(), and is declined by default', async t => {
  const dir = await tempDir(t), got = [], events = [];
  // The default policy: decline at once. A host that does nothing about asks never has a turn waiting.
  const plain = createConversationStore({ dir: path.join(dir, 'plain'), run: async (turn, lane, signal, tools) => ({ message: String(await tools.ask({ kind: 'command', title: 'Run a command', options: [{ id: 'accept', label: 'Allow' }] })) }) });
  const first = await plain.send('k', { user: 'x' }); await settled(first);
  assert.equal(first.message, 'decline');
  assert.deepEqual(first.asks.map(a => [a.status, a.answer]), [['answered', 'decline']]);
  // A host that shows asks to a person: the policy answers what it can and leaves the rest waiting.
  const store = createConversationStore({ dir, askTimeout: 60000, onAsk: ask => ask.kind === 'permissions' ? 'accept' : undefined,
    run: async (turn, lane, signal, tools) => {
      got.push(await tools.ask({ id: 'ask-1', kind: 'permissions', title: 'Grant more access', options: [{ id: 'accept', label: 'Allow' }] }));
      got.push(await tools.ask({ id: 'ask-2', provider: 'codex-app-server', method: 'item/tool/requestUserInput', kind: 'input', title: 'A question', detail: {}, options: [{ id: 'accept', label: 'Answer' }, { id: 'decline', label: 'No' }, 'junk'],
        questions: [{ id: 'token', question: 'The token?', secret: true }] }));
      got.push(await tools.ask({ id: 'ask-2', kind: 'command', title: 'Run a command', detail: { command: 'ls' }, options: [] }, { timeout: 30 }));
      got.push(await tools.ask({ kind: 'command', title: 'Wait for the stop', options: [] }));
      return { message: 'unreachable' };
    } });
  await store.subscribe('k', {}, event => events.push(event)).ready;
  const turn = await store.send('k', { user: 'go' });
  await until(() => turn.asks?.[1]?.status === 'pending');
  assert.deepEqual(turn.asks[0], { id: 'ask-1', kind: 'permissions', title: 'Grant more access', detail: {}, options: [{ id: 'accept', label: 'Allow' }], status: 'answered', askedAt: turn.asks[0].askedAt, answer: 'accept', answeredAt: turn.asks[0].answeredAt });
  assert.deepEqual(turn.asks[1].options, [{ id: 'accept', label: 'Answer' }, { id: 'decline', label: 'No' }]);
  await store.flush();
  assert.equal((await readConversation(dir, 'k')).turns[0].asks[1].status, 'pending', 'a waiting ask is on disk, for a browser that loads the conversation');
  await assert.rejects(store.answer('k', turn.id, 'no-such-ask', 'accept'), { code: 'not-found' });
  await assert.rejects(store.answer('k', turn.id, 'ask-1', 'accept'), { code: 'answered', status: 409 });
  await assert.rejects(store.answer('k', turn.id, 'ask-2', undefined), { code: 'invalid' });
  assert.equal(await store.answer('k', turn.id, 'ask-2', { option: 'accept', answers: { token: 's3cret-value' } }), turn);
  assert.deepEqual(got[1], { option: 'accept', answers: { token: 's3cret-value' } }, 'the run receives the whole answer');
  assert.equal(turn.asks[1].answer, 'accept');
  // The third ask reused an id and gave itself 30 ms: it gets an id of its own, and expires as a decline.
  await until(() => turn.asks[2]?.status === 'expired');
  assert.deepEqual([turn.asks[2].id === 'ask-2', turn.asks[2].answer, got[2]], [false, 'decline', 'decline']);
  await until(() => turn.asks[3]?.status === 'pending');
  await store.stop('k', turn.id); await settled(turn);
  assert.deepEqual([turn.status, turn.asks[3].status, turn.asks[3].answer, got[3]], ['stopped', 'cancelled', 'cancel', 'cancel'], 'stopping the turn answers what was still open');
  await assert.rejects(store.answer('k', turn.id, turn.asks[3].id, 'accept'), { code: 'answered' });
  await store.flush();
  const kinds = events.map(event => event.type);
  assert.ok(kinds.filter(kind => kind === 'turn.ask').length >= 5, `asked and answered are events: ${kinds}`);
  assert.ok(!JSON.stringify([events, await readConversation(dir, 'k')]).includes('s3cret-value'), 'what a person typed in answer is never stored or sent on');
});

test('the store: an ask left waiting by a dead process is cancelled when the conversation is next opened', async t => {
  const dir = await tempDir(t), asked = deferred();
  const dead = create({ dir, onAsk: () => undefined, run: async (turn, lane, signal, tools) => { asked.resolve(); await tools.ask({ kind: 'command', title: 'Run a command', options: [] }); return { message: '' }; } });
  const turn = await dead.send('k', { user: 'x' });
  await asked.promise; await until(() => turn.asks?.[0]?.status === 'pending'); await dead.flush();
  // Nothing more is written by that store: as if its process had died here. (Its run is left waiting; the folder now belongs to the next store.)
  const store = createConversationStore({ dir, run: async () => ({ message: '' }) });
  const recovered = (await store.open('k')).turns[0];
  assert.deepEqual([recovered.status, recovered.asks[0].status, recovered.asks[0].answer], ['failed', 'cancelled', 'cancel']);
  await assert.rejects(store.answer('k', recovered.id, recovered.asks[0].id, 'accept'), { code: 'answered' });
  await dead.stop('k', turn.id).catch(() => {});
});

test('end to end: a Codex approval and an ACP permission are both answered through store.answer()', async t => {
  const dir = await tempDir(t), log = path.join(dir, 'log.jsonl'), acpLog = path.join(dir, 'acp.jsonl');
  const providers = {
    codex: new CodexAppServerProvider({ command: [process.execPath, fixture('fake-app-server.mjs')], workDir: path.join(dir, 'work'), env: { ...process.env, FAKE_LOG: log } }),
    acp: new AcpProvider({ command: [process.execPath, fixture('fake-acp-agent.mjs')], workDir: path.join(dir, 'acp-work'), env: { ...process.env, FAKE_LOG: acpLog, FAKE_ACP: '{}', FAKE_STORE: path.join(dir, 'sessions.json') } }) };
  t.after(() => { providers.codex.close(); providers.acp.close(); });
  const store = createConversationStore({ dir: path.join(dir, 'chats'), onAsk: () => undefined, run: async (turn, lane, signal, tools) => {
    const result = await providers[turn.agent].run({ key: lane.id, input: turn.user, approvalPolicy: 'on-request', idleTimeout: 150, onEvent: tools.activity, onAsk: tools.ask, signal });
    return { message: result.message };
  } });
  const approval = await store.send('codex', { user: 'ask-command', agent: 'codex' });
  await until(() => approval.asks?.[0]?.status === 'pending');
  assert.deepEqual([approval.asks[0].kind, approval.asks[0].provider, approval.asks[0].detail.command], ['command', 'codex-app-server', 'touch /etc/x']);
  await store.answer('codex', approval.id, approval.asks[0].id, 'accept');
  await settled(approval);
  assert.deepEqual([approval.status, approval.message], ['succeeded', '[{"decision":"accept"}]']);
  const permission = await store.send('acp', { user: 'permission edit /work/a.md', agent: 'acp' });
  await until(() => permission.asks?.[0]?.status === 'pending');
  assert.deepEqual(permission.asks[0].options, [{ id: 'yes-always', label: 'Always', kind: 'allow_always' }, { id: 'yes', label: 'Allow', kind: 'allow_once' }, { id: 'no', label: 'Reject', kind: 'reject_once' }]);
  assert.deepEqual([permission.asks[0].kind, permission.asks[0].title, permission.asks[0].detail], ['permission', 'Touching /work/a.md', { toolKind: 'edit', paths: ['/work/a.md'], diffs: 1 }]);
  await store.answer('acp', permission.id, permission.asks[0].id, 'accept');
  await settled(permission);
  assert.equal(permission.status, 'succeeded');
  const answers = (await readLines(acpLog)).filter(m => m.method === undefined && m.id > 9000).map(m => m.result);
  assert.deepEqual(answers, [{ outcome: { outcome: 'selected', optionId: 'yes' } }], '"accept" is the agent\'s allow-once option, never widened to "always"');
  // Declined by the person: each agent hears it in its own words.
  const refused = await store.send('acp', { user: 'permission edit /work/b.md', agent: 'acp' });
  await until(() => refused.asks?.[0]?.status === 'pending');
  await store.answer('acp', refused.id, refused.asks[0].id, 'decline');
  await settled(refused);
  assert.deepEqual((await readLines(acpLog)).filter(m => m.method === undefined && m.id > 9000).at(-1).result, { outcome: { outcome: 'selected', optionId: 'no' } });
});
