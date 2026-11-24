// The append-only event log behind the conversation store: what is on disk, how it is
// read back, what a crash can leave, and how a host's own changes to a turn are recorded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createConversationStore as create, fileNameFor, logNameFor, readConversation } from '../server/conversations.mjs';
import { applyEvent, parseCursor, formatCursor, EVENT_TYPES } from '../server/events.mjs';
import { tempDir, until, deferred, beforeCleanup, readLines } from './helpers.mjs';

const createConversationStore = options => { const store = create(options); beforeCleanup(() => store.close()); return store; };
const settled = turn => until(() => ['succeeded', 'failed', 'stopped'].includes(turn.status));
const plain = value => JSON.parse(JSON.stringify(value));
const snapshotOf = async (dir, key) => JSON.parse(await readFile(path.join(dir, fileNameFor(key)), 'utf8'));
const logOf = (dir, key) => readLines(path.join(dir, logNameFor(key)));
const sizeOf = async file => (await stat(file)).size;

test('an update appends to the log and leaves the snapshot alone', async t => {
  const dir = await tempDir(t), gate = deferred(), steps = [];
  const store = createConversationStore({ dir, saveDelay: 1, run: async (turn, lane, signal, tools) => {
    if (turn.user !== 'slow') return { message: 'ok' };
    for (let i = 0; i < 5; i++) { tools.activity({ id: 'r', kind: 'reasoning', append: `step ${i} of the reading. `, status: 'running' }); await store.save('k'); steps.push(await sizeOf(path.join(dir, logNameFor('k')))); }
    await gate.promise;
    return { message: 'done' };
  } });
  await settled(await store.send('k', { user: 'first' })); await store.flush();
  const before = await readFile(path.join(dir, 'k.json'), 'utf8');
  const turn = await store.send('k', { user: 'slow' });
  await until(() => steps.length === 5);
  assert.equal(await readFile(path.join(dir, 'k.json'), 'utf8'), before, 'the snapshot was not rewritten');
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] > steps[i - 1], 'each update made the log longer');
  assert.ok(steps[4] - steps[3] < 400, `an update costs a line, not the conversation: ${steps[4] - steps[3]} bytes`);
  assert.deepEqual(await readConversation(dir, 'k'), plain(store.get('k')), 'snapshot and log together are the conversation');
  gate.resolve(); await settled(turn); await store.flush();
  const [header, ...events] = await logOf(dir, 'k');
  assert.deepEqual(header, { log: 1, key: 'k', base: (await snapshotOf(dir, 'k')).eventSeq });
  assert.deepEqual(events.map(e => e.seq), events.map((_, i) => header.base + 1 + i), 'numbered one after another');
  assert.ok(events.every(e => EVENT_TYPES.includes(e.type) && typeof e.at === 'string'));
  assert.deepEqual([...new Set(events.map(e => e.type))], ['turn.status', 'turn.finished', 'turn.created', 'turn.activity']);
  const append = events.filter(e => e.type === 'turn.activity').at(-1);
  assert.deepEqual(append.activities, [{ id: 'r', append: 'step 4 of the reading. ' }], 'text that grows is recorded as what was added');
});

test('a file written by an earlier version is read as it is, and gets a log when it changes', async t => {
  const dir = await tempDir(t);
  const old = JSON.stringify({ key: 'page', page: 'home', turns: [{ id: 'a', user: 'old', status: 'succeeded', message: 'fine', activities: [{ id: 'x', kind: 'activity', text: 'ran', status: 'done' }], proposals: [{ key: 'e0', applied: true }] }] }, null, 2);
  await writeFile(path.join(dir, 'page.json'), old);
  let store = createConversationStore({ dir, run: async () => ({ message: 'new reply' }) });
  const conversation = await store.open('page');
  assert.equal(conversation.turns[0].message, 'fine');
  await store.flush();
  assert.equal(await readFile(path.join(dir, 'page.json'), 'utf8'), old, 'opening it writes nothing');
  assert.deepEqual(await readdir(dir), ['page.json']);
  await settled(await store.send('page', { user: 'next' })); await store.flush();
  assert.equal(await readFile(path.join(dir, 'page.json'), 'utf8'), old, 'the old file is still the snapshot');
  assert.deepEqual((await logOf(dir, 'page'))[0], { log: 1, key: 'page', base: 0 });
  assert.deepEqual((await readConversation(dir, 'page')).turns.map(t => t.message), ['fine', 'new reply']);
  await store.close();
  const after = await snapshotOf(dir, 'page');
  assert.ok(after.eventSeq > 0 && after.page === 'home' && after.turns.length === 2, 'close() folds the log into the snapshot');
  assert.equal((await logOf(dir, 'page')).length, 1, 'and leaves a log with only its header');
  store = createConversationStore({ dir, run: async () => ({ message: '' }) });
  assert.deepEqual(plain(await store.open('page')), { ...after, eventSeq: undefined, key: 'page' } && (({ eventSeq, ...rest }) => rest)(after));
});

test('a last line cut short by a crash is left out, cut off, and the next write starts clean', async t => {
  const dir = await tempDir(t), errors = [];
  let store = create({ dir, run: async () => ({ message: 'one' }) });
  await settled(await store.send('k', { user: 'a' })); await store.flush();
  const whole = plain(store.get('k')), size = await sizeOf(path.join(dir, logNameFor('k')));
  // As a process killed in the middle of an append leaves it: some of a line, no line ending.
  await appendFile(path.join(dir, logNameFor('k')), '{"seq":99,"at":"2026-01-01T00:00:00.000Z","type":"turn.patch","turnId":"');
  assert.deepEqual(await readConversation(dir, 'k'), whole, 'a reader ignores the unfinished line');
  store = createConversationStore({ dir, onError: e => errors.push(e), run: async () => ({ message: 'two' }) });
  assert.deepEqual(plain(await store.open('k')), whole);
  assert.equal(await sizeOf(path.join(dir, logNameFor('k'))), size, 'the unfinished line was cut off');
  await settled(await store.send('k', { user: 'b' })); await store.flush();
  assert.deepEqual((await readConversation(dir, 'k')).turns.map(t => t.message), ['one', 'two']);
  assert.deepEqual(errors, [], 'none of this is an error');
  assert.deepEqual((await readdir(dir)).sort(), ['k.events.jsonl', 'k.json'], 'nothing was moved aside');
});

test('a crash between writing a snapshot and starting the new log loses nothing and repeats nothing', async t => {
  const dir = await tempDir(t);
  let store = create({ dir, run: async () => ({ message: 'ok' }) });
  for (const user of ['a', 'b']) await settled(await store.send('k', { user }));
  await store.flush();
  const log = await readFile(path.join(dir, logNameFor('k')));
  await store.close();                                       // the snapshot now holds everything
  await writeFile(path.join(dir, logNameFor('k')), log);     // and the old log is back, as if it had never been replaced
  const whole = (({ eventSeq, ...rest }) => rest)(await snapshotOf(dir, 'k'));
  assert.deepEqual(await readConversation(dir, 'k'), whole);
  store = createConversationStore({ dir, run: async () => ({ message: 'ok' }) });
  assert.deepEqual(plain(await store.open('k')), whole, 'events the snapshot already holds are skipped');
  await settled(await store.send('k', { user: 'c' })); await store.flush();
  assert.deepEqual((await readConversation(dir, 'k')).turns.map(t => t.user), ['a', 'b', 'c']);
});

test('a damaged log is moved aside and reported; what could be replayed is kept', async t => {
  const dir = await tempDir(t), errors = [];
  let store = create({ dir, run: async () => ({ message: 'ok' }) });
  for (const user of ['a', 'b', 'c']) await settled(await store.send('k', { user }));
  await store.flush();
  const file = path.join(dir, logNameFor('k')), lines = (await readFile(file, 'utf8')).split('\n');
  const at = lines.findIndex(line => line.includes('"turn.created"') && line.includes('"user":"c"'));
  lines.splice(at, 0, '{ this line is not JSON');
  await writeFile(file, lines.join('\n'));
  await assert.rejects(readConversation(dir, 'k'), { code: 'corrupt' });
  store = createConversationStore({ dir, onError: e => errors.push(e), run: async () => ({ message: 'ok' }) });
  const conversation = await store.open('k');
  assert.deepEqual(conversation.turns.map(t => t.user), ['a', 'b'], 'everything before the damage');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'corrupt');
  assert.ok(path.basename(errors[0].file).startsWith('k.events.jsonl.corrupt-'));
  assert.equal(await readFile(errors[0].file, 'utf8'), lines.join('\n'), 'kept byte for byte');
  await store.flush();
  assert.deepEqual((await snapshotOf(dir, 'k')).turns.map(t => t.user), ['a', 'b'], 'and a snapshot of what was recovered was written');
  await settled(await store.send('k', { user: 'd' })); await store.flush();
  assert.deepEqual((await readConversation(dir, 'k')).turns.map(t => t.user), ['a', 'b', 'd']);
});

test('a log for another conversation, or one that outran its snapshot, is moved aside too', async t => {
  const dir = await tempDir(t), errors = [];
  await writeFile(path.join(dir, logNameFor('mine')), `${JSON.stringify({ log: 1, key: 'theirs', base: 0 })}\n${JSON.stringify({ seq: 1, type: 'turn.created', turn: { id: 'z', user: 'theirs', status: 'succeeded' } })}\n`);
  await writeFile(path.join(dir, logNameFor('ahead')), `${JSON.stringify({ log: 1, key: 'ahead', base: 40 })}\n${JSON.stringify({ seq: 41, type: 'reset' })}\n`);
  await writeFile(path.join(dir, logNameFor('alone')), `${JSON.stringify({ log: 1, key: 'alone', base: 0 })}\n${JSON.stringify({ seq: 1, type: 'turn.created', turn: { id: 'y', user: 'kept', status: 'succeeded', message: '' } })}\n`);
  const store = createConversationStore({ dir, onError: e => errors.push(e), run: async () => ({ message: '' }) });
  assert.deepEqual((await store.open('mine')).turns, []);
  assert.deepEqual((await store.open('ahead')).turns, []);
  assert.deepEqual((await store.open('alone')).turns.map(t => t.user), ['kept'], 'a log with no snapshot yet is a whole conversation');
  const names = await readdir(dir);
  assert.ok(names.some(name => name.startsWith(`${logNameFor('mine')}.foreign-`)) && names.some(name => name.startsWith(`${logNameFor('ahead')}.corrupt-`)), String(names));
  assert.deepEqual(errors.map(e => e.code), ['corrupt', 'corrupt']);
});

test('compaction folds the log into a new snapshot while turns run, and nothing is lost', async t => {
  const dir = await tempDir(t), gate = deferred();
  const store = createConversationStore({ dir, saveDelay: 0, compactEvery: 8, run: async (turn, lane, signal, tools) => {
    for (let i = 0; i < 40; i++) { tools.activity({ id: `c${i}`, kind: 'activity', command: `step ${i}`, status: 'done' }); await store.save('k'); }
    await gate.promise;
    return { message: 'done' };
  } });
  const turn = await store.send('k', { user: 'work' });
  await until(() => turn.activities.length === 40);
  await store.flush();
  const snapshot = await snapshotOf(dir, 'k'), lines = await logOf(dir, 'k');
  assert.ok(snapshot.eventSeq >= 32, `the snapshot moved forward: ${snapshot.eventSeq}`);
  assert.ok(lines.length <= 9, `the log stays short: ${lines.length} lines`);
  assert.equal(lines[0].base, snapshot.eventSeq);
  assert.deepEqual(await readConversation(dir, 'k'), plain(store.get('k')));
  gate.resolve(); await settled(turn); await store.flush();
  assert.deepEqual(await readConversation(dir, 'k'), plain(store.get('k')));
  await store.compact('k');
  assert.equal((await logOf(dir, 'k')).length, 1);
  assert.deepEqual((({ eventSeq, ...rest }) => rest)(await snapshotOf(dir, 'k')), plain(store.get('k')));
});

test('update() records a change to a finished turn; save() still finds changes made directly', async t => {
  const dir = await tempDir(t), events = [];
  const store = createConversationStore({ dir, run: async turn => ({ message: 'ok', proposals: [{ key: 'e0', fate: 'applied' }, { key: 'e1', fate: 'applied' }] }) });
  const first = await store.send('k', { user: 'a' }); await settled(first);
  const second = await store.send('k', { user: 'b' }); await settled(second);
  await store.flush();
  await store.subscribe('k', {}, event => events.push(event)).ready;
  // The supported way: one turn, compared alone.
  assert.equal(await store.update('k', first.id, turn => { turn.proposals[1].fate = 'undone'; }), first);
  assert.deepEqual(events.map(e => [e.type, e.turnId, e.set]), [['turn.proposals', first.id, { proposals: [{ key: 'e0', fate: 'applied' }, { key: 'e1', fate: 'undone' }] }]]);
  assert.equal((await readConversation(dir, 'k')).turns[0].proposals[1].fate, 'undone', 'on disk when update() resolves');
  // What Copycat does today: change turns in place, then save(key).
  second.proposals[0].fate = 'dismissed'; second.note = 'x'.repeat(40); delete second.lane; store.get('k').title = 'Named';
  await store.save('k');
  assert.deepEqual(await readConversation(dir, 'k'), plain(store.get('k')));
  assert.deepEqual(events.slice(1).map(e => e.type), ['turn.patch', 'conversation.patch']);
  assert.deepEqual(events[1].unset, ['lane']);
  // A longer string that starts with the old one is recorded as what was added.
  await store.update('k', second.id, turn => { turn.note += ' and more'; });
  assert.deepEqual(events.at(-1).append, { note: ' and more' });
  await store.save('k');
  assert.equal(events.length, 4, 'a save with nothing changed records nothing');
  await assert.rejects(store.update('k', 'no-such-turn', () => {}), { code: 'not-found' });
  await assert.rejects(store.update('k', first.id), { code: 'invalid' });
  // A change nobody announced is not lost: it is found when the log is next folded into a snapshot, and at close().
  first.proposals[0].fate = 'stale';
  await store.close();
  assert.equal((await snapshotOf(dir, 'k')).turns[0].proposals[0].fate, 'stale');
});

test('whatever a host does to a turn, disk and memory agree after save()', async t => {
  for (const seed of [1, 2, 3, 4]) {
    let state = seed; const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
    const pick = list => list[Math.floor(next() * list.length)];
    const dir = await tempDir(t), mirror = { key: 'k', turns: [] }, problems = [];
    const store = createConversationStore({ dir, compactEvery: 25, onError: e => problems.push(e.message), run: async turn => ({ message: `reply to ${turn.user}`, proposals: [{ key: 'e0' }] }) });
    await store.subscribe('k', { after: 0 }, event => { if (!applyEvent(mirror, plain(event))) problems.push(`an event did not apply: ${event.type}`); }).ready;
    for (let i = 0; i < 4; i++) await settled(await store.send('k', { user: `request ${i}` }));
    const conversation = store.get('k');
    for (let step = 0; step < 120; step++) {
      const turn = pick(conversation.turns), roll = next(), items = Array.isArray(turn.activities) ? turn.activities : [];
      if (roll < 0.15) turn.message += ` more ${step}`;
      else if (roll < 0.3) items.push({ id: `a${step}`, kind: 'activity', text: 'new', status: 'done' });
      else if (roll < 0.45 && items.length && items.every(item => typeof item.text === 'string')) { const item = pick(items); if (next() < 0.5) item.text += ' and on and on and on'; else { item.status = pick(['done', 'failed']); if (next() < 0.3) delete item.kind; } }
      else if (roll < 0.55 && items.length) items.splice(Math.floor(next() * items.length), 1);
      else if (roll < 0.65) turn.proposals = [...(turn.proposals || []), { key: `e${step}`, fate: pick(['applied', 'stale']) }];
      else if (roll < 0.72) delete turn.proposals;
      else if (roll < 0.8) turn.activities = pick([[], 'not a list', [{ no: 'id' }], [{ id: 1, text: 'x' }, { id: 1, text: 'twice' }]]);
      else if (roll < 0.88) turn[`field${Math.floor(next() * 3)}`] = pick([undefined, null, 7, 'text', { nested: [1, { deep: step }] }, 'x'.repeat(300)]);
      else if (roll < 0.94) conversation[`extra${Math.floor(next() * 2)}`] = pick([undefined, 'a', { b: step }]);
      else if (!Array.isArray(turn.activities)) turn.activities = [];
      if (next() < 0.4) {
        if (next() < 0.5) await store.save('k'); else await store.update('k', turn.id, () => {});
        if (next() < 0.5) { await store.save('k'); assert.deepEqual(await readConversation(dir, 'k'), plain(conversation), `seed ${seed}, step ${step}: disk`); }
      }
    }
    await store.save('k');
    assert.deepEqual(await readConversation(dir, 'k'), plain(conversation), `seed ${seed}: disk`);
    assert.deepEqual(plain(mirror), plain(conversation), `seed ${seed}: a copy kept up to date from the events alone`);
    assert.deepEqual(problems, []);
    await store.close();
    assert.deepEqual((({ eventSeq, ...rest }) => rest)(await snapshotOf(dir, 'k')), plain(conversation), `seed ${seed}: the snapshot after close`);
  }
});

test('applyEvent refuses what does not fit, and cursors are read strictly', () => {
  const conversation = { key: 'k', turns: [{ id: 'a', user: 'x', activities: [] }] };
  assert.equal(applyEvent(conversation, { type: 'turn.patch', turnId: 'missing', set: { x: 1 } }), false);
  assert.equal(applyEvent(conversation, { type: 'nonsense' }), false);
  assert.equal(applyEvent(conversation, null), false);
  assert.equal(applyEvent({ turns: 'no' }, { type: 'reset' }), false);
  assert.equal(applyEvent(conversation, { type: 'turn.patch', turnId: 'a', set: { id: 'changed', __proto__: { polluted: true }, note: 'kept' }, unset: ['constructor'] }), true);
  assert.deepEqual([conversation.turns[0].id, conversation.turns[0].note, {}.polluted], ['a', 'kept', undefined]);
  assert.equal(applyEvent(conversation, { type: 'conversation.patch', set: { turns: [], key: 'other', title: 't' } }), true);
  assert.deepEqual([conversation.key, conversation.turns.length, conversation.title], ['k', 1, 't']);
  assert.equal(applyEvent(conversation, { type: 'turn.activity', turnId: 'a', activities: [{ id: 'r', fields: { id: 'r', kind: 'reasoning', status: 'running' }, text: 'Read' }, { id: 'r', append: 'ing' }, null] }), true);
  assert.deepEqual(conversation.turns[0].activities, [{ id: 'r', kind: 'reasoning', status: 'running', text: 'Reading' }]);
  assert.deepEqual(parseCursor(formatCursor('ab12', 7)), { epoch: 'ab12', seq: 7 });
  assert.deepEqual(parseCursor(7), { epoch: null, seq: 7 });
  assert.deepEqual(parseCursor('12'), { epoch: null, seq: 12 });
  for (const bad of ['', 'x:y', '-1', 'a:b:3', 'a b:3', -1, 1.5, null, {}, 'x'.repeat(100)]) assert.equal(parseCursor(bad), null, String(bad));
});
