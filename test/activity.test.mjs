import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityFeed, mergeEvents, describeEvents, formatActivity, actorName } from '../server/activity.mjs';

// A host's document: a map of part id -> text. Its differ names what was added, changed and removed.
const diff = (before, after) => [
  ...Object.keys(after).filter(id => !(id in before)).map(id => ({ id, change: 'added', after: after[id] })),
  ...Object.keys(after).filter(id => id in before && before[id] !== after[id]).map(id => ({ id, change: 'updated', before: before[id], after: after[id], what: ['text'] })),
  ...Object.keys(before).filter(id => !(id in after)).map(id => ({ id, change: 'removed', before: before[id] })),
];
function setup(options = {}) {
  const docs = { page: { p1: 'Intro', p2: 'Body' } };
  let clock = 1000;
  const feed = createActivityFeed({ snapshot: doc => docs[doc] ? { ...docs[doc] } : null, diff, now: () => clock, ...options });
  return { docs, feed, tick: ms => { clock += ms; } };
}
const scout = { kind: 'agent', name: 'Scout' };
const isScout = actor => actor?.kind === 'agent' && actor.name === 'Scout';

test('a change nobody claimed is a person’s; a claimed one is the agent’s', () => {
  const { docs, feed } = setup();
  feed.open('page');
  assert.deepEqual(feed.pending('chat', 'page'), { events: [], upto: 0, fresh: true, seen: new Map() }, 'a new reader starts at the present');
  docs.page.p1 = 'Intro, reworded by Ada';
  feed.claim('page', scout, ['p3']);
  docs.page.p3 = 'Added by the agent';
  delete docs.page.p2;
  const events = feed.settle('page');
  assert.deepEqual(events.map(e => [e.id, e.change, e.actor.kind, e.actor.name]), [['p3', 'added', 'agent', 'Scout'], ['p1', 'updated', 'person', undefined], ['p2', 'removed', 'person', undefined]]);
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3]);
  assert.equal(events[1].before, 'Intro');
  assert.deepEqual(feed.settle('page'), [], 'nothing changed since');
  assert.equal(feed.seq, 3);
});

test('each reader keeps its own place and is not told its own changes', () => {
  const { docs, feed } = setup();
  feed.open('page');
  feed.pending('chat', 'page'); feed.pending('terminal', 'page');
  feed.claim('page', scout, ['p1']); docs.page.p1 = 'By Scout'; feed.settle('page');
  docs.page.p2 = 'By a person';
  // pending settles first, so the person's edit from a moment ago is in.
  const forScout = feed.pending('chat', 'page', { mine: isScout });
  assert.deepEqual(forScout.events.map(e => e.id), ['p2']);
  assert.deepEqual(feed.pending('terminal', 'page').events.map(e => e.id), ['p1', 'p2'], 'another reader hears both');
  assert.deepEqual(feed.pending('chat', 'page', { mine: isScout }).events.map(e => e.id), ['p2'], 'not acknowledged yet: told again');
  feed.ack('chat', forScout.upto, forScout.events);
  assert.deepEqual(feed.pending('chat', 'page', { mine: isScout }).events, []);
  assert.deepEqual(feed.pending('terminal', 'page', { skip: e => e.id === 'p1' }).events.map(e => e.id), ['p2']);
  feed.ack('unknown-reader', 99);
  // A reader that moves to another document starts afresh there.
  assert.equal(feed.pending('chat', 'other').fresh, true);
});

test('claims expire, cover a part’s sub-parts, and the host’s own changes are never told', () => {
  const { docs, feed, tick } = setup({ claimMs: 1000 });
  feed.open('page'); feed.pending('chat', 'page');
  feed.claim('page', scout, ['p1']);
  tick(2000);
  docs.page.p1 = 'Changed long after the claim';
  assert.equal(feed.settle('page')[0].actor.kind, 'person', 'a stale claim does not make a person’s edit the agent’s');
  feed.claim('page', scout, ['label-of-p2']);
  assert.equal(feed.changed('page', [{ id: 'p2', change: 'updated', parts: ['label-of-p2'] }])[0].actor.name, 'Scout');
  assert.equal(feed.changed('page', [{ id: 'p2', change: 'updated', parts: ['label-of-p2'] }])[0].actor.kind, 'person', 'a claim is used once');
  feed.claim('page', { kind: 'system', name: 'autosave' }, ['p2']);
  feed.changed('page', [{ id: 'p2', change: 'updated' }]);
  feed.changed('page', [{ id: 'p9', change: 'added' }], { actor: { kind: 'system' } });
  assert.deepEqual(feed.pending('chat', 'page').events.map(e => [e.id, e.actor.kind]), [['p1', 'person'], ['p2', 'agent'], ['p2', 'person']]);
});

test('touched settles after changes pause, and waits for a run in flight to claim its work', async () => {
  let running = true;
  const docs = { page: { p1: 'a' } };
  const feed = createActivityFeed({ snapshot: doc => ({ ...docs[doc] }), diff, quietMs: 15, maxWaitMs: 200, claimMs: 300, busy: () => running });
  feed.open('page'); feed.pending('chat', 'page');
  docs.page.p1 = 'b'; feed.touched('page');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(feed.seq, 0, 'a run is in flight: wait for its claim');
  feed.claim('page', scout, ['p1']); running = false;
  await new Promise(r => setTimeout(r, 60));
  assert.equal(feed.seq, 1);
  assert.equal(feed.pending('chat', 'page').events[0].actor.name, 'Scout');
  docs.page.p1 = 'c'; feed.touched('page'); feed.close('page');
  assert.equal(feed.seq, 2, 'closing settles what changed last');
  feed.close('never-opened');
});

test('selections: only a change is news, and a reader is not told what it already knows', () => {
  const { feed, tick } = setup();
  feed.open('page');
  assert.equal(feed.selected('page', 'tab1', 'Ada', ['p1', 'p1']).keys.length, 1);
  feed.pending('chat', 'page');                       // joins knowing Ada has p1 selected
  assert.equal(feed.selected('page', 'tab1', 'Ada', ['p1']), null, 'the same selection again');
  feed.selected('page', 'tab1', 'Ada', ['p2']); feed.selected('page', 'tab1', 'Ada', ['p1']);   // away and back
  feed.selected('page', 'tab2', 'Ben', ['p2']);
  const { events, upto, seen } = feed.pending('chat', 'page');
  assert.deepEqual(describeEvents(events, { seen }), ['Ben selected p2'], 'a selection that went and came back is not news');
  feed.ack('chat', upto, events);
  tick(10);
  feed.selected('page', 'tab2', 'Ben', []);
  assert.deepEqual(describeEvents(feed.pending('chat', 'page').events, { seen }), ['Ben cleared their selection']);
  assert.deepEqual(feed.selections('page').map(s => [s.user, s.keys]), [['Ben', []], ['Ada', ['p1']]]);
  feed.left('page', 'tab2');
  assert.deepEqual(feed.selections('page').map(s => s.user), ['Ada']);
});

test('several changes to one part by one hand read as one, in the host’s words', () => {
  const ada = { kind: 'person', name: 'Ada' };
  const events = [
    { type: 'change', id: 'p1', change: 'updated', actor: ada, before: 'One', after: 'Two', what: ['text'] },
    { type: 'change', id: 'p2', change: 'added', actor: ada, after: 'New' },
    { type: 'note', actor: scout, text: 'replied on comment 3' },
    { type: 'change', id: 'p1', change: 'updated', actor: ada, before: 'Two', after: 'Three', what: ['text', 'moved'] },
    { type: 'change', id: 'p2', change: 'removed', actor: ada, before: 'New' },
    { type: 'change', id: 'p1', change: 'removed', actor: scout, before: 'Three' },
    { type: 'note', text: 'Version 4 was restored' },
  ];
  assert.deepEqual(mergeEvents(events).map(i => i.change ? [i.change.id, i.change.actor.name, i.change.before, i.change.after, i.change.what] : i.note.text),
    [['p1', 'Ada', 'One', 'Three', ['text', 'moved']], 'replied on comment 3', ['p1', 'Scout', 'Three', null, []], 'Version 4 was restored']);
  const change = ({ id, before, after }, who) => after === null ? `${who} removed ${id}` : before === null ? `${who} added ${id}` : `${who} changed ${id}: “${before}” → “${after}”`;
  const lines = describeEvents(events, { change });
  assert.deepEqual(lines, ['Ada changed p1: “One” → “Three”', 'Scout (agent) replied on comment 3', 'Scout (agent) removed p1', 'Version 4 was restored']);
  assert.deepEqual(describeEvents(events, { change, max: 2 }), [lines[0], lines[1], '… and 2 more changes.']);
  assert.deepEqual(describeEvents(events), ['Scout (agent) replied on comment 3', 'Version 4 was restored'], 'without wording for changes, only notes and selections are told');
  assert.equal(formatActivity([]), null);
  assert.equal(formatActivity(['Ada added p2'], { tag: 'page_activity', intro: 'News:' }), '<page_activity>News:\n- Ada added p2\n</page_activity>');
  assert.match(formatActivity(['x']), /^<activity>While you were working/);
  assert.deepEqual([actorName({ kind: 'agent' }), actorName({ kind: 'person' }, 'Marc'), actorName(undefined)], ['an agent (agent)', 'Marc', 'someone']);
});

test('the feed is bounded, notes are events, and readers can be forgotten by prefix', () => {
  const { feed } = setup({ keep: 3 });
  feed.pending('page', 'page'); feed.pending('page#7', 'page'); feed.pending('page:side', 'page'); feed.pending('pageant', 'page');
  for (let i = 0; i < 5; i++) feed.note('page', { actor: { kind: 'person', name: 'Ada' }, text: `said ${i}` });
  assert.deepEqual(feed.pending('page', 'page').events.map(e => e.text), ['said 2', 'said 3', 'said 4']);
  feed.forget('page');
  assert.equal(feed.pending('page#7', 'page').fresh, true);
  assert.equal(feed.pending('page:side', 'page').fresh, true);
  assert.equal(feed.pending('pageant', 'page').fresh, false, 'a key that merely starts the same is kept');
  // With no snapshot the host reports changes itself.
  const bare = createActivityFeed();
  bare.pending('r', 'd'); bare.open('d'); assert.deepEqual(bare.settle('d'), []);
  bare.changed('d', [{ id: 'x', change: 'added' }]);
  assert.equal(bare.pending('r', 'd').events.length, 1);
});
