import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createThreadStore, promptFor, transcript, unseen, ThreadError } from '../server/threads.mjs';
import { tempDir } from './helpers.mjs';

const ada = { kind: 'person', name: 'Ada' }, scout = { kind: 'agent', name: 'Scout' };
async function setup(t, options = {}) {
  const dir = await tempDir(t);
  let clock = Date.parse('2026-11-23T09:00:00Z');
  return { dir, threads: createThreadStore({ dir, now: () => (clock += 1000), ...options }) };
}

test('people and agents go back and forth; closing and reopening are recorded', async t => {
  const { dir, threads } = await setup(t);
  const thread = threads.create('page', { anchor: { file: 'content.md', start: 10, end: 24 }, author: ada, text: '  Is this figure right?  ', source: { imported: 'c-1' } });
  assert.deepEqual(thread, { id: 1, anchor: { file: 'content.md', start: 10, end: 24 }, status: 'open', created: '2026-11-23T09:00:01.000Z',
    messages: [{ author: ada, text: 'Is this figure right?', t: '2026-11-23T09:00:02.000Z' }], source: { imported: 'c-1' } });
  threads.reply('page', 1, { author: scout, text: 'It should be 45.' });
  threads.reply('page', '1', { author: {}, text: 'Thanks.' });
  assert.deepEqual(threads.get('page', 1).messages.map(m => [m.author.kind, m.author.name]), [['person', 'Ada'], ['agent', 'Scout'], ['person', 'Someone']]);
  const closed = threads.close('page', 1, { by: ada, reply: 'Fixed.' });
  assert.equal(closed.status, 'closed'); assert.deepEqual(closed.closed.by, ada); assert.equal(closed.messages.at(-1).text, 'Fixed.');
  assert.equal(threads.reply('page', 1, { author: ada, text: 'One more thing.' }).status, 'open', 'saying something in a closed thread opens it again');
  assert.equal(threads.get('page', 1).closed, undefined);
  threads.close('page', 1, { by: scout });
  assert.equal(threads.reopen('page', 1).status, 'open');
  assert.equal(threads.create('page', { anchor: null, author: ada, text: 'About the whole page.' }).id, 2);
  threads.close('page', 2);
  assert.deepEqual(threads.list('page').map(x => x.id), [1, 2]);
  assert.deepEqual(threads.list('page', { status: 'open' }).map(x => x.id), [1]);
  assert.deepEqual(threads.list('other'), []);
  assert.equal(transcript(threads.get('page', 2)), 'Ada: About the whole page.');
  assert.equal(threads.remove('page', 2).id, 2);
  assert.equal(threads.create('page', { author: ada, text: 'Ids are not reused.' }).id, 3);
  const file = path.join(dir, 'page.threads.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).next, 4);
});

test('errors: unknown threads, empty text, anchors the host refuses, a full thread', async t => {
  const cleanAnchor = a => { if (!a || typeof a.file !== 'string') throw new ThreadError('An anchor names a file.'); return { file: a.file }; };
  const { threads } = await setup(t, { cleanAnchor, limits: { messages: 2, text: 5, name: 3 } });
  assert.throws(() => threads.get('page', 1), { code: 'not-found', status: 404 });
  assert.throws(() => threads.reply('page', 9, { author: ada, text: 'x' }), { code: 'not-found' });
  assert.throws(() => threads.create('page', { anchor: { file: 'a.md' }, author: ada, text: '   ' }), /empty/);
  assert.throws(() => threads.create('page', { anchor: { region: 1 }, author: ada, text: 'x' }), /names a file/);
  const made = threads.create('page', { anchor: { file: 'a.md', extra: 'dropped' }, author: { kind: 'person', name: 'Adalbert' }, text: 'A long comment' });
  assert.deepEqual([made.anchor, made.messages[0].text, made.messages[0].author.name], [{ file: 'a.md' }, 'A lon', 'Ada']);
  threads.reply('page', 1, { author: ada, text: 'two' });
  assert.throws(() => threads.reply('page', 1, { author: ada, text: 'three' }), /full/);
  assert.equal(threads.get('page', 1).messages.length, 2, 'a refused change is not saved');
  assert.deepEqual(threads.reanchor('page', 1, { file: 'b.md' }).anchor, { file: 'b.md' });
  assert.throws(() => createThreadStore({}), TypeError);
});

test('the thread’s agent is told only what it has not seen', async t => {
  const { threads } = await setup(t);
  threads.create('page', { anchor: { file: 'a.md' }, author: ada, text: 'Shorten this.' });
  assert.equal(promptFor(threads.get('page', 1), { where: 'on “the second paragraph”' }), 'Comment thread #1, on “the second paragraph”.\nAda: Shorten this.');
  threads.markSeen('page', 1);
  assert.equal(promptFor(threads.get('page', 1), { where: th => `in ${th.anchor.file}`, label: 'Comment' }), 'Comment #1, in a.md.\nNothing new has been said: take this thread from where it stands.');
  // The agent answers having seen everything: its own words count as seen.
  assert.equal(threads.agentAnswered('page', 1, 'Done: two sentences now.', 'Scout').seen, 2);
  // A person speaks, then the agent's late answer lands: it had not seen that message, so it stays unseen.
  threads.reply('page', 1, { author: ada, text: 'Actually, keep the date.' });
  const late = threads.agentAnswered('page', 1, 'Also fixed a typo.');
  assert.equal(late.seen, 2);
  assert.deepEqual(unseen(late).map(m => m.text), ['Actually, keep the date.', 'Also fixed a typo.']);
  assert.equal(late.messages.at(-1).author.name, 'Agent');
  // Closed meanwhile: the agent's answer does not reopen it.
  threads.close('page', 1, { by: ada });
  assert.equal(threads.agentAnswered('page', 1, 'Noted.').status, 'closed');
});

test('handOff gives the thread to an agent and posts its final message as the reply', async t => {
  const { threads } = await setup(t);
  threads.create('page', { anchor: { file: 'a.md' }, author: ada, text: 'Is 40 right?' });
  const asked = [];
  const done = await threads.handOff('page', 1, async ({ prompt, thread }) => { asked.push(prompt); return { message: 'It is 45; I changed it.', provenance: { provider: 'test' } }; }, { where: 'on “The price is 40.”', agent: 'Scout' });
  assert.deepEqual(asked, ['Comment thread #1, on “The price is 40.”.\nAda: Is 40 right?']);
  assert.deepEqual(done.thread.messages.map(m => `${m.author.name}: ${m.text}`), ['Ada: Is 40 right?', 'Scout: It is 45; I changed it.']);
  assert.equal(done.thread.seen, 2);
  assert.equal(done.result.provenance.provider, 'test');
  // Next time only the new message is handed over.
  threads.reply('page', 1, { author: ada, text: 'And the total?' });
  await threads.handOff('page', 1, async ({ prompt }) => { asked.push(prompt); return 'Total updated.'; });
  assert.equal(asked[1], 'Comment thread #1.\nAda: And the total?');
  assert.equal(threads.get('page', 1).messages.at(-1).text, 'Total updated.');
  // An agent that replied some other way (through a command, say) returns nothing: no second reply is posted.
  threads.reply('page', 1, { author: ada, text: 'Thanks' });
  const quiet = await threads.handOff('page', 1, async () => { threads.agentAnswered('page', 1, 'Replied through its command.'); return {}; });
  assert.equal(quiet.thread.messages.length, 6);
  assert.equal(quiet.thread.seen, 6);
});

test('a hand-off that fails leaves the messages unseen, so they are told again', async t => {
  const { threads } = await setup(t);
  threads.create('page', { author: ada, text: 'First.' });
  threads.markSeen('page', 1);
  threads.reply('page', 1, { author: ada, text: 'Second.' });
  await assert.rejects(threads.handOff('page', 1, async () => { throw new Error('agent unavailable'); }), /agent unavailable/);
  assert.equal(threads.get('page', 1).seen, 1);
  assert.deepEqual(unseen(threads.get('page', 1)).map(m => m.text), ['Second.']);
  await assert.rejects(threads.handOff('page', 99, async () => ({})), { code: 'not-found' });
});

test('a host can keep threads in storage of its own', async () => {
  const kept = new Map();
  const threads = createThreadStore({ storage: { load: key => kept.get(key) ? structuredClone(kept.get(key)) : null, save: (key, data) => kept.set(key, structuredClone(data)) } });
  threads.create('repo/page', { anchor: { post: 3 }, author: ada, text: 'Kept elsewhere.' });
  assert.equal(kept.get('repo/page').threads[0].messages[0].text, 'Kept elsewhere.');
  assert.equal(threads.get('repo/page', 1).anchor.post, 3);
});
