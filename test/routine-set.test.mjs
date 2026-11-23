import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRoutineSet, jsonFormat, headerFormat, RoutineError } from '../server/routine-set.mjs';
import { tempDir } from './helpers.mjs';

const SHIPPED = [
  { name: 'proofread', title: 'Proofread', description: 'Spelling and grammar.', code: 'Proofread the whole page.' },
  { name: 'tighten', title: 'Tighten', description: 'Cut words.', code: 'Tighten the page.' },
];

test('shipped and banked routines are one list; a banked one replaces a shipped one of its name', async t => {
  const dir = await tempDir(t);
  const set = createRoutineSet({ shipped: SHIPPED, bankedDir: path.join(dir, 'routines'), engines: ['page'] });
  assert.deepEqual(set.list().map(r => [r.name, r.source, r.engines]), [['proofread', 'shipped', ['page']], ['tighten', 'shipped', ['page']]]);
  const saved = set.save('proofread', { title: 'Proofread', prompt: 'My stricter proofread.' });
  assert.deepEqual([saved.source, saved.code, saved.engines], ['banked', 'My stricter proofread.', ['page']]);
  set.save('figures', { title: 'Check the figures', description: 'Numbers against the data.', code: 'Check every number.' });
  assert.deepEqual(set.list().map(r => [r.name, r.source]), [['figures', 'banked'], ['proofread', 'banked'], ['tighten', 'shipped']]);
  assert.equal(set.get('proofread').code, 'My stricter proofread.');
  assert.equal(set.get('nope'), null);
  assert.equal((await stat(path.join(dir, 'routines', 'figures.json'))).mode & 0o777, 0o600);
});

test('remove archives the file and brings a shipped routine back', async t => {
  const dir = await tempDir(t), banked = path.join(dir, 'routines');
  const set = createRoutineSet({ shipped: SHIPPED, bankedDir: banked });
  set.save('proofread', { title: 'Mine', code: 'x' }); set.save('own', { title: 'Own', code: 'y' });
  const back = set.remove('proofread');
  assert.equal(back.removed, true);
  assert.deepEqual([back.restored.source, back.restored.code], ['shipped', 'Proofread the whole page.']);
  assert.deepEqual(set.remove('own'), { removed: true, restored: null });
  assert.deepEqual(set.remove('own'), { removed: false, restored: null });
  assert.deepEqual(set.remove('tighten'), { removed: false, restored: null }, 'a shipped routine cannot be removed');
  const archived = await readdir(path.join(banked, 'archive'));
  assert.equal(archived.length, 2);
  assert.ok(archived.every(name => /^(proofread|own)-[0-9a-f]{8}\.json$/.test(name)));
  assert.deepEqual(set.list().map(r => r.name), ['proofread', 'tighten'], 'archived routines are not listed');
  assert.throws(() => set.remove('../x'), RoutineError);
});

test('a slash command resolves to a routine, and a message becomes a request', async t => {
  const set = createRoutineSet({ shipped: [...SHIPPED, { name: 'fit', title: 'Fit the limit', code: 'Shorten.', engines: ['thread'] }], bankedDir: await tempDir(t), engines: ['page', 'thread'] });
  assert.deepEqual(set.resolve('  /proofread '), set.resolve('/PROOFREAD'));
  assert.equal(set.resolve('/proofread').name, 'proofread');
  assert.equal(set.resolve('please /proofread'), null, 'only a slash name alone is a command');
  assert.equal(set.resolve('/proofread now'), null);
  assert.equal(set.resolve('plain words'), null);
  assert.throws(() => set.resolve('/unknown'), { code: 'not-found', status: 404, message: 'That routine is not in the bank.' });
  assert.throws(() => set.resolve('/fit', { engine: 'page' }), { code: 'not-found' }, 'a routine for another engine is not offered');
  assert.equal(set.resolve('/fit', { engine: 'thread' }).name, 'fit');
  assert.deepEqual(set.turnFor('/tighten'), { user: 'Tighten', prompt: 'Tighten the page.', routine: 'tighten' });
  assert.deepEqual(set.turnFor(' Make it shorter '), { user: 'Make it shorter', prompt: 'Make it shorter' });
  assert.deepEqual(set.list({ engine: 'thread' }).map(r => r.name), ['fit', 'proofread', 'tighten'], 'a routine naming no engine runs on all');
});

test('save validates names, sizes, engines and kinds', async t => {
  const kinds = [{ id: 'tidy', label: 'Tidy' }, { id: 'check', label: 'Check' }, { id: 'other', label: 'Other' }];
  const set = createRoutineSet({ bankedDir: await tempDir(t), engines: ['tldraw', 'excalidraw'], kinds, limits: { code: 50 } });
  const good = { title: 'T', code: 'c' };
  for (const name of ['', 'Has Space', '../up', '-lead', 'x'.repeat(65)]) assert.throws(() => set.save(name, good), RoutineError, name);
  assert.throws(() => set.save('a', { title: ' ', code: 'c' }), RoutineError);
  assert.throws(() => set.save('a', { title: 'T', code: 'x'.repeat(51) }), RoutineError);
  assert.throws(() => set.save('a', { title: 'T' }), RoutineError);
  assert.throws(() => set.save('a', { ...good, engines: ['figma'] }), /Engines are: tldraw, excalidraw/);
  assert.throws(() => set.save('a', { ...good, kind: 'nope' }), /Kinds are: tidy, check, other/);
  assert.throws(() => set.save('a', { ...good, title: 'null\0byte' }), RoutineError);
  const saved = set.save('a', { ...good, engines: ['tldraw'], kind: 'check', when: 'Before sharing.', args: 'strict (bool)' });
  assert.deepEqual({ engines: saved.engines, kind: saved.kind, when: saved.when, args: saved.args }, { engines: ['tldraw'], kind: 'check', when: 'Before sharing.', args: 'strict (bool)' });
  assert.equal(set.save('b', good).kind, 'other', 'no kind means the last one');
  assert.deepEqual(set.save('b', good).engines, ['tldraw', 'excalidraw']);
  assert.deepEqual(set.byKind().map(g => [g.id, g.routines.map(r => r.name)]), [['check', ['a']], ['other', ['b']]]);
  assert.deepEqual(set.byKind({ engine: 'excalidraw' }).map(g => g.id), ['other']);
  assert.throws(() => createRoutineSet({}), TypeError);
});

test('the header format reads and writes routines that are code', async t => {
  const dir = await tempDir(t), shippedDir = path.join(dir, 'shipped');
  await mkdir(shippedDir);
  await writeFile(path.join(shippedDir, 'tidy-arrows.js'), `// routine: Tidy arrows
// description: Re-route arrows so fewer cross.
// engines: tldraw, figma
// kind: arrows
// when: Arrows run through boxes.
// args: maxBend (px)

// A note the author left.
return { summary: 'done' }
`);
  await writeFile(path.join(shippedDir, 'bare.js'), `return 1\n// kind: not-a-header-down-here\n`);
  const kinds = [{ id: 'arrows', label: 'Arrows' }, { id: 'other', label: 'Other' }];
  const set = createRoutineSet({ shippedDir, bankedDir: path.join(dir, 'banked'), format: headerFormat(), engines: ['tldraw', 'excalidraw'], kinds });
  const tidy = set.get('tidy-arrows');
  assert.deepEqual({ title: tidy.title, description: tidy.description, engines: tidy.engines, kind: tidy.kind, when: tidy.when, args: tidy.args, source: tidy.source },
    { title: 'Tidy arrows', description: 'Re-route arrows so fewer cross.', engines: ['tldraw'], kind: 'arrows', when: 'Arrows run through boxes.', args: 'maxBend (px)', source: 'shipped' });
  assert.match(tidy.code, /return \{ summary: 'done' \}/);
  const bare = set.get('bare');
  assert.deepEqual({ title: bare.title, engines: bare.engines, kind: bare.kind }, { title: 'bare', engines: ['tldraw', 'excalidraw'], kind: 'other' });

  // Banking keeps the code's own comments and replaces only the fields passed.
  const saved = set.save('tidy-arrows', { title: 'Tidy arrows\nbetter', code: tidy.code, kind: 'other', when: 'Always.' });
  assert.equal(saved.title, 'Tidy arrows better', 'a header value is one line');
  assert.equal(saved.kind, 'other'); assert.equal(saved.when, 'Always.');
  assert.deepEqual(saved.engines, ['tldraw'], 'the code keeps its own engines when none are passed');
  assert.equal(saved.description, 'Re-route arrows so fewer cross.');
  assert.match(saved.code, /^\/\/ routine: Tidy arrows better\n\/\/ description: Re-route arrows so fewer cross\.\n\/\/ engines: tldraw, figma\n\/\/ kind: other\n\/\/ when: Always\.\n\/\/ args: maxBend \(px\)\n\n\/\/ A note the author left\.\nreturn/);
  assert.equal(saved.code.match(/\/\/ kind:/g).length, 1, 'no duplicated header lines');
  const hash = headerFormat({ extension: '.py', comment: '#' });
  assert.equal(hash.parse('x', '# routine: In Python\n# kind: check\nprint(1)\n').title, 'In Python');
  assert.equal(jsonFormat.parse('n', '{"title":"T"}').name, 'n');
});
