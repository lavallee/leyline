import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHistory, diffParts, prunable } from '../server/history.mjs';
import { tempDir } from './helpers.mjs';

const HOUR = 36e5, DAY = 24 * HOUR;

test('save keeps whole snapshots, skips no-op saves, and says what changed', async t => {
  const dir = await tempDir(t), history = createHistory({ dir });
  const one = history.save('canvas-1', { data: { shapes: ['a'] }, parts: { a: 'box A', '~page': 'p1' }, label: 'first' });
  assert.deepEqual({ n: one.n, source: one.source, count: one.count, added: one.added, keys: one.keys, label: one.label }, { n: 1, source: 'edit', count: 1, added: 1, keys: ['a'], label: 'first' });
  assert.equal(one.hash, undefined, 'the hash is internal');
  assert.equal(history.save('canvas-1', { data: { shapes: ['a'] }, parts: { a: 'box A', '~page': 'p1' } }), null, 'nothing changed');
  const two = history.save('canvas-1', { data: { shapes: ['a', 'b'] }, parts: { a: 'box A moved', b: 'box B', '~page': 'p1' }, source: 'agent' });
  assert.deepEqual({ n: two.n, added: two.added, updated: two.updated, removed: two.removed, keys: two.keys, source: two.source }, { n: 2, added: 1, updated: 1, removed: 0, keys: ['b', 'a'], source: 'agent' });
  const hidden = history.save('canvas-1', { data: { shapes: ['a', 'b'], page: 2 }, parts: { a: 'box A moved', b: 'box B', '~page': 'p2' } });
  assert.deepEqual({ n: hidden.n, updated: hidden.updated, keys: hidden.keys }, { n: 3, updated: 0, keys: [] }, 'a ~ part counts as a change but is not reported');
  assert.deepEqual(history.list('canvas-1').map(v => v.n), [3, 2, 1], 'newest first');
  assert.deepEqual(history.read('canvas-1', 2).data, { shapes: ['a', 'b'] });
  assert.equal(history.read('canvas-1', 9), null);
  assert.equal(history.isCurrent('canvas-1', { parts: { a: 'box A moved', b: 'box B', '~page': 'p2' } }), true);
  assert.equal(history.isCurrent('canvas-1', { parts: { a: 'different' } }), false);
  assert.deepEqual(history.list('never-saved'), []);
  const files = await readdir(path.join(dir, 'canvas-1'));
  assert.deepEqual(files.sort(), ['1.json.gz', '2.json.gz', '3.json.gz', 'index.json']);
  for (const file of files) assert.equal((await stat(path.join(dir, 'canvas-1', file))).mode & 0o777, 0o600);
});

test('text documents work without parts, and naming an unchanged state labels it', async t => {
  const history = createHistory({ dir: await tempDir(t) });
  assert.equal(history.save('page', { data: '# Title\n\nFirst.' }).n, 1);
  assert.equal(history.save('page', { data: '# Title\n\nFirst.' }), null);
  const named = history.save('page', { data: '# Title\n\nFirst.', named: true, label: 'Sent to client' });
  assert.deepEqual({ n: named.n, named: named.named, label: named.label }, { n: 1, named: true, label: 'Sent to client' });
  assert.equal(history.save('page', { data: '# Title\n\nSecond.' }).n, 2);
  assert.equal(history.read('page', 1).data, '# Title\n\nFirst.');
  assert.equal(history.isCurrent('page', { data: '# Title\n\nSecond.' }), true);
  assert.equal(history.save('odd/key with spaces', { data: 'x' }).n, 1, 'any key is safe as a folder name');
});

test('restore saves the current state first and is itself a new version', async t => {
  const history = createHistory({ dir: await tempDir(t) });
  history.save('page', { data: 'one' }); history.save('page', { data: 'two' });
  const back = history.restore('page', 1, { current: { data: 'three, not yet saved' } });
  assert.equal(back.data, 'one');
  assert.deepEqual({ n: back.version.n, source: back.version.source, label: back.version.label, from: back.from.n }, { n: 4, source: 'restore', label: 'Restored version 1', from: 1 });
  assert.deepEqual(history.list('page').map(v => [v.n, v.source]), [[4, 'restore'], [3, 'before-restore'], [2, 'edit'], [1, 'edit']]);
  assert.equal(history.read('page', 3).data, 'three, not yet saved', 'nothing is lost');
  assert.equal(history.isCurrent('page', { data: 'one' }), true);
  assert.equal(history.save('page', { data: 'one' }), null);
  const again = history.restore('page', 2, { current: { data: 'one' } });
  assert.equal(again.version.n, 5, 'an unchanged current state is not saved again');
  assert.throws(() => history.restore('page', 99), RangeError);
});

test('checkpoints make "undo everything from this request" a restore', async t => {
  const history = createHistory({ dir: await tempDir(t) });
  history.save('page', { data: 'before' });
  const mark = history.checkpoint('page', 'turn-1', { data: 'before' });
  assert.equal(mark.n, 1, 'an unchanged state reuses the latest version');
  history.save('page', { data: 'agent edit 1' }); history.save('page', { data: 'agent edit 2' });
  assert.equal(history.checkpointOf('page', 'turn-1').data, 'before');
  const undone = history.undoRequest('page', 'turn-1', { current: { data: 'agent edit 2, then the person typed' } });
  assert.equal(undone.data, 'before');
  assert.equal(undone.version.label, 'Undid a request');
  assert.equal(history.read('page', undone.version.n - 1).data, 'agent edit 2, then the person typed', 'what was undone can itself be restored');
  const second = history.checkpoint('page', 'turn-2', { data: 'the person changed it before asking' });
  assert.deepEqual({ source: second.source, request: second.request }, { source: 'checkpoint', request: 'turn-2' });
  assert.throws(() => history.undoRequest('page', 'turn-unknown'), /no checkpoint/);
  assert.equal(history.checkpointOf('page', 'turn-unknown'), null);
  assert.throws(() => history.checkpoint('page', '', { data: 'x' }), TypeError);
  history.forget('page');
  assert.deepEqual(history.list('page'), []);
});

test('pruning thins old automatic versions and keeps named ones, restores and checkpoints', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const at = ms => new Date(now - ms).toISOString();
  const versions = [
    { n: 1, t: at(30 * DAY), size: 10 },                       // same day as 2: goes
    { n: 2, t: at(30 * DAY - HOUR), size: 10 },                // last of that day: stays
    { n: 3, t: at(3 * DAY + 20 * 60e3), size: 10 },            // same hour as 4: goes
    { n: 4, t: at(3 * DAY + 10 * 60e3), size: 10 },
    { n: 5, t: at(3 * DAY + 15 * 60e3), size: 10, named: true },
    { n: 6, t: at(3 * DAY + 16 * 60e3), size: 10, source: 'restore' },
    { n: 7, t: at(3 * DAY + 17 * 60e3), size: 10 },            // pinned by a checkpoint below
    { n: 8, t: at(2 * HOUR), size: 10 }, { n: 9, t: at(HOUR), size: 10 }, { n: 10, t: at(60e3), size: 10 },
  ];
  assert.deepEqual(prunable(versions, { now, pinned: new Set([7]) }).map(v => v.n), [1, 3]);
  // Over the size cap the oldest automatic versions go, never the newest or the kept ones.
  assert.deepEqual(prunable(versions, { now, pinned: new Set([7]), maxBytes: 45 }).map(v => v.n), [1, 2, 3, 4, 8, 9]);
  assert.deepEqual(prunable([{ n: 1, t: at(40 * DAY), size: 999 }], { now, maxBytes: 1 }), [], 'the only version always stays');
});

test('pruning removes files, and old checkpoints age out', async t => {
  const dir = await tempDir(t);
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const history = createHistory({ dir, now: () => clock, keepCheckpoints: 2, maxBytes: 1e9 });
  for (let i = 0; i < 4; i++) { history.save('doc', { data: `edit ${i}` }); clock += 5 * 60e3; }     // four versions in one hour
  for (const id of ['r1', 'r2', 'r3']) { history.checkpoint('doc', id, { data: `state at ${id}` }); clock += 60e3; }
  clock += 3 * DAY;
  history.save('doc', { data: 'much later' });
  const left = history.list('doc').map(v => v.n).sort((a, b) => a - b);
  assert.deepEqual(left, [5, 6, 7, 8], 'the last automatic version of the hour, the two newest checkpoints and the newest version stay');
  assert.deepEqual((await readdir(path.join(dir, 'doc'))).sort(), ['5.json.gz', '6.json.gz', '7.json.gz', '8.json.gz', 'index.json']);
  assert.equal(history.checkpointOf('doc', 'r1'), null, 'the oldest checkpoint aged out');
  assert.equal(history.checkpointOf('doc', 'r3').data, 'state at r3');
});

test('diffParts names what was added, updated and removed', () => {
  assert.deepEqual(diffParts({ a: '1', b: '2', '~x': '1' }, { a: '1', b: '3', c: '4', '~x': '2' }), { added: ['c'], updated: ['b'], removed: [] });
  assert.deepEqual(diffParts({ a: '1' }, {}), { added: [], updated: [], removed: ['a'] });
});

// ---------------------------------------------------------------- hardening

test('an index that cannot be parsed is moved aside and rebuilt from the version files', async t => {
  const dir = await tempDir(t), errors = [];
  const { writeFile, readFile } = await import('node:fs/promises');
  let clock = Date.parse('2026-11-23T10:00:00Z');
  const history = createHistory({ dir, now: () => (clock += 1000), onError: e => errors.push(e) });
  for (const text of ['one', 'two', 'three']) history.save('doc', { data: text });
  await writeFile(path.join(dir, 'doc', 'index.json'), '{ "next": 4, "versions": [ { "n": 1, "t": "2026');
  assert.deepEqual(history.list('doc').map(v => v.n), [3, 2, 1], 'the versions are still there');
  assert.equal(history.read('doc', 2).data, 'two');
  const saved = history.save('doc', { data: 'four' });
  assert.equal(saved.n, 4, 'numbering carries on after the highest file');
  assert.equal(history.restore('doc', 1, { current: { data: 'four' } }).data, 'one');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'corrupt');
  assert.match(await readFile(errors[0].file, 'utf8'), /"next": 4/, 'the broken index is kept for a person to look at');
});

test('a version file that cannot be read is treated as missing, not thrown from read()', async t => {
  const dir = await tempDir(t);
  const { writeFile } = await import('node:fs/promises');
  const history = createHistory({ dir });
  history.save('doc', { data: 'one' }); history.save('doc', { data: 'two' });
  await writeFile(path.join(dir, 'doc', '1.json.gz'), 'not gzip at all');
  assert.equal(history.read('doc', 1), null);
  assert.throws(() => history.restore('doc', 1), RangeError);
  assert.equal(history.read('doc', 2).data, 'two');
});

test('part names that are also Object properties are reported like any other', () => {
  assert.deepEqual(diffParts({}, { constructor: 'a', toString: 'b', plain: 'c' }), { added: ['constructor', 'toString', 'plain'], updated: [], removed: [] });
  assert.deepEqual(diffParts({ constructor: 'a' }, {}), { added: [], updated: [], removed: ['constructor'] });
});

test('what another process wrote is seen: the index is not trusted beyond the file on disk', async t => {
  const dir = await tempDir(t);
  const a = createHistory({ dir }), b = createHistory({ dir });
  a.save('doc', { data: 'from a' });
  assert.equal(b.list('doc').length, 1);
  b.save('doc', { data: 'from b' });
  assert.deepEqual(a.list('doc').map(v => v.n), [2, 1]);
  assert.equal(a.save('doc', { data: 'again from a' }).n, 3);
  assert.equal(b.read('doc', 3).data, 'again from a');
});
