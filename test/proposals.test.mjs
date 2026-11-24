import test from 'node:test';
import assert from 'node:assert/strict';
import { createProposals, textEdit, ProposalError, FATES } from '../server/proposals.mjs';

const doc = () => ({ 'content.md': '# Plan\n\nWe ship in March. The price is 40.\n\nWe ship in March, weather allowing.', 'notes.md': 'Loose notes.' });
const turn = (id = 't1') => ({ id, status: 'running', proposals: [] });
const proposals = createProposals({ now: () => Date.parse('2026-11-23T10:00:00Z') });

test('the text kind refuses an edit that could land in the wrong place', () => {
  const d = doc();
  assert.equal(textEdit.check({ file: 'content.md', find: 'The price is 40.', replace: 'The price is 45.' }, d), null);
  assert.equal(textEdit.check({ file: 'content.md', find: 'We ship in March', replace: 'x' }, d).code, 'ambiguous');
  assert.equal(textEdit.check({ file: 'content.md', find: 'not there', replace: 'x' }, d).code, 'not-found');
  assert.equal(textEdit.check({ file: 'content.md', find: '', replace: 'x' }, d).code, 'not-found');
  assert.equal(textEdit.check({ file: 'content.md', find: 'Plan', replace: 'Plan' }, d).code, 'no-change');
  assert.match(textEdit.check({ file: 'other.md', find: 'a', replace: 'b' }, d).problem, /other\.md is not part of this document \(files: content\.md, notes\.md\)/);
  const next = textEdit.apply({ file: 'notes.md', find: 'Loose', replace: 'Tidy $& $1' }, d);
  assert.equal(next['notes.md'], 'Tidy $& $1 notes.', 'replacement text is literal');
  assert.equal(d['notes.md'], 'Loose notes.', 'the document passed in is not changed');
  assert.throws(() => textEdit.validate({ file: 'a', find: 'b' }), ProposalError);
  assert.throws(() => textEdit.validate({ file: 'a', find: 'b\0', replace: 'c' }), ProposalError);
  assert.deepEqual(textEdit.validate({ file: 'a', find: 'b', replace: 'c', extra: 'dropped' }), { file: 'a', find: 'b', replace: 'c' });
});

test('make applies an edit at once and records it; a refused edit is not recorded', () => {
  const t = turn();
  const made = proposals.make(t, { file: 'content.md', find: 'The price is 40.', replace: 'The price is 45.', reason: 'New price' }, doc());
  assert.equal(made.ok, true);
  assert.match(made.doc['content.md'], /The price is 45\./);
  assert.deepEqual(t.proposals, [{ key: 'e0', file: 'content.md', find: 'The price is 40.', replace: 'The price is 45.', reason: 'New price', ok: true, auto: true, at: '2026-11-23T10:00:00.000Z' }]);
  const refused = proposals.make(t, { file: 'content.md', find: 'We ship in March', replace: 'We ship in April' }, made.doc);
  assert.deepEqual({ ok: refused.ok, code: refused.code }, { ok: false, code: 'ambiguous' });
  assert.equal(refused.doc, made.doc);
  assert.equal(proposals.make(t, { file: 'content.md' }, made.doc).code, 'invalid');
  assert.equal(proposals.make(t, { kind: 'shape', id: 1 }, made.doc).code, 'invalid', 'an unknown kind is refused, not thrown');
  assert.equal(t.proposals.length, 1);
  assert.equal(proposals.state(t.proposals[0], made.doc), 'applied');
  // The second edit builds on the first.
  const second = proposals.make(t, { file: 'content.md', find: 'The price is 45.', replace: 'The price is 45, before tax.' }, made.doc);
  assert.equal(second.proposal.key, 'e1');
  assert.deepEqual(proposals.appliedIn(t).map(p => p.key), ['e0', 'e1']);
});

test('offer holds an edit for a person, who applies or dismisses it', () => {
  const t = turn(), d = doc();
  const good = proposals.offer(t, { file: 'notes.md', find: 'Loose', replace: 'Tidy' }, { doc: d });
  const bad = proposals.offer(t, { file: 'notes.md', find: 'absent', replace: 'x' }, { doc: d });
  const unchecked = proposals.offer(t, { file: 'content.md', find: 'Plan', replace: 'The plan' });
  assert.deepEqual([good.ok, bad.ok, bad.problem, unchecked.ok, good.auto], [true, false, 'The text to replace is not in the document.', true, undefined]);
  assert.deepEqual([good, bad, unchecked].map(p => proposals.state(p, d)), ['ready', 'invalid', 'ready']);
  assert.equal(proposals.apply(t, 'e1', d).code, 'invalid');
  const applied = proposals.apply(t, 'e0', d);
  assert.equal(applied.doc['notes.md'], 'Tidy notes.');
  assert.equal(good.fate, 'applied');
  assert.equal(proposals.apply(t, 'e0', applied.doc).doc, applied.doc, 'applying twice changes nothing');
  assert.equal(proposals.dismiss(t, 'e2').fate, 'dismissed');
  assert.equal(proposals.dismiss(t, 'e0').fate, 'applied', 'an applied edit is undone, not dismissed');
  assert.equal(proposals.state(unchecked, d), 'dismissed');
  // The person edits the text first: the held proposal goes stale.
  const later = turn('t2'); proposals.offer(later, { file: 'notes.md', find: 'Loose', replace: 'Tidy' });
  assert.equal(proposals.state(later.proposals[0], { 'notes.md': 'Rewritten by hand.' }), 'stale');
  assert.equal(proposals.apply(later, 'e0', { 'notes.md': 'Rewritten by hand.' }).code, 'not-found');
  assert.throws(() => proposals.apply(t, 'e9', d), { code: 'not-found' });
});

test('undo reverses one edit, refuses when its text has changed, and tells the agent once', () => {
  const t = turn();
  let d = proposals.make(t, { file: 'content.md', find: 'The price is 40.', replace: 'The price is 45.', reason: 'New price' }, doc()).doc;
  d = proposals.make(t, { file: 'notes.md', find: 'Loose notes.', replace: 'Loose notes, kept short.' }, d).doc;
  const undone = proposals.undo(t, 'e0', d);
  assert.equal(undone.ok, true);
  assert.match(undone.doc['content.md'], /The price is 40\./);
  assert.deepEqual([t.proposals[0].fate, t.proposals[0].told], ['undone', false]);
  assert.equal(proposals.undo(t, 'e0', undone.doc).code, 'not-applied');
  // The person rewrote the second edit's text: undoing it would be a guess.
  const rewritten = { ...undone.doc, 'notes.md': 'Loose notes, kept very short.' };
  const refused = proposals.undo(t, 'e1', rewritten);
  assert.deepEqual({ ok: refused.ok, code: refused.code }, { ok: false, code: 'not-found' });
  assert.equal(t.proposals[1].fate, undefined);
  assert.deepEqual(proposals.feedback(t), ['A person undid your edit “New price”. Do not repeat it; read the document again.']);
  assert.deepEqual(proposals.feedback(t), [], 'told once');
  assert.equal(t.proposals[0].told, true);
});

test('undoRequest takes back a whole request in reverse order and keeps other people’s changes', () => {
  const t = turn();
  let d = { 'a.md': 'One. Two. Three.' };
  d = proposals.make(t, { file: 'a.md', find: 'One.', replace: 'First.' }, d).doc;
  d = proposals.make(t, { file: 'a.md', find: 'First. Two.', replace: 'First, then second.' }, d).doc;   // builds on the edit before it
  d = proposals.make(t, { file: 'a.md', find: 'Three.', replace: 'Third.' }, d).doc;
  d = { 'a.md': d['a.md'] + ' Added by the person.' };
  const result = proposals.undoRequest(t, d);
  assert.deepEqual(result.undone, ['e2', 'e1', 'e0']);
  assert.deepEqual(result.refused, []);
  assert.equal(result.doc['a.md'], 'One. Two. Three. Added by the person.');
  assert.equal(proposals.feedback([t]).length, 3);

  // One of the edits has since been changed by hand: it stays, the others go.
  const u = turn('t2');
  let e = { 'a.md': 'One. Two. Three.' };
  e = proposals.make(u, { file: 'a.md', find: 'One.', replace: 'First.' }, e).doc;
  e = proposals.make(u, { file: 'a.md', find: 'Three.', replace: 'Third.' }, e).doc;
  e = { 'a.md': e['a.md'].replace('First.', 'Firstly.') };
  const partial = proposals.undoRequest(u, e);
  assert.deepEqual(partial.undone, ['e1']);
  assert.deepEqual(partial.refused.map(r => [r.key, r.code]), [['e0', 'not-found']]);
  assert.equal(partial.doc['a.md'], 'Firstly. Two. Three.');
  assert.deepEqual(proposals.undoRequest({ id: 'empty' }, e), { doc: e, undone: [], refused: [] });
});

test('report records what a reader saw; replay gives the agent its own unreported edits', () => {
  const running = turn('r1'), finished = { ...turn('r0'), status: 'succeeded' };
  const browser = { 'a.md': 'One. Two. Three.' };          // the reader's copy: it has not applied anything yet
  let server = proposals.make(running, { file: 'a.md', find: 'One.', replace: 'First.' }, browser).doc;
  server = proposals.make(running, { file: 'a.md', find: 'Two.', replace: 'Second.' }, server).doc;
  proposals.make(finished, { file: 'a.md', find: 'Three.', replace: 'Third.' }, browser);
  // The browser posts its whole text, without the edits: the agent must still see them.
  assert.equal(proposals.replay([finished, running], browser)['a.md'], 'First. Second. Three.', 'only running turns are replayed');
  // Then it reports: one applied, one stale because the person changed that text first.
  assert.equal(proposals.report([finished, running], { 'r1:e0': 'applied', 'r1:e1': 'stale', 'r1:e9': 'applied', 'r0:e0': 'nonsense' }), 2);
  assert.equal(proposals.report([running], { 'r1:e0': 'applied' }), 0, 'the same report again changes nothing');
  assert.deepEqual(running.proposals.map(p => [p.fate, p.told]), [['applied', undefined], ['stale', false]]);
  const reported = { 'a.md': 'First. Two, said the person. Three.' };
  assert.equal(proposals.replay([running], reported)['a.md'], reported['a.md'], 'reported edits are not replayed');
  assert.deepEqual(proposals.feedback(running), ['The document had changed, so it did not take your edit “Second.”. Do not repeat it; read the document again.']);
  assert.deepEqual(proposals.appliedIn(running).map(p => p.key), ['e0']);
  assert.equal(proposals.report([running], null), 0);
  assert.deepEqual(FATES, ['applied', 'stale', 'undone', 'dismissed']);
});

test('a host adds its own kind of edit; the document is opaque to the rest', () => {
  // A canvas: the document is a map of shapes, and an edit sets one shape's text.
  const shape = {
    validate: e => { if (typeof e?.id !== 'string' || typeof e.text !== 'string') throw new ProposalError('A shape edit needs id and text.'); return { id: e.id, text: e.text, was: e.was }; },
    check: (e, canvas) => !canvas[e.id] ? { code: 'gone', problem: 'That shape was removed.' } : e.was !== undefined && canvas[e.id].text !== e.was ? { code: 'changed', problem: 'That shape was edited since.' } : null,
    apply: (e, canvas) => ({ ...canvas, [e.id]: { ...canvas[e.id], text: e.text } }),
    invert: e => ({ ...e, text: e.was, was: e.text }),
    label: e => `${e.id}: ${e.text}`,
  };
  const mixed = createProposals({ kinds: { text: textEdit, shape }, maxPerTurn: 2, wording: { undone: label => `Undone: ${label}` } });
  const t = turn();
  let canvas = { box1: { text: 'Draft', x: 10 } };
  const made = mixed.make(t, { kind: 'shape', id: 'box1', text: 'Final', was: 'Draft' }, canvas);
  assert.deepEqual(made.doc, { box1: { text: 'Final', x: 10 } });
  assert.equal(t.proposals[0].kind, 'shape');
  assert.equal(mixed.make(t, { kind: 'shape', id: 'gone', text: 'x' }, made.doc).code, 'gone');
  const back = mixed.undo(t, 'e0', made.doc);
  assert.deepEqual(back.doc, canvas);
  assert.deepEqual(mixed.feedback(t), ['Undone: box1: Final']);
  mixed.offer(t, { kind: 'shape', id: 'box1', text: 'Again' });
  assert.throws(() => mixed.offer(t, { kind: 'shape', id: 'box1', text: 'Third' }), { code: 'full' });
  assert.equal(mixed.make(t, { kind: 'shape', id: 'box1', text: 'Third' }, canvas).code, 'full');
  assert.throws(() => mixed.state({ kind: 'nope' }, canvas), ProposalError);
});

// ---------------------------------------------------------------- hardening

test('text an agent supplies cannot make the search run away, whatever its shape', () => {
  const body = 'a'.repeat(1_000_000), doc = { 'a.md': body };
  const cases = [['a', 'ambiguous'], ['a'.repeat(2000), 'ambiguous'], ['a'.repeat(50000) + 'b' + 'a'.repeat(49999), 'not-found'], ['b' + 'a'.repeat(99999), 'not-found'], ['a'.repeat(99999) + 'b', 'not-found']];
  for (const [find, code] of cases) {
    const began = performance.now();
    assert.equal(textEdit.check({ file: 'a.md', find, replace: 'z' }, doc)?.code, code);
    assert.ok(performance.now() - began < 1500, `${find.length} characters took ${Math.round(performance.now() - began)} ms`);
  }
});

test('long finds are located exactly: once, twice, at either end, overlapping, with astral characters', () => {
  let state = 7; const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
  const alphabet = ['a', 'b', 'ab', '🙂', 'é', '\n'];
  for (let round = 0; round < 300; round++) {
    const piece = () => alphabet[Math.floor(next() * alphabet.length)];
    let body = ''; for (let i = 0; i < 400 + next() * 2000; i++) body += piece();
    const at = Math.floor(next() * (body.length - 300)), find = body.slice(at, at + 260 + Math.floor(next() * 40));
    const expected = []; for (let i = body.indexOf(find); i >= 0 && expected.length < 2; i = body.indexOf(find, i + 1)) expected.push(i);
    const trouble = textEdit.check({ file: 'f', find, replace: 'Z' }, { f: body });
    assert.equal(trouble?.code ?? 'ok', expected.length > 1 ? 'ambiguous' : 'ok', `round ${round}`);
    if (!trouble) assert.equal(textEdit.apply({ file: 'f', find, replace: 'Z' }, { f: body }).f, body.slice(0, expected[0]) + 'Z' + body.slice(expected[0] + find.length));
  }
  const long = 'x'.repeat(300);
  assert.equal(textEdit.check({ file: 'f', find: long, replace: '' }, { f: `${long}y` }), null);
  assert.equal(textEdit.check({ file: 'f', find: long, replace: '' }, { f: `y${long}` }), null);
  assert.equal(textEdit.check({ file: 'f', find: long, replace: '' }, { f: `${long}x` }).code, 'ambiguous', 'overlapping occurrences count');
  assert.equal(textEdit.check({ file: 'f', find: long, replace: '' }, { f: long.slice(1) }).code, 'not-found');
});

test('file names that are also Object properties are just file names', () => {
  const p = createProposals(), t = { id: 't' };
  for (const file of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(p.make(t, { file, find: 'a', replace: 'b' }, { 'real.md': 'a' }).code, 'unknown-file', file);
    const made = p.make(t, { file, find: 'a', replace: 'b' }, Object.fromEntries([[file, 'a']]));
    assert.equal(made.ok, true, file);
    assert.equal(Object.getOwnPropertyDescriptor(made.doc, file)?.value, 'b', file);
  }
  assert.equal(({}).polluted, undefined);
});
