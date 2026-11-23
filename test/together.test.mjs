// The modules used together, as a small host would: a text document, a chat with an
// agent that edits through proposals, a routine run as a request, a comment handed to
// the agent, the agent told what a person did meanwhile, and a whole request undone.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createConversationStore } from '../server/conversations.mjs';
import { createRoutineSet } from '../server/routine-set.mjs';
import { createHistory } from '../server/history.mjs';
import { createProposals } from '../server/proposals.mjs';
import { createActivityFeed, describeEvents, formatActivity } from '../server/activity.mjs';
import { createThreadStore } from '../server/threads.mjs';
import { createWorkLog, routineStats } from '../server/worklog.mjs';
import { tempDir, until, beforeCleanup } from './helpers.mjs';

test('a small host: routine, edits, activity, comment hand-off, undo', async t => {
  const dir = await tempDir(t);
  let doc = { 'content.md': 'The price is 40. We shipp in March.' };           // the host owns the document
  const routines = createRoutineSet({ bankedDir: path.join(dir, 'routines'), engines: ['page'],
    shipped: [{ name: 'proofread', title: 'Proofread', code: 'Correct spelling. Change nothing else.' }] });
  const history = createHistory({ dir: path.join(dir, 'history') });
  const proposals = createProposals();
  const threads = createThreadStore({ dir: path.join(dir, 'threads') });
  const worklog = createWorkLog({ file: path.join(dir, 'work', 'log.jsonl') });
  const feed = createActivityFeed();
  const prompts = [];

  // A stand-in agent: it "edits" by calling the host's edit operation, as a real one would through a command.
  const agent = { async run({ key, input, edit }) {
    prompts.push({ key, input });
    if (/spelling/.test(input)) edit({ file: 'content.md', find: 'shipp', replace: 'ship', reason: 'Spelling' });
    if (/Is 40 right/.test(input)) { edit({ file: 'content.md', find: 'The price is 40.', replace: 'The price is 45.', reason: 'New price list' }); return { message: 'It was out of date: now 45.' }; }
    return { message: 'Done.' };
  } };

  const store = createConversationStore({ dir: path.join(dir, 'chats'), async run(turn, lane, signal, tools) {
    history.checkpoint('page', turn.id, { data: doc });
    feed.pending(lane.id, 'page');                                               // this agent's place in the feed starts here
    const edit = change => {
      const made = proposals.make(turn, change, doc);
      if (made.ok) { doc = made.doc; feed.claim('page', { kind: 'agent', name: lane.id }, [change.file]); feed.changed('page', [{ id: change.file, change: 'updated' }]); tools.save(); }
      return made.ok ? 'made' : `not made: ${made.problem}`;
    };
    const told = feed.pending(lane.id, 'page', { mine: actor => actor?.name === lane.id });
    const news = formatActivity(describeEvents(told.events, { change: (c, who) => `${who} changed ${c.id}` }));
    feed.ack(lane.id, told.upto, told.events);
    const result = await agent.run({ key: lane.id, input: [news, ...proposals.feedback(turn), tools.payload.prompt].filter(Boolean).join('\n'), edit });
    if (turn.routine) worklog.record({ doc: 'page', agent: 'person', routine: turn.routine });
    return { message: result.message };
  } });
  beforeCleanup(() => store.close());
  const finished = async turn => { await until(() => turn.status !== 'queued' && turn.status !== 'running'); return turn; };

  // 1. A routine run from a slash command becomes a turn: its title is shown, its prompt is sent.
  const request = routines.turnFor('/proofread', { engine: 'page' });
  const first = await finished(await store.send('page', { user: request.user, routine: request.routine, payload: { prompt: request.prompt } }));
  assert.deepEqual([first.status, first.user, first.routine, first.message], ['succeeded', 'Proofread', 'proofread', 'Done.']);
  assert.equal(doc['content.md'], 'The price is 40. We ship in March.');
  assert.deepEqual(first.proposals.map(p => [p.key, p.auto, p.reason]), [['e0', true, 'Spelling']]);
  assert.equal(prompts[0].key, 'page:main');
  assert.deepEqual(routineStats(worklog.read(), routines.list(), { person: 'person' }).routines.map(r => [r.name, r.runs, r.byPeople]), [['proofread', 1, 1]]);

  // 2. A person edits meanwhile; then a comment is handed to the agent, which is told what changed and replies on the thread.
  doc = { 'content.md': doc['content.md'] + ' Terms apply.' };
  feed.changed('page', [{ id: 'content.md', change: 'updated' }], { actor: { kind: 'person', name: 'Ada' } });
  const thread = threads.create('page', { anchor: { file: 'content.md', quote: 'The price is 40.' }, author: { kind: 'person', name: 'Ada' }, text: 'Is 40 right?' });
  const handed = await threads.handOff('page', thread.id, async ({ prompt }) => {
    const turn = await finished(await store.send('page', { user: `Comment #${thread.id}`, thread: thread.id, payload: { prompt } }));
    return { message: turn.message };
  }, { where: th => `on “${th.anchor.quote}”`, agent: 'Scout' });
  assert.equal(handed.thread.messages.at(-1).text, 'It was out of date: now 45.');
  assert.equal(handed.thread.messages.at(-1).author.name, 'Scout');
  assert.match(prompts[1].input, /^<activity>While you were working.*\n- Ada changed content\.md\n<\/activity>\nComment thread #1, on “The price is 40\.”\.\nAda: Is 40 right\?$/s);
  assert.equal(doc['content.md'], 'The price is 45. We ship in March. Terms apply.');

  // 3. The person takes back everything the second request did, edit by edit: their own sentence stays.
  const second = store.get('page').turns[1];
  const undone = proposals.undoRequest(second, doc);
  doc = undone.doc; await store.save('page');
  assert.deepEqual(undone.undone, ['e0']);
  assert.equal(doc['content.md'], 'The price is 40. We ship in March. Terms apply.');
  assert.deepEqual(proposals.feedback(second), ['A person undid your edit “New price list”. Do not repeat it; read the document again.']);

  // 4. Or wholesale, from the checkpoint taken when the first request began: everything since goes.
  const back = history.undoRequest('page', first.id, { current: { data: doc } });
  assert.deepEqual(back.data, { 'content.md': 'The price is 40. We shipp in March.' });
  // The document is now exactly as the second checkpoint saw it, so it is not saved again before the restore.
  assert.deepEqual(history.list('page').map(v => v.source), ['restore', 'checkpoint', 'checkpoint']);
  assert.deepEqual(store.get('page').turns.map(turn => turn.proposals.map(p => p.fate)), [[undefined], ['undone']]);
});
