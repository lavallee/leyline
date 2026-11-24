// Streaming: reply text and command output as they arrive, gathered into a few events,
// from the Codex adapter and the ACP adapter alike, through the store's log.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexAppServerProvider } from '../server/providers/codex-app-server.mjs';
import { AcpProvider } from '../server/providers/acp.mjs';
import { createBatcher, foldActivity } from '../server/providers/contract.mjs';
import { createConversationStore, readConversation } from '../server/conversations.mjs';
import { applyEvent } from '../server/events.mjs';
import { fixture, tempDir, until, beforeCleanup, deferred } from './helpers.mjs';

const codex = (dir, options = {}) => new CodexAppServerProvider({ command: [process.execPath, fixture('fake-app-server.mjs')], workDir: path.join(dir, 'work'), ...options });
const acp = (dir, options = {}) => new AcpProvider({ command: [process.execPath, fixture('fake-acp-agent.mjs')], workDir: path.join(dir, 'acp-work'),
  env: { ...process.env, FAKE_ACP: '{}', FAKE_STORE: path.join(dir, 'sessions.json') }, ...options });
const settled = turn => until(() => ['succeeded', 'failed', 'stopped'].includes(turn.status));
const plain = value => JSON.parse(JSON.stringify(value));

test('the batcher joins pieces by key, hands them over by time or by size, and keeps their order', async () => {
  const got = [], batch = createBatcher({ ms: 10000, chars: 10 });
  batch.add('a', 'one ', text => got.push(['a', text]));
  batch.add('b', 'x', text => got.push(['b', text]));
  batch.add('a', 'two', text => got.push(['a', text]));
  assert.deepEqual(got, [], 'nothing yet: under the size, inside the time');
  batch.add('a', ' three', text => got.push(['a', text]));
  assert.deepEqual(got, [['a', 'one two three'], ['b', 'x']], 'the size was reached: everything goes, first key first');
  batch.add('a', 'tail', text => got.push(['a', text]));
  batch.flush(); batch.flush();
  assert.deepEqual(got.at(-1), ['a', 'tail']);
  assert.equal(got.length, 3);
  const timed = [], soon = createBatcher({ ms: 1, chars: 1000 });
  soon.add('k', 'by ', text => timed.push(text)); soon.add('k', 'time', text => timed.push(text));
  await until(() => timed.length === 1);
  assert.deepEqual(timed, ['by time']);
  const straight = [], off = createBatcher({ ms: 0 });
  off.add('k', 'a', text => straight.push(text)); off.add('k', '', text => straight.push(text)); off.add('k', 'b', () => { throw new Error('a consumer broke'); }); off.add('k', 'c', text => straight.push(text));
  assert.deepEqual(straight, ['a', 'c'], 'ms 0: each piece as it comes; a throwing consumer breaks nothing');
});

test('Codex: the reply arrives as text deltas, commentary as a growing note, command output only when asked for', async t => {
  const dir = await tempDir(t), provider = codex(dir, { streamBatch: { ms: 0 } });
  t.after(() => provider.close());
  assert.equal(provider.capabilities.textStream, true);
  const text = [], events = [], items = [];
  const result = await provider.run({ key: 'a', input: 'stream it', streamOutput: true, onText: (piece, at) => text.push([piece, at.segment]), onEvent: event => { events.push(event); foldActivity(items, event); } });
  assert.equal(result.message, 'The tests pass.');
  assert.deepEqual(text, [['Half', 0], ['way ', 0], ['there.', 0], ['The ', 1], ['tests ', 1], ['pass.', 1]], 'each message of the turn is a segment; commentary and a delta with no item are not reply text');
  const by = id => items.find(item => item.id === id);
  assert.deepEqual(events.filter(e => e.id === 'n1').map(e => e.append ?? e.text), ['Looking ', 'first.', 'Looking first.']);
  assert.deepEqual([by('n1').title, by('n1').text, by('n1').status], ['Agent note', 'Looking first.', 'done']);
  assert.deepEqual(events.filter(e => e.id === 'x1').map(e => e.append), [undefined, 'compiling\n', 'testing\n', 'ok\n', undefined]);
  assert.deepEqual([by('x1').text, by('x1').status, by('x1').command], ['compiling\ntesting\nok\n', 'done', 'make test'], 'the output is there once, as it came');
  assert.equal(by('s2-note').text, 'Halfway there.', 'the earlier message still ends as a note');
  // Without streamOutput the activity list is what it always was: the tail of the output when the command ends.
  const quiet = [], before = [];
  await provider.run({ key: 'b', input: 'stream it', onEvent: event => { quiet.push(event); foldActivity(before, event); } });
  assert.ok(quiet.filter(e => e.id === 'x1').every(e => e.append === undefined));
  assert.equal(before.find(item => item.id === 'x1').text, 'compiling\ntesting\nok\n');
  // The default gathers deltas: fewer calls, the same text, and nothing out of order with the events around it.
  const gathered = codex(dir), pieces = [], order = [];
  t.after(() => gathered.close());
  const again = await gathered.run({ key: 'c', input: 'stream it', streamOutput: true, onText: (piece, at) => { pieces.push([piece, at.segment]); order.push(`text${at.segment}`); }, onEvent: event => order.push(`${event.id}:${event.append ? 'append' : event.status}`) });
  assert.deepEqual(pieces, [['Halfway there.', 0], ['The tests pass.', 1]]);
  assert.deepEqual(order.filter(name => /^(text|x1|s2-note)/.test(name)), ['x1:running', 'x1:append', 'x1:done', 'text0', 'text1', 's2-note:done']);
  assert.equal(again.message, 'The tests pass.');
});

test('both adapters flow through the store the same way: text events, a preview while it runs, the message at the end', async t => {
  const dir = await tempDir(t);
  const providers = { codex: codex(dir), acp: acp(dir) }, release = { codex: deferred(), acp: deferred() };
  t.after(() => { providers.codex.close(); providers.acp.close(); });
  const store = createConversationStore({ dir: path.join(dir, 'chats'), coalesce: 5, saveDelay: 20, run: async (turn, lane, signal, tools) => {
    const result = await providers[turn.agent].run({ key: lane.id, input: turn.agent === 'codex' ? 'stream it' : 'slow', streamOutput: true, onEvent: tools.activity, onText: tools.text, signal });
    await release[turn.agent].promise;                       // held here so the test can look at the turn while it is still running
    return { message: result.message, provenance: result.provenance };
  } });
  beforeCleanup(() => store.close());
  for (const agent of ['codex', 'acp']) {
    const events = [], start = await store.snapshot(agent), copy = start.conversation;
    await store.subscribe(agent, { after: start.cursor }, event => { events.push(event); assert.ok(applyEvent(copy, plain(event))); }).ready;
    const turn = await store.send(agent, { user: 'go', agent });
    const whole = agent === 'codex' ? 'The tests pass.' : '0 1 2 3 4 5 ';
    await until(() => turn.preview === whole);
    assert.deepEqual(copy.turns[0] && plain(store.get(agent)).turns[0].preview, whole);
    await until(() => copy.turns[0].preview === whole);
    release[agent].resolve(); await settled(turn);
    assert.equal(turn.status, 'succeeded');
    assert.equal(turn.message, whole);
    assert.equal(turn.preview, undefined);
    const texts = events.filter(event => event.type === 'turn.text');
    assert.ok(texts.length >= 1 && texts.length <= 8, `${agent}: gathered into a few events, not one per piece: ${texts.length}`);
    assert.ok(texts.every(event => typeof (event.append?.preview ?? event.set?.preview) === 'string'));
    assert.deepEqual(copy, plain(store.get(agent)), `${agent}: a copy kept from the events is the conversation`);
    await store.flush();
    assert.deepEqual(await readConversation(path.join(dir, 'chats'), agent), plain(store.get(agent)), `${agent}: and so is what is on disk`);
    if (agent === 'codex') assert.equal(turn.activities.find(item => item.id === 'x1').text, 'compiling\ntesting\nok\n');
  }
});
