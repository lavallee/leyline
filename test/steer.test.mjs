// Steering: more input sent into a turn that is already running.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexAppServerProvider } from '../server/providers/codex-app-server.mjs';
import { AcpProvider, CliOneshotProvider, HttpChatProvider, ProviderError } from '../server/providers/index.mjs';
import { createConversationStore as create, readConversation } from '../server/conversations.mjs';
import { fixture, tempDir, until, readLines, beforeCleanup, deferred } from './helpers.mjs';

const createConversationStore = options => { const store = create(options); beforeCleanup(() => store.close()); return store; };
const settled = turn => until(() => ['succeeded', 'failed', 'stopped'].includes(turn.status));
async function codex(t) {
  const dir = await tempDir(t), log = path.join(dir, 'log.jsonl');
  const provider = new CodexAppServerProvider({ command: [process.execPath, fixture('fake-app-server.mjs')], workDir: path.join(dir, 'work'), env: { ...process.env, FAKE_LOG: log } });
  t.after(() => provider.close());
  return { provider, dir, sent: async method => (await readLines(log)).filter(m => m.method === method) };
}

test('Codex: steer sends input into the running turn, addressed to that turn', async t => {
  const { provider, sent } = await codex(t);
  assert.equal(provider.capabilities.steer, true);
  const run = provider.run({ key: 'doc:main', input: 'a steerable task' });
  // Sent at once, before the agent has even named the turn: it waits for the name rather than failing.
  const first = await provider.steer('doc:main', 'Use the second draft instead.', { clientUserMessageId: 'msg-1' });
  const [start] = await sent('turn/start'), [steer] = await sent('turn/steer');
  assert.deepEqual(steer.params, { threadId: start.params.threadId, input: [{ type: 'text', text: 'Use the second draft instead.', text_elements: [] }], expectedTurnId: first.turnId, clientUserMessageId: 'msg-1' });
  assert.match(first.turnId, /^turn\d+$/);
  await provider.steer('doc:main', ['Two parts.', 'Still going.']);
  assert.deepEqual((await sent('turn/steer'))[1].params.input.map(part => part.text), ['Two parts.', 'Still going.']);
  // Two more, back to back: the first ends the turn, so the second arrives for a turn that is no longer the active one.
  const last = provider.steer('doc:main', 'finish now'), late = provider.steer('doc:main', 'one more thing');
  assert.equal((await run).message, 'steered: finish now');
  await last;
  await assert.rejects(late, error => error instanceof ProviderError && error.code === 'ended' && error.status === 409, 'the agent refused it, and the host is told why: the turn has ended');
  await assert.rejects(provider.steer('doc:main', 'too late'), { code: 'ended' });
  await assert.rejects(provider.steer('never-ran', 'hello'), { code: 'ended' });
  await assert.rejects(provider.steer('doc:main', ''), { code: 'config' });
  assert.equal((await sent('turn/steer')).length, 4, 'with no run to address, nothing is sent at all');
  // A stopped run takes no more input.
  const stopping = provider.run({ key: 'other', input: 'a steerable task' });
  await provider.steer('other', 'first');
  provider.cancel('other');
  await assert.rejects(provider.steer('other', 'after the stop'), { code: 'ended' });
  await assert.rejects(stopping, { code: 'stopped' });
});

test('steer is a capability: the adapters that cannot do it say so and have no method', () => {
  const others = [new AcpProvider({ command: ['/bin/true'], workDir: '/tmp/unused' }), new CliOneshotProvider({ preset: 'command', command: ['true'] }), new HttpChatProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm' })];
  for (const provider of others) { assert.equal(provider.capabilities.steer, false, provider.name); assert.equal(provider.steer, undefined, provider.name); }
});

test('the store: steer() reaches the run, is recorded on the turn, and says when the turn has already ended', async t => {
  const { provider, dir, sent } = await codex(t), events = [], gate = deferred();
  const store = createConversationStore({ dir: path.join(dir, 'chats'), maxLanes: 1, run: async (turn, lane, signal, tools) => {
    if (turn.user === 'plain') { await gate.promise; return { message: 'no steering here' }; }
    if (turn.user === 'broken') { tools.steering(() => { throw new Error('the wire fell out'); }); await gate.promise; return { message: '' }; }
    tools.steering(input => provider.steer(lane.id, input));
    return { message: (await provider.run({ key: lane.id, input: 'a steerable task', signal })).message };
  } });
  await store.subscribe('k', {}, event => events.push(event)).ready;
  const turn = await store.send('k', { user: 'work' }), next = await store.send('k', { user: 'plain' }), broken = await store.send('k', { user: 'broken' });
  await until(() => turn.status === 'running');
  assert.deepEqual(await store.steer('k', next.id, 'too early'), { steered: false, reason: 'waiting', turn: next });
  const result = await store.steer('k', turn.id, 'Look at the appendix too.');
  assert.deepEqual([result.steered, result.turn], [true, turn]);
  assert.deepEqual(turn.steers, [{ id: turn.steers[0].id, text: 'Look at the appendix too.', at: turn.steers[0].at }]);
  assert.deepEqual((await readConversation(path.join(dir, 'chats'), 'k')).turns[0].steers, turn.steers, 'on disk when steer() resolves');
  const event = events.find(e => e.type === 'turn.steer');
  assert.deepEqual([event.turnId, event.set.steers.length], [turn.id, 1]);
  await store.steer('k', turn.id, ['Then', 'finish now']);
  await settled(turn);
  assert.equal(turn.message, 'steered: Then | finish now');
  assert.deepEqual(turn.steers.map(s => s.text), ['Look at the appendix too.', 'Then\n\nfinish now']);
  // The turn has ended: the host is told, and can send the text as a new request instead.
  assert.deepEqual(await store.steer('k', turn.id, 'one more thing'), { steered: false, reason: 'ended', turn });
  assert.equal(turn.steers.length, 2);
  assert.equal((await sent('turn/steer')).length, 2, 'nothing was sent for a turn that had ended');
  // A run that did not say how to steer it, and one whose provider fails.
  await until(() => next.status === 'running');
  assert.deepEqual(await store.steer('k', next.id, 'hello'), { steered: false, reason: 'unsupported', turn: next });
  await assert.rejects(store.steer('k', next.id, ''), { code: 'invalid' });
  await assert.rejects(store.steer('k', 'no-such-turn', 'x'), { code: 'not-found' });
  gate.resolve(); await settled(next);
  const again = await store.send('k', { user: 'work' });
  await settled(broken);
  await until(() => again.status === 'running');
  // Steered as it ends: the provider refuses with 'ended', and the store reports that rather than an error.
  const finishing = store.steer('k', again.id, 'finish now'), racing = store.steer('k', again.id, 'and this');
  assert.equal((await finishing).steered, true);
  assert.deepEqual(await racing, { steered: false, reason: 'ended', turn: again });
  await settled(again);
  assert.deepEqual(again.steers.map(s => s.text), ['finish now']);
});

test('the store: a provider error that is not "ended" is the caller\'s to see', async t => {
  const dir = await tempDir(t), gate = deferred();
  const store = createConversationStore({ dir, run: async (turn, lane, signal, tools) => { tools.steering(() => { throw new ProviderError('The agent connection stopped.', 'unavailable'); }); await gate.promise; return { message: '' }; } });
  const turn = await store.send('k', { user: 'x' });
  await until(() => turn.status === 'running');
  await assert.rejects(store.steer('k', turn.id, 'hello'), { code: 'unavailable' });
  assert.equal(turn.steers, undefined, 'a steer that did not happen is not recorded');
  gate.resolve(); await settled(turn);
  // The store's own `steer` option does the same for every run; a run's tools.steering takes its place for that run.
  const calls = [], release = deferred();
  const other = createConversationStore({ dir: path.join(dir, 'other'), steer: async (input, turn, lane) => { calls.push([input, turn.user, lane.id]); },
    run: async (turn, lane, signal, tools) => { if (turn.user === 'own') tools.steering(async input => { calls.push(['own way', input]); }); await release.promise; return { message: '' }; } });
  const one = await other.send('a', { user: 'by option' }), two = await other.send('b', { user: 'own' });
  assert.equal((await other.steer('a', one.id, 'left a bit')).steered, true);
  assert.equal((await other.steer('b', two.id, ['right', 'a bit'])).steered, true);
  assert.deepEqual(calls, [['left a bit', 'by option', 'a:main'], ['own way', ['right', 'a bit']]]);
  release.resolve(); await settled(one); await settled(two);
});
