// The agent's memory across a restart: the id of its thread or session is kept with the
// conversation, and the first run of a new process takes the thread up again.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexAppServerProvider } from '../server/providers/codex-app-server.mjs';
import { AcpProvider } from '../server/providers/acp.mjs';
import { createConversationStore as create, readConversation } from '../server/conversations.mjs';
import { fixture, tempDir, until, readLines, beforeCleanup, deferred } from './helpers.mjs';

const settled = turn => until(() => ['succeeded', 'failed', 'stopped'].includes(turn.status));
const codex = (dir, log) => new CodexAppServerProvider({ command: [process.execPath, fixture('fake-app-server.mjs')], workDir: path.join(dir, 'work'), env: { ...process.env, FAKE_LOG: log, FAKE_THREADS: path.join(dir, 'threads.json') } });
const acp = dir => new AcpProvider({ command: [process.execPath, fixture('fake-acp-agent.mjs')], workDir: path.join(dir, 'acp-work'), env: { ...process.env, FAKE_ACP: JSON.stringify({ load: true }), FAKE_STORE: path.join(dir, 'sessions.json') } });

test('Codex: a thread id from an earlier process is resumed, and provenance says whether memory was kept or lost', async t => {
  const dir = await tempDir(t), log = path.join(dir, 'log.jsonl'), sent = async method => (await readLines(log)).filter(m => m.method === method);
  const before = codex(dir, log);
  t.after(() => before.close());
  assert.equal(before.capabilities.resume, true);
  const one = await before.run({ key: 'doc:main', input: 'remember the word heron', instructions: 'Be brief.' });
  const two = await before.run({ key: 'doc:main', input: 'again' });
  assert.deepEqual([one.message, one.provenance.memory, two.message, two.provenance.memory], ['turn 1: remember the word heron', 'new', 'turn 2: again', 'kept']);
  before.close();
  // A new process: nothing in memory but the id the host kept.
  const after = codex(dir, log);
  t.after(() => after.close());
  const three = await after.run({ key: 'doc:main', input: 'what was the word', instructions: 'Be brief.', threadId: one.provenance.threadId, sandbox: { mode: 'workspace-write', cwd: dir, writableRoots: [dir] }, approvalPolicy: 'on-request' });
  assert.deepEqual([three.message, three.provenance.memory, three.provenance.threadId], ['turn 3: what was the word', 'resumed', one.provenance.threadId], 'the agent carried on from its third turn');
  const [resume] = await sent('thread/resume');
  assert.deepEqual({ ...resume.params, config: 0 }, { threadId: one.provenance.threadId, cwd: dir, approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructions: 'Be brief.', config: 0, model: 'fake-model', excludeTurns: true });
  assert.equal((await sent('thread/start')).length, 1, 'no second thread was started');
  assert.deepEqual(three.usage, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10, totalTokens: 150 }, 'usage is this turn\'s, not the whole thread\'s');
  const four = await after.run({ key: 'doc:main', input: 'and again', threadId: one.provenance.threadId });
  assert.deepEqual([four.message, four.provenance.memory], ['turn 4: and again', 'kept']);
  assert.equal((await sent('thread/resume')).length, 1, 'resumed once; after that the thread is simply held');
  // An id the agent no longer has: a new thread, and the host is told the memory is gone.
  const lost = await after.run({ key: 'other:main', input: 'hello', threadId: 't-gone-1' });
  assert.deepEqual([lost.message, lost.provenance.memory], ['turn 1: hello', 'lost']);
  assert.notEqual(lost.provenance.threadId, 't-gone-1');
  // reset() forgets for good: handed the old id again, the provider does not go back to it.
  after.reset('doc:main');
  const fresh = await after.run({ key: 'doc:main', input: 'start over', threadId: one.provenance.threadId });
  assert.deepEqual([fresh.message, fresh.provenance.memory], ['turn 1: start over', 'new']);
  assert.equal((await sent('thread/resume')).length, 2);
  // An agent that does not repeat its last usage report after a resume: the first report of the turn, less its own part, is the starting point.
  const silent = new CodexAppServerProvider({ command: [process.execPath, fixture('fake-app-server.mjs')], workDir: path.join(dir, 'work'), env: { ...process.env, FAKE_THREADS: path.join(dir, 'threads.json'), FAKE_NO_USAGE_REPLAY: '1' } });
  t.after(() => silent.close());
  const quiet = await silent.run({ key: 'q', input: 'once more', threadId: lost.provenance.threadId });
  assert.deepEqual([quiet.message, quiet.provenance.memory, quiet.usage.totalTokens, quiet.usage.inputTokens], ['turn 2: once more', 'resumed', 150, 100]);
  // A thread another key already holds is not taken by a second key.
  const taken = await after.run({ key: 'third:main', input: 'mine?', threadId: fresh.provenance.threadId });
  assert.deepEqual([taken.message, taken.provenance.memory], ['turn 1: mine?', 'new']);
});

test('the store keeps the id with the conversation, hands it to the next process, and forgets it on reset', async t => {
  const dir = await tempDir(t), log = path.join(dir, 'log.jsonl'), chats = path.join(dir, 'chats'), seen = [];
  const host = () => {
    const provider = codex(dir, log), gate = deferred();
    const store = create({ dir: chats, maxLanes: 2, run: async (turn, lane, signal, tools) => {
      seen.push([lane.name === 'main' ? 'main' : 'side', tools.resume]);
      const result = await provider.run({ key: lane.id, input: turn.user, ...tools.resume, signal });
      if (turn.user === 'hold the main lane') await gate.promise;
      return { message: result.message, provenance: result.provenance };
    } });
    const close = async () => { provider.close(); await store.close(); };
    t.after(close);                                           // whatever happens in the test, nothing is left running
    return { provider, store, gate, close };
  };
  let now = host();
  const first = await now.store.send('doc', { user: 'remember the word heron' }); await settled(first);
  assert.deepEqual(now.store.get('doc').memory, { main: { provider: 'codex-app-server', threadId: first.provenance.threadId } });
  await now.store.flush();
  assert.deepEqual((await readConversation(chats, 'doc')).memory, now.store.get('doc').memory, 'on disk with the conversation');
  // A side lane's agent is used once and thrown away: it neither reads nor writes the conversation's memory.
  const holding = await now.store.send('doc', { user: 'hold the main lane' });
  await until(() => seen.length === 2);
  const side = await now.store.send('doc', { user: 'beside it' }); await settled(side);
  assert.deepEqual(seen.at(-1), ['side', {}]);
  now.gate.resolve(); await settled(holding);
  assert.equal(now.store.get('doc').memory.main.threadId, first.provenance.threadId);
  await now.close();

  now = host();                                               // the host restarts: a new store, a new provider, a new agent process
  const second = await now.store.send('doc', { user: 'what was the word' }); await settled(second);
  assert.deepEqual(seen.at(-1), ['main', { threadId: first.provenance.threadId }]);
  assert.deepEqual([second.message, second.provenance.memory, second.provenance.threadId], ['turn 3: what was the word', 'resumed', first.provenance.threadId]);
  // Reset: a new conversation, so the old thread is not taken up again.
  await now.store.reset('doc');
  assert.equal(now.store.get('doc').memory, undefined);
  now.provider.reset('doc:main');
  const third = await now.store.send('doc', { user: 'a fresh start' }); await settled(third);
  assert.deepEqual(seen.at(-1), ['main', {}]);
  assert.deepEqual([third.message, third.provenance.memory], ['turn 1: a fresh start', 'new']);
  assert.equal(await now.store.forget('doc'), true);
  assert.equal(now.store.get('doc').memory, undefined);
  assert.equal(await now.store.forget('doc'), false);
  await now.store.flush();
  assert.equal((await readConversation(chats, 'doc')).memory, undefined);
  await now.close();
});

test('ACP: the same through session/load, with the same words in provenance', async t => {
  const dir = await tempDir(t), chats = path.join(dir, 'chats');
  const host = () => {
    const provider = acp(dir);
    const store = create({ dir: chats, run: async (turn, lane, signal, tools) => { const result = await provider.run({ key: lane.id, input: turn.user, ...tools.resume, signal }); return { message: result.message, provenance: result.provenance }; } });
    const close = async () => { provider.close(); await store.close(); };
    t.after(close);
    return { provider, store, close };
  };
  let now = host();
  assert.equal(now.provider.capabilities.resume, true);
  const first = await now.store.send('doc', { user: 'one' }); await settled(first);
  const again = await now.store.send('doc', { user: 'two' }); await settled(again);
  assert.deepEqual([first.provenance.memory, again.provenance.memory], ['new', 'kept']);
  assert.deepEqual(now.store.get('doc').memory, { main: { provider: 'acp', sessionId: first.provenance.sessionId } });
  await now.close();
  now = host();
  const second = await now.store.send('doc', { user: 'three' }); await settled(second);
  assert.deepEqual([second.message, second.provenance.memory, second.provenance.session, second.provenance.sessionId], ['turn 3: three', 'resumed', 'loaded', first.provenance.sessionId]);
  // An id the agent does not know is reported as lost; one the host asked to forget is not offered again.
  const lost = await now.provider.run({ key: 'elsewhere', input: 'x', sessionId: 'no-such-session' });
  assert.deepEqual([lost.message, lost.provenance.memory], ['turn 1: x', 'lost']);
  now.provider.reset('doc:main');
  const fresh = await now.provider.run({ key: 'doc:main', input: 'y', sessionId: first.provenance.sessionId });
  assert.deepEqual([fresh.message, fresh.provenance.memory], ['turn 1: y', 'new']);
  await now.close();
});
