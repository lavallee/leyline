import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkLog, createTrail, routineStats, suggestRoutines, shapeOf, sinceMs } from '../server/worklog.mjs';
import { tempDir } from './helpers.mjs';

test('the work log keeps runs worth learning from, privately', async t => {
  const dir = await tempDir(t), file = path.join(dir, 'work', 'log.jsonl');
  let clock = Date.parse('2026-11-23T10:00:00Z');
  const log = createWorkLog({ file, now: () => (clock += 60e3), maxCode: 10 });
  assert.equal(log.record({ doc: 'a', agent: 'Scout', code: 'read()', changes: { added: [], updated: [] } }), null, 'a read that changed nothing is not kept');
  const run = log.record({ doc: 'a', engine: 'tldraw', agent: 'Scout', label: 'colour boxes', code: 'x'.repeat(50), changes: { added: ['k1'], updated: 2 }, ms: 40 });
  assert.deepEqual(run, { t: '2026-11-23T10:01:00.000Z', doc: 'a', engine: 'tldraw', agent: 'Scout', kind: 'exec', label: 'colour boxes', code: 'xxxxxxxxxx', changed: { added: 1, updated: 2, removed: 0 }, ok: true, ms: 40 });
  const routine = log.record({ doc: 'a', agent: 'person', routine: 'proofread', code: 'the prompt' });
  assert.deepEqual([routine.kind, routine.routine, routine.code], ['routine', 'proofread', undefined], 'a routine is kept even when it changes nothing, without its code');
  const failed = log.record({ doc: 'b', code: 'boom()', ok: false, error: 'x is not defined' });
  assert.deepEqual([failed.ok, failed.error, failed.agent], [false, 'x is not defined', 'agent']);
  assert.equal(log.read().length, 3);
  assert.equal(log.read('2026-11-23T10:02:30Z').length, 1);
  assert.equal(log.read(String(clock + 1)).length, 0);
  await appendFile(file, 'not json\n');
  assert.equal(log.read().length, 3, 'a damaged line is skipped');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.throws(() => createWorkLog({}), TypeError);
});

test('the log rotates once, and imports each outside entry once', async t => {
  const dir = await tempDir(t), log = createWorkLog({ file: path.join(dir, 'log.jsonl'), maxBytes: 300 });
  for (let i = 0; i < 6; i++) log.record({ doc: 'a', code: `step(${i})`, changes: { added: 1 } });
  assert.deepEqual((await readdir(dir)).sort(), ['log.1.jsonl', 'log.jsonl']);
  assert.ok(log.read().length >= 3 && log.read().length <= 6, 'the rotation is read too');
  const before = log.read().length;
  const entries = [{ id: 's1', t: '2026-11-01T00:00:00Z', doc: 'a', code: 'a()' }, { id: 's1', doc: 'a', code: 'a()' }, { id: 's2', doc: 'other-server', code: 'b()' }, { id: 's3', doc: 'a' }, null, { id: 's4', t: 'garbage', doc: 'a', code: 'c()', source: 'codex' }];
  assert.equal(log.importEntries(entries, { accept: e => e.doc === 'a' }), 2);
  assert.equal(log.importEntries(entries, { accept: e => e.doc === 'a' }), 0, 'known ids are not imported twice');
  assert.equal(log.read().length, before + 2);
  assert.deepEqual(log.read().filter(e => e.id).map(e => [e.id, e.source, e.t.slice(0, 4)]), [['s1', 'import', '2026'], ['s4', 'codex', '1970']]);
});

test('routine stats say who uses what and how often it fails', () => {
  const entries = [
    { kind: 'routine', routine: 'proofread', agent: 'person', doc: 'a', ok: true, t: '2026-11-01T00:00:00Z' },
    { kind: 'routine', routine: 'proofread', agent: 'Scout', doc: 'b', ok: false, error: 'timed out', t: '2026-11-02T00:00:00Z' },
    { kind: 'routine', routine: 'retired', agent: 'Scout', doc: 'a', ok: true, t: '2026-11-03T00:00:00Z' },
    { kind: 'exec', agent: 'Scout', doc: 'a', ok: true }, { kind: 'import', agent: 'Scout', doc: 'a', ok: true },
  ];
  const stats = routineStats(entries, [{ name: 'proofread', title: 'Proofread', kind: 'check' }, { name: 'tighten', title: 'Tighten' }]);
  assert.deepEqual(stats.routines, [
    { name: 'proofread', title: 'Proofread', kind: 'check', runs: 2, byPeople: 1, byAgents: 1, failed: 1, docs: 2, last: '2026-11-02T00:00:00Z', errors: ['timed out'] },
    { name: 'retired', title: 'retired', kind: 'unknown', runs: 1, byPeople: 0, byAgents: 1, failed: 0, docs: 1, last: '2026-11-03T00:00:00Z', errors: [] },
    { name: 'tighten', title: 'Tighten', kind: 'unknown', runs: 0, byPeople: 0, byAgents: 0, failed: 0, docs: 0, last: null, errors: [] }]);
  assert.equal(stats.handWritten, 1);
});

test('work that repeats is suggested as a routine, unless a routine already does it', () => {
  const colour = (word, shade) => `// make them stand out\nconst hits = shapes.filter(s => /${word}/i.test(text(s)));\nupdate(hits.map(s => ({ id: s.id, props: { color: '${shade}' } })));\nreturn { summary: hits.length + ' coloured' };`;
  const align = n => `const boxes = selection();\nconst left = Math.min(...boxes.map(b => b.x));\nupdate(boxes.map(b => ({ id: b.id, x: left + ${n} })));`;
  const run = (doc, code, extra = {}) => ({ kind: 'exec', ok: true, doc, agent: 'Scout', code, t: '2026-11-20T00:00:00Z', ...extra });
  const entries = [run('a', colour('blocked', 'red'), { label: 'colour blocked' }), run('a', colour('done', 'green')), run('b', colour('late', 'orange'), { agent: 'Rook', t: '2026-11-21T00:00:00Z' }),
    run('a', align(0)), run('a', align(8)),                              // twice on one document: not yet a habit
    run('c', 'remove(all())'),                                           // a one-liner is not a chore
    run('a', colour('x', 'y'), { ok: false }), { kind: 'routine', routine: 'tidy', doc: 'a', ok: true }];
  assert.equal(shapeOf(colour('blocked', 'red')), shapeOf(colour('done', 'green')), 'names and numbers aside, the same work');
  const [first, ...rest] = suggestRoutines(entries);
  assert.deepEqual(rest, []);
  assert.deepEqual({ runs: first.runs, docs: first.docs, agents: first.agents, labels: first.labels, coveredBy: first.coveredBy, last: first.last }, { runs: 3, docs: ['a', 'b'], agents: ['Scout', 'Rook'], labels: ['colour blocked'], coveredBy: [], last: '2026-11-21T00:00:00Z' });
  assert.match(first.id, /^[0-9a-f]{10}$/);
  assert.match(first.example, /orange/, 'the latest run is the example to start from');
  assert.deepEqual(suggestRoutines(entries, { min: 2 }).map(s => s.runs), [3, 2]);
  // A banked routine with the same shape, or the host's own knowledge, marks it as already covered.
  assert.deepEqual(suggestRoutines(entries, { routines: [{ name: 'colour-matching', code: colour('any', 'blue') }], covers: code => /color/.test(code) ? ['restyle'] : [] })[0].coveredBy, ['restyle', 'colour-matching']);
});

test('the trail records what changed while nobody watched', async t => {
  const dir = await tempDir(t);
  let clock = Date.parse('2026-11-23T10:00:00Z');
  const trail = createTrail({ dir, now: () => (clock += 60e3) });
  assert.equal(trail.record('page', { source: 'Scout', what: 'looked around', changes: { added: [] } }), null);
  const entry = trail.record('page', { source: 'Scout', what: '  tightened\n the intro ', changes: { added: [{ key: 'p9' }], updated: ['p1', { id: 'p2' }, 42], removed: [] } });
  assert.deepEqual(entry, { t: '2026-11-23T10:02:00.000Z', source: 'Scout', what: 'tightened the intro', added: ['p9'], updated: ['p1', 'p2'], removed: [] });
  trail.record('page', { source: 'Rook', what: 'tried', changes: { removed: ['p3'] }, ok: false, error: 'refused' });
  assert.deepEqual(trail.read('page').map(e => [e.source, e.error]), [['Scout', undefined], ['Rook', 'refused']]);
  assert.deepEqual(trail.read('page', '2026-11-23T10:02:00Z').map(e => e.source), ['Rook'], 'entries after a time');
  assert.deepEqual(trail.read('other'), []);
  assert.equal((await stat(path.join(dir, 'page.trail.jsonl'))).mode & 0o777, 0o600);
  assert.throws(() => trail.read('page', 'last tuesday'), RangeError);
  const now = Date.parse('2026-11-23T12:00:00Z');
  assert.deepEqual([sinceMs('2h', now), sinceMs('1d', now), sinceMs('1700000000000'), sinceMs(undefined)], [now - 7200e3, now - 86400e3, 1700000000000, 0]);
});

// ---------------------------------------------------------------- hardening

test('shapeOf cannot be made to run away by code an agent wrote', () => {
  const cases = ['x = /' + '[a]'.repeat(400), 'x = /' + '[a]'.repeat(400) + '/g', '/*'.repeat(10000), '`' + '${a}'.repeat(5000), "'" + '\\'.repeat(9999), 'return /' + 'a\\'.repeat(5000), '(/' + '['.repeat(10000)];
  for (const code of cases) {
    const began = performance.now();
    assert.equal(typeof shapeOf(code), 'string');
    assert.ok(performance.now() - began < 5000, `${code.slice(0, 12)}… took ${Math.round(performance.now() - began)} ms`);
  }
  assert.equal(shapeOf('const ok = /[a/]+b/g.test(x); // note'), 'const ok = R.test(x);', 'a regular expression with a class is still reduced');
});

test('an entry cut short by a crash costs only itself, not the entry written after it', async t => {
  const dir = await tempDir(t), file = path.join(dir, 'work.jsonl');
  const log = createWorkLog({ file });
  log.record({ doc: 'd', code: 'first()', changes: { added: 1 } });
  await appendFile(file, '{"t":"2026-11-23T10:00:00.000Z","doc":"d","kind":"exec","code":"cut sho');
  log.record({ doc: 'd', code: 'after()', changes: { added: 1 } });
  assert.deepEqual(log.read().map(e => e.code), ['first()', 'after()']);
  const trail = createTrail({ dir });
  trail.record('doc', { source: 'agent', what: 'one', changes: { added: ['a'] } });
  await appendFile(path.join(dir, 'doc.trail.jsonl'), '{"t":"cut');
  trail.record('doc', { source: 'agent', what: 'two', changes: { added: ['b'] } });
  assert.deepEqual(trail.read('doc').map(e => e.what), ['one', 'two']);
});

test('a trail does not grow without bound: it rotates once, like the work log', async t => {
  const dir = await tempDir(t);
  const trail = createTrail({ dir, maxBytes: 2000 });
  for (let i = 0; i < 200; i++) trail.record('doc', { source: 'agent', what: `change ${i}`, changes: { updated: [`part-${i}`] } });
  const sizes = await Promise.all((await readdir(dir)).map(async name => [name, (await stat(path.join(dir, name))).size]));
  assert.deepEqual(sizes.map(([name]) => name).sort(), ['doc.trail.1.jsonl', 'doc.trail.jsonl']);
  assert.ok(sizes.every(([, size]) => size < 2600), JSON.stringify(sizes));
  const kept = trail.read('doc').map(e => e.what);
  assert.equal(kept.at(-1), 'change 199');
  assert.ok(kept.length > 5 && kept.length < 200, `the newest entries are kept across the rotation: ${kept.length}`);
});
