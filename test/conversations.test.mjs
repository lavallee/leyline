import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createConversationStore as create, ConversationError, fileNameFor, TURN_STATUSES } from '../server/conversations.mjs';
import { tempDir, until, deferred, beforeCleanup } from './helpers.mjs';

// Every store a test makes is closed before its folder is removed.
const createConversationStore = options => { const store = create(options); beforeCleanup(() => store.close()); return store; };

const onDisk = async (dir, key) => JSON.parse(await readFile(path.join(dir, fileNameFor(key)), 'utf8'));
const settled = turn => until(() => ['succeeded', 'failed', 'stopped'].includes(turn.status));

test('a request is queued, run and stored with its reply', async t => {
  const dir = await tempDir(t), seen = [];
  const store = createConversationStore({ dir: path.join(dir, 'chats'), saveDelay: 5, run: async (turn, lane, signal, tools) => {
    seen.push({ status: turn.status, lane, payload: tools.payload, aborted: signal.aborted });
    tools.activity({ id: 'r1', kind: 'reasoning', append: 'Thinking', status: 'running' });
    tools.activity({ id: 'c1', kind: 'activity', command: 'ls', status: 'done' });
    return { message: 'Done.', provenance: { provider: 'test', model: 'none' }, proposals: [{ key: 'e0' }], id: 'ignored', status: 'ignored' };
  } });
  const turn = await store.send('page-1', { user: 'Tidy this', mode: 'fast', payload: { prompt: 'secret prompt text' }, status: 'ignored', id: 'ignored' });
  assert.match(turn.id, /^[0-9a-f-]{36}$/);
  assert.ok(['queued', 'running'].includes(turn.status));
  await settled(turn);
  await store.flush();
  assert.deepEqual(seen, [{ status: 'running', lane: { id: 'page-1:main', name: 'main', main: true, key: 'page-1' }, payload: { prompt: 'secret prompt text' }, aborted: false }]);
  const stored = await onDisk(path.join(dir, 'chats'), 'page-1');
  assert.equal(stored.key, 'page-1');
  const [saved] = stored.turns;
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.user, 'Tidy this');
  assert.equal(saved.message, 'Done.');
  assert.equal(saved.mode, 'fast', 'host fields are kept');
  assert.equal(saved.id, turn.id, 'a run cannot replace the id');
  assert.deepEqual(saved.proposals, [{ key: 'e0' }]);
  assert.deepEqual(saved.activities, [{ id: 'r1', kind: 'reasoning', text: 'Thinking', status: 'done' }, { id: 'c1', kind: 'activity', text: '', command: 'ls', status: 'done' }]);
  assert.ok(saved.createdAt && saved.startedAt && saved.finishedAt);
  assert.ok(!JSON.stringify(stored).includes('secret prompt text'), 'the payload is never written');
  assert.ok(TURN_STATUSES.includes(saved.status));
});

test('files are private, written atomically, and safe for any key', async t => {
  const dir = path.join(await tempDir(t), 'chats');
  const store = createConversationStore({ dir, run: async () => ({ message: 'ok' }) });
  const odd = '../../etc/passwd page?';
  for (const key of ['plain_key-1', odd]) await settled(await store.send(key, { user: 'x' }));
  await store.flush();
  const names = (await readdir(dir)).sort();
  assert.equal(names.length, 2);
  assert.ok(names.includes('plain_key-1.json'));
  assert.ok(names.every(name => /^[A-Za-z0-9_-]+\.json$/.test(name)), `no path characters and no leftover temporary files: ${names}`);
  for (const name of names) assert.equal((await stat(path.join(dir, name))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await onDisk(dir, odd)).key, odd);
  await assert.rejects(store.open(''), ConversationError);
  await assert.rejects(store.open('a\0b'), { code: 'invalid' });
});

test('turns left running by a dead process are recovered as failed', async t => {
  const dir = await tempDir(t);
  await writeFile(path.join(dir, 'page.json'), JSON.stringify({ key: 'page', custom: 'kept', turns: [
    { id: 'a', user: 'done', status: 'succeeded', message: 'fine', activities: [] },
    { id: 'b', user: 'was running', status: 'running', message: '', activities: [{ id: 'x', kind: 'activity', status: 'running' }, { id: 'y', kind: 'activity', status: 'done' }] },
    { id: 'c', user: 'was waiting', status: 'queued', message: '' }] }));
  await writeFile(path.join(dir, 'other.json'), JSON.stringify({ key: 'someone-else', turns: [{ id: 'z', status: 'succeeded' }] }));
  await writeFile(path.join(dir, 'broken.json'), '{ not json');
  await writeFile(path.join(dir, 'legacy.json'), JSON.stringify({ thread: 'legacy', turns: [{ id: 'l', user: 'old', status: 'succeeded', message: 'm' }] }));
  const store = createConversationStore({ dir, run: async () => ({ message: 'ok' }), messages: { interrupted: 'Restarted; send it again.' } });
  const conversation = await store.open('page');
  assert.deepEqual(conversation.turns.map(t => t.status), ['succeeded', 'failed', 'failed']);
  assert.equal(conversation.turns[1].message, 'Restarted; send it again.');
  assert.deepEqual(conversation.turns[1].activities.map(a => a.status), ['stopped', 'done']);
  assert.ok(conversation.turns[2].finishedAt);
  assert.equal(conversation.custom, 'kept');
  assert.deepEqual((await onDisk(dir, 'page')).turns.map(t => t.status), ['succeeded', 'failed', 'failed'], 'the recovery is written back');
  assert.equal(await store.open('page'), conversation, 'one object per key');
  assert.deepEqual((await store.open('other')).turns, [], 'a file that belongs to another key is not adopted');
  assert.deepEqual((await store.open('broken')).turns, []);
  assert.equal((await store.open('legacy')).turns.length, 1, 'a file with no key field is adopted under its file name');
});

test('lanes: the first request takes main, later ones get side lanes, up to the cap', async t => {
  const dir = await tempDir(t), gates = new Map(), started = [], closed = [];
  const store = createConversationStore({ dir, maxLanes: 3, onLaneClosed: lane => closed.push(lane.name), run: async (turn, lane) => {
    started.push({ user: turn.user, lane: lane.name, main: lane.main, id: lane.id });
    const gate = deferred(); gates.set(turn.user, gate); await gate.promise;
    return { message: `${turn.user} via ${lane.name}` };
  } });
  const turns = [];
  for (const user of ['a', 'b', 'c', 'd', 'e']) turns.push(await store.send('doc', { user }));
  await until(() => started.length === 3);
  assert.deepEqual(started.map(s => s.lane), ['main', turns[1].id.slice(0, 8), turns[2].id.slice(0, 8)]);
  assert.deepEqual(started.map(s => s.main), [true, false, false]);
  assert.equal(started[1].id, `doc:${turns[1].id.slice(0, 8)}`);
  assert.deepEqual(turns.map(t => t.status), ['running', 'running', 'running', 'queued', 'queued']);
  assert.equal(store.busy('doc'), true);
  assert.equal(store.lanes('doc').length, 3);
  assert.equal(store.running('doc:main').turn, turns[0]);
  assert.equal(store.running('doc:nope'), undefined);

  gates.get('b').resolve();                       // a side lane frees up: d takes a new side lane
  await until(() => started.length === 4);
  assert.equal(started[3].lane, turns[3].id.slice(0, 8));
  gates.get('a').resolve();                       // main frees up: e takes main, and its memory
  await until(() => started.length === 5);
  assert.deepEqual({ user: started[4].user, lane: started[4].lane }, { user: 'e', lane: 'main' });
  for (const user of ['c', 'd', 'e']) gates.get(user).resolve();
  await Promise.all(turns.map(settled));
  assert.equal(turns[4].message, 'e via main');
  assert.equal(turns[1].lane, turns[1].id.slice(0, 8), 'the lane is recorded on the turn');
  await until(() => closed.length === 5);
  assert.equal(closed.filter(name => name === 'main').length, 2);
  assert.equal(store.busy('doc'), false);
  // Another conversation has its own lanes.
  const other = await store.send('other-doc', { user: 'z' });
  await until(() => gates.has('z')); gates.get('z').resolve(); await settled(other);
  assert.equal(started.at(-1).id, 'other-doc:main');
});

test('maxLanes 1 is a strict queue in order', async t => {
  const order = [];
  const store = createConversationStore({ dir: await tempDir(t), maxLanes: 1, run: async (turn, lane) => { order.push(`${turn.user}:${lane.name}`); await new Promise(r => setTimeout(r, 5)); return { message: '' }; } });
  const turns = []; for (const user of ['1', '2', '3']) turns.push(await store.send('k', { user }));
  await Promise.all(turns.map(settled));
  assert.deepEqual(order, ['1:main', '2:main', '3:main']);
});

test('stop: a waiting request is removed, a running one is aborted, and both are recorded', async t => {
  const dir = await tempDir(t), ran = [];
  const store = createConversationStore({ dir, maxLanes: 1, messages: { stopped: 'Stopped by you.' }, run: (turn, lane, signal, tools) => new Promise((resolve, reject) => {
    ran.push(turn.user);
    tools.activity({ id: 'w', kind: 'activity', title: 'Working', status: 'running' });
    signal.addEventListener('abort', () => reject(new Error('aborted underneath')));
  }) });
  const first = await store.send('k', { user: 'first' }), second = await store.send('k', { user: 'second' }), third = await store.send('k', { user: 'third' });
  await until(() => first.status === 'running');
  assert.equal((await store.stop('k', second.id)).status, 'stopped');
  assert.equal(second.message, 'Removed before it started.');
  await store.stop('k', first.id);
  await settled(first);
  assert.equal(first.status, 'stopped');
  assert.equal(first.message, 'Stopped by you.');
  assert.equal(first.activities[0].status, 'stopped');
  await until(() => ran.length === 2);
  assert.deepEqual(ran, ['first', 'third'], 'the removed request never ran');
  await store.stopAll('k');
  await settled(third);
  await store.flush();
  assert.deepEqual((await onDisk(dir, 'k')).turns.map(t => t.status), ['stopped', 'stopped', 'stopped']);
  assert.equal((await store.stop('k', first.id)).status, 'stopped', 'stopping a finished request changes nothing');
  await assert.rejects(store.stop('k', 'no-such-turn'), { code: 'not-found', status: 404 });
});

test('a run that ignores its signal is still recorded as stopped, and a late reply is dropped', async t => {
  const gate = deferred();
  const store = createConversationStore({ dir: await tempDir(t), run: async () => { await gate.promise; return { message: 'too late' }; } });
  const turn = await store.send('k', { user: 'x' });
  await until(() => turn.status === 'running');
  await store.stop('k', turn.id);
  gate.resolve(); await settled(turn);
  assert.equal(turn.status, 'stopped');
  assert.equal(turn.message, 'Stopped.');
});

test('a failing run is recorded with the host’s wording, and the next request still runs', async t => {
  const errors = [];
  const store = createConversationStore({ dir: await tempDir(t), onError: e => errors.push(e),
    describeFailure: (error, turn) => error.code === 'timeout' ? 'It ran out of time.' : `Could not finish “${turn.user}”.`,
    run: async turn => { if (turn.user === 'slow') throw Object.assign(new Error('x'), { code: 'timeout' }); if (turn.user === 'bad') throw new Error('stack trace detail'); return { message: 'fine' }; } });
  const slow = await store.send('k', { user: 'slow' }), bad = await store.send('k', { user: 'bad' }), good = await store.send('k', { user: 'good' });
  await Promise.all([slow, bad, good].map(settled));
  assert.deepEqual([slow.status, slow.message], ['failed', 'It ran out of time.']);
  assert.deepEqual([bad.status, bad.message], ['failed', 'Could not finish “bad”.']);
  assert.deepEqual([good.status, good.message], ['succeeded', 'fine']);
  assert.deepEqual(errors, []);
});

test('reset archives the old turns and refuses while anything is running', async t => {
  const dir = await tempDir(t), gate = deferred();
  const store = createConversationStore({ dir, run: async turn => { if (turn.user === 'wait') await gate.promise; return { message: 'reply' }; } });
  const one = await store.send('k', { user: 'one' }); await settled(one);
  const waiting = await store.send('k', { user: 'wait' });
  await assert.rejects(store.reset('k'), { code: 'busy', status: 409 });
  gate.resolve(); await settled(waiting);
  const conversation = await store.reset('k');
  assert.deepEqual(conversation.turns, []);
  assert.deepEqual((await onDisk(dir, 'k')).turns, []);
  const archived = await readdir(path.join(dir, 'archive'));
  assert.equal(archived.length, 1);
  assert.equal((await stat(path.join(dir, 'archive', archived[0]))).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'archive', archived[0]), 'utf8')).turns.map(t => t.user), ['one', 'wait']);
  await store.reset('k');
  assert.equal((await readdir(path.join(dir, 'archive'))).length, 1, 'an empty conversation is not archived');
});

test('limits: a full conversation refuses more, and activities are capped', async t => {
  const store = createConversationStore({ dir: await tempDir(t), maxTurns: 2, maxActivities: 3, run: async (turn, lane, signal, tools) => {
    for (let i = 0; i < 10; i++) tools.activity({ id: `a${i}`, kind: 'activity', status: 'done' });
    return { message: '' };
  } });
  const a = await store.send('k', { user: 'a' }); await store.send('k', { user: 'b' });
  await assert.rejects(store.send('k', { user: 'c' }), { code: 'full' });
  await assert.rejects(store.send('k', {}), { code: 'invalid' });
  await settled(a);
  assert.equal(a.activities.length, 3);
  assert.throws(() => createConversationStore({ dir: 'x' }), TypeError);
  assert.throws(() => createConversationStore({ run() {} }), TypeError);
});

test('a request that cannot be written is not kept', async t => {
  const dir = await tempDir(t), blocked = path.join(dir, 'file-not-folder');
  await writeFile(blocked, 'x');
  const store = createConversationStore({ dir: path.join(blocked, 'chats'), run: async () => ({ message: '' }) });
  await assert.rejects(store.send('k', { user: 'x' }));
  assert.deepEqual((await store.open('k')).turns, []);
  assert.equal(store.busy('k'), false);
});

test('onCall receives one record per finished turn, and a throwing hook does not break the store', async t => {
  const records = [], errors = [];
  const store = createConversationStore({ dir: await tempDir(t), onError: e => errors.push(e.message),
    onCall: record => { records.push(record); if (record.status === 'failed') throw new Error('hook broke'); },
    run: async turn => { if (turn.user === 'bad') throw new Error('nope'); return { message: 'ok', provenance: { provider: 'http-chat', model: 'm' }, usage: { inputTokens: 3, outputTokens: 4 } }; } });
  const good = await store.send('k', { user: 'good' }); await settled(good);
  const bad = await store.send('k', { user: 'bad' }); await settled(bad);
  await until(() => records.length === 2);
  assert.deepEqual({ ...records[0], startedAt: 0, finishedAt: 0, durationMs: 0 }, { key: 'k', lane: 'k:main', turnId: good.id, status: 'succeeded', startedAt: 0, finishedAt: 0, durationMs: 0,
    provenance: { provider: 'http-chat', model: 'm' }, usage: { inputTokens: 3, outputTokens: 4 } });
  assert.ok(records[0].durationMs >= 0);
  assert.equal(records[1].error, 'nope');
  assert.deepEqual(errors, ['hook broke']);
  const next = await store.send('k', { user: 'still works' }); await settled(next);
  assert.equal(next.status, 'succeeded');
});

test('save() lets a host write its own changes; close() stops everything and flushes', async t => {
  const dir = await tempDir(t);
  const store = createConversationStore({ dir, maxLanes: 1, run: (turn, lane, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  const conversation = await store.open('k');
  conversation.title = 'Named by the host';
  await store.save('k');
  assert.equal((await onDisk(dir, 'k')).title, 'Named by the host');
  const running = await store.send('k', { user: 'r' }), waiting = await store.send('k', { user: 'w' });
  await until(() => running.status === 'running');
  await store.close();
  assert.deepEqual((await onDisk(dir, 'k')).turns.map(t => t.status), ['stopped', 'stopped']);
  assert.equal(waiting.message, 'Removed before it started.');
  assert.equal(await store.turn('k', running.id), running);
  assert.equal(store.get('k'), conversation);
  assert.equal(store.get('unopened'), undefined);
});
