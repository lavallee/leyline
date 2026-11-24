import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { AcpProvider, diffToEdit, sliceLines, ACP_PROTOCOL_VERSION } from '../server/providers/acp.mjs';
import { ProviderError, foldActivity, assertProvider } from '../server/providers/index.mjs';
import { createProposals } from '../server/proposals.mjs';
import { fixture, tempDir, readLines, until, deferred } from './helpers.mjs';

const FAKE = [process.execPath, fixture('fake-acp-agent.mjs')];

async function setup(t, options = {}, { agent = {}, dir } = {}) {
  dir ||= await tempDir(t);
  const log = path.join(dir, `log-${Math.random().toString(16).slice(2)}.jsonl`);
  const provider = new AcpProvider({ command: FAKE, workDir: path.join(dir, 'work'), clientInfo: { name: 'testhost', title: 'Test Host', version: '1.2.3' },
    env: { ...process.env, FAKE_LOG: log, FAKE_ACP: JSON.stringify(agent), FAKE_STORE: path.join(dir, 'sessions.json'), FAKE_SECRET: 'x' }, cancelGrace: 300, ...options });
  t.after(() => provider.close());
  const received = async method => (await readLines(log)).filter(m => m.method === method);
  // What this client answered to the agent's own requests (their ids start at 9001).
  const answers = async () => (await readLines(log)).filter(m => m.method === undefined && m.id > 9000);
  return { provider, dir, log, received, answers };
}

test('the handshake offers version 1 and only the capabilities that have something behind them', async t => {
  const { provider, log, received } = await setup(t, { dropEnv: ['FAKE_SECRET'] });
  assertProvider(provider);
  assert.equal(provider.name, 'acp');
  const agent = await provider.start();
  assert.equal(agent.info.name, 'fake-agent');
  const [hello] = await received('initialize');
  assert.deepEqual(hello.params, { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'testhost', title: 'Test Host', version: '1.2.3' } });
  assert.equal(ACP_PROTOCOL_VERSION, 1);
  await provider.run({ key: 'a', input: 'hello' });
  const lines = await readLines(log);
  assert.deepEqual(lines[0].env, { hasSecret: false }, 'dropEnv removes a variable from the child');
  assert.ok(lines.slice(1).every(m => m.jsonrpc === '2.0'), 'every message is JSON-RPC 2.0');
  assert.equal((await received('initialize')).length, 1);
  assert.equal((await received('authenticate')).length, 0);

  const hooks = { create() {}, output() {}, waitForExit() {}, kill() {}, release() {} };
  const full = await setup(t, { roots: [path.sep], writeFile() {}, terminal: hooks });
  await full.provider.start();
  assert.deepEqual((await full.received('initialize'))[0].params.clientCapabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: true });
  const reader = await setup(t, { readFile: () => 'x' });
  await reader.provider.start();
  assert.deepEqual((await reader.received('initialize'))[0].params.clientCapabilities.fs, { readTextFile: true, writeTextFile: false });
});

test('an agent that answers with another protocol version is refused, and says which', async t => {
  const { provider } = await setup(t, {}, { agent: { version: 2 } });
  await assert.rejects(provider.run({ key: 'a', input: 'hello' }), error => error instanceof ProviderError && error.code === 'unavailable' && /version 2;.*version 1 only/.test(error.message));
});

test('a turn streams text, thoughts, tool calls, a plan and diffs as normalised events', async t => {
  const { provider, received } = await setup(t);
  const events = [], items = [], pieces = [], diffs = [], raw = [];
  const result = await provider.run({ key: 'doc:main', input: ['<draft>hello</draft>', 'tidy it'], onEvent: event => { events.push(event); foldActivity(items, event); },
    onText: (piece, at) => pieces.push([piece, at.segment]), onDiff: diff => diffs.push(diff), onUpdate: update => raw.push(update.sessionUpdate) });
  assert.equal(result.message, 'turn 1: <draft>hello</draft> | tidy it', 'the last message is the reply');
  assert.deepEqual(pieces, [['Looking ', 0], ['around first.', 0], ['turn 1: <draft>hello</draft> | tidy it', 1]]);
  const { sessionId, ...provenance } = result.provenance;
  assert.match(sessionId, /^s1-\d+$/);
  assert.deepEqual(provenance, { provider: 'acp', agent: 'fake-agent', agentVersion: '0.0.1', model: 'fake-model', session: 'new', memory: 'new', protocolVersion: 1, stopReason: 'end_turn' });
  assert.deepEqual(result.usage, { contextTokens: 1200, contextSize: 200000, cost: { amount: 0.01, currency: 'USD' } });

  for (const event of events) {
    assert.ok(['reasoning', 'activity'].includes(event.kind), 'kind is normalised');
    assert.ok(['running', 'done', 'failed'].includes(event.status), 'status is normalised');
    assert.ok(Object.keys(event).every(k => ['id', 'kind', 'title', 'text', 'append', 'command', 'paths', 'status', 'toolKind'].includes(k)), `no stray fields: ${Object.keys(event)}`);
  }
  const by = id => items.find(a => a.id === id);
  assert.deepEqual([by('thought-1').kind, by('thought-1').text, by('thought-1').status], ['reasoning', 'Reading the text.', 'done']);
  assert.equal(by('thought-2').text, 'Now the edit.', 'a thought after other work is a new item');
  assert.equal(by('plan').text, '[x] Look around\n[x] Change the date\n[x] Check');
  assert.equal(by('plan').status, 'done');
  assert.equal(events.find(e => e.id === 'plan').text, '[x] Look around\n[~] Change the date\n[ ] Check');
  assert.equal(events.find(e => e.id === 'plan').status, 'running');
  assert.deepEqual([by('note-1').title, by('note-1').text], ['Agent note', 'Looking around first.']);
  assert.deepEqual(events.filter(e => e.id === 'c1').map(e => e.status), ['running', 'running', 'done'], 'pending and in_progress are both running');
  assert.deepEqual([by('c1').title, by('c1').text, by('c1').paths], ['Reading notes/a.md', '12 lines', ['/work/notes/a.md']]);
  assert.equal(events.find(e => e.id === 'c1').toolKind, 'read');
  assert.deepEqual([by('c2').command, by('c2').status, by('c2').text], ['ls notes', 'failed', 'ls: no such folder']);
  assert.deepEqual([by('c3').status, by('c3').paths], ['done', ['/work/notes/a.md']]);
  assert.equal(by('c4').title, 'Using a tool', 'a call with no title is named for its kind');
  assert.deepEqual(items.map(a => a.id), ['thought-1', 'plan', 'c1', 'c2', 'thought-2', 'c3', 'c4', 'note-1']);

  assert.deepEqual(diffs.map(d => [d.id, d.status]), [['c3:0', 'pending'], ['c3:0', 'in_progress'], ['c3:0', 'completed'], ['c4:0', 'completed']]);
  assert.deepEqual(diffs[2], { id: 'c3:0', toolCallId: 'c3', index: 0, path: '/work/notes/a.md', oldText: 'We meet in March.\n', newText: 'We meet in April.\n',
    status: 'completed', title: 'Editing notes/a.md', toolKind: 'edit', key: 'doc:main', sessionId });
  assert.equal(diffs[3].oldText, null, 'a new file has no old text');
  assert.deepEqual(diffToEdit(diffs[2], { file: 'a.md' }), { ok: true, edit: { file: 'a.md', find: 'We meet in March.', replace: 'We meet in April.' } });
  assert.equal(diffToEdit(diffs[3]).code, 'new-file');
  assert.ok(raw.includes('available_commands_update'), 'onUpdate sees updates the mapping ignores');

  const [created] = await received('session/new'), [prompt] = await received('session/prompt');
  assert.deepEqual(created.params, { cwd: provider.workDir, mcpServers: [] });
  assert.deepEqual(prompt.params.prompt, [{ type: 'text', text: '<draft>hello</draft>' }, { type: 'text', text: 'tidy it' }]);

  const whole = await setup(t, { reply: 'all' });
  assert.equal((await whole.provider.run({ key: 'a', input: 'x' })).message, 'Looking around first.\n\nturn 1: x');
});

test('a key keeps its session; a new key or a reset gets a fresh one', async t => {
  const { provider, received } = await setup(t, {}, { agent: { close: true } });
  const first = await provider.run({ key: 'a', input: 'one' });
  const second = await provider.run({ key: 'a', input: 'two' });
  assert.equal(second.message, 'turn 2: two', 'the session remembers');
  assert.equal(second.provenance.sessionId, first.provenance.sessionId);
  assert.equal(second.provenance.session, 'kept');
  assert.equal((await provider.run({ key: 'b', input: 'three' })).message, 'turn 1: three');
  provider.reset('a');
  assert.equal((await provider.run({ key: 'a', input: 'four' })).message, 'turn 1: four');
  assert.equal((await received('session/new')).length, 3);
  assert.deepEqual((await received('session/close')).map(m => m.params.sessionId), [first.provenance.sessionId], 'the agent is told, where it says it can be');
  assert.equal((await received('initialize')).length, 1, 'one child serves every session');
});

test('a saved session id is loaded by a new provider, and the replayed history is not taken for a reply', async t => {
  const dir = await tempDir(t);
  const before = await setup(t, {}, { agent: { load: true }, dir });
  const first = await before.provider.run({ key: 'doc', input: 'one' });
  before.provider.close();

  const after = await setup(t, {}, { agent: { load: true }, dir });
  const events = [], pieces = [];
  const second = await after.provider.run({ key: 'doc', input: 'two', sessionId: first.provenance.sessionId, onEvent: e => events.push(e), onText: piece => pieces.push(piece) });
  assert.equal(second.message, 'turn 2: two', 'memory survived the restart');
  assert.deepEqual([second.provenance.session, second.provenance.sessionId], ['loaded', first.provenance.sessionId]);
  assert.ok(!JSON.stringify([events, pieces, second.message]).includes('REPLAYED'));
  assert.deepEqual((await after.received('session/load'))[0].params, { sessionId: first.provenance.sessionId, cwd: after.provider.workDir, mcpServers: [] });
  assert.equal((await after.received('session/new')).length, 0);

  const lost = await after.provider.run({ key: 'other', input: 'x', sessionId: 'no-such-session' });
  assert.deepEqual([lost.message, lost.provenance.session], ['turn 1: x', 'new'], 'an id the agent does not know starts a new session, and provenance says so');

  const resuming = await setup(t, {}, { agent: { load: true, resume: true }, dir });
  const third = await resuming.provider.run({ key: 'doc', input: 'three', sessionId: first.provenance.sessionId });
  assert.deepEqual([third.message, third.provenance.session], ['turn 3: three', 'resumed'], 'session/resume is preferred: no replay');
  assert.equal((await resuming.received('session/load')).length, 0);

  const cannot = await setup(t, {}, { dir });
  const fresh = await cannot.provider.run({ key: 'doc', input: 'four', sessionId: first.provenance.sessionId });
  assert.deepEqual([fresh.message, fresh.provenance.session], ['turn 1: four', 'new'], 'an agent that does not advertise loading is never asked to');
  assert.equal((await cannot.received('session/load')).length, 0);
});

test('fs/read_text_file is served from the host hook, and otherwise only inside the roots', async t => {
  const dir = await tempDir(t), root = path.join(dir, 'site'), secret = path.join(dir, 'secret.txt');
  await mkdir(root); await writeFile(path.join(root, 'on-disk.md'), 'disk one\ndisk two\ndisk three\n'); await writeFile(secret, 'keep out');
  await symlink(secret, path.join(root, 'link.md'));
  const draft = path.join(root, 'content.md'), seen = [];
  const { provider } = await setup(t, { roots: [root], readFile: (file, context) => { seen.push([file, context.key, context.line, context.limit]); return file === draft ? 'live one\nlive two\nlive three' : undefined; } }, { dir });
  const ask = async text => (await provider.run({ key: 'k', input: text })).message;
  assert.equal(await ask(`readfile ${draft}`), 'read: {"content":"live one\\nlive two\\nlive three"}', 'the draft, which is not on disk at all');
  assert.equal(await ask(`readfile ${draft} 2 1`), 'read: {"content":"live two"}', 'line and limit are applied to what the hook returns');
  assert.deepEqual(seen[1], [draft, 'k', 2, 1]);
  assert.equal(await ask(`readfile ${path.join(root, 'on-disk.md')}`), 'read: {"content":"disk one\\ndisk two\\ndisk three\\n"}', 'the hook passed, so the default reader served it');
  assert.match(await ask(`readfile ${secret}`), /^read: refused 4030: That file is outside/);
  assert.match(await ask(`readfile ${path.join(root, '..', 'secret.txt')}`), /refused 4030/);
  assert.match(await ask(`readfile ${path.join(root, 'link.md')}`), /refused 4030/, 'a link inside a root does not lead out of it');
  assert.match(await ask(`readfile ${path.join(root, 'missing.md')}`), /refused -32002/);
  assert.match(await ask('readfile relative.md'), /refused -32602/);
  assert.match(await ask('strange-session'), /refused -32002/, 'a request for a session this client does not hold');
  assert.match(await ask('unknown-method'), /refused -32601: Method not found: editor\/open/);

  const refusing = await setup(t, { readFile: () => { throw new Error('Not that one.'); } }, { dir });
  assert.match((await refusing.provider.run({ key: 'k', input: `readfile ${draft}` })).message, /refused -32603: Not that one\./);
  const bare = await setup(t, {}, { dir });
  assert.match((await bare.provider.run({ key: 'k', input: `readfile ${path.join(root, 'on-disk.md')}` })).message, /refused -32601/, 'no roots and no hook: reads are not served');
  assert.match((await bare.provider.run({ key: 'k', input: `writefile ${draft} "a" "b"` })).message, /refused -32601/);
  assert.equal(sliceLines('a\nb\nc', 2), 'b\nc');
  assert.equal(sliceLines('a\nb\nc', null, 2), 'a\nb');
  assert.equal(sliceLines('a\nb\nc'), 'a\nb\nc');
});

// The wiring the README gives: the agent reads the live draft, and its write becomes a
// proposal the person can undo, instead of a change to a file.
test('fs/write_text_file becomes a proposal on the live draft, by the README wiring', async t => {
  const dir = await tempDir(t), file = path.join(dir, 'site', 'content.md');
  const proposals = createProposals();
  let doc = { 'content.md': 'Title\n\nWe meet in March.\nBring notes.\n' };       // the host's live draft
  const turns = new Map();                                                          // conversation key -> the turn in flight
  const fileOf = name => name === file ? 'content.md' : null;
  const { provider, received } = await setup(t, {
    readFile: name => { const part = fileOf(name); return part ? doc[part] : undefined; },
    writeFile: (name, content, { key }) => {
      const part = fileOf(name);
      if (!part) throw new Error('Only the document can be written.');
      const change = diffToEdit({ path: name, oldText: doc[part], newText: content }, { file: part });
      if (!change.ok) throw new Error(change.problem);
      const made = proposals.make(turns.get(key), { ...change.edit, reason: 'Written by the agent' }, doc);
      if (!made.ok) throw new Error(made.problem);
      doc = made.doc;
    },
  }, { dir });
  const turn = { id: 't1', status: 'running' };
  turns.set('doc', turn);
  assert.equal((await provider.run({ key: 'doc', input: `writefile ${file} "March" "April"` })).message, 'written');
  assert.equal(doc['content.md'], 'Title\n\nWe meet in April.\nBring notes.\n');
  assert.equal(turn.proposals.length, 1);
  const { at, ...proposal } = turn.proposals[0];
  assert.deepEqual(proposal, { key: 'e0', file: 'content.md', find: 'We meet in March.', replace: 'We meet in April.', reason: 'Written by the agent', ok: true, auto: true });
  assert.equal((await received('fs/write_text_file')).length, 0, 'sanity: that method is the agent\'s to call, not ours');

  ({ doc } = proposals.undo(turn, 'e0', doc));
  assert.equal(doc['content.md'], 'Title\n\nWe meet in March.\nBring notes.\n', 'a person takes it back');
  assert.match(proposals.feedback(turn)[0], /A person undid your edit/);

  assert.match((await provider.run({ key: 'doc', input: `writefile ${file} "nothing here" "x"` })).message, /^write refused -32603: Nothing changes\./, 'the agent is told why a write did not go in');
  assert.match((await provider.run({ key: 'doc', input: `writefile ${path.join(dir, 'other.md')} "a" "b"` })).message, /^read refused/);
});

test('a permission request waits for an async hook, and is refused by default', async t => {
  const asked = deferred(), decision = deferred();
  const { provider, answers } = await setup(t, { onPermission: request => { asked.resolve(request); return decision.promise; } });
  const events = [];
  const run = provider.run({ key: 'a', input: 'permission edit /work/a.md', onEvent: e => events.push(e), idleTimeout: 300 });
  const request = await asked.promise, since = Date.now();
  assert.deepEqual(request.options.map(o => o.optionId), ['yes-always', 'yes', 'no']);
  assert.deepEqual([request.key, request.toolCall.toolCallId, request.toolCall.kind, request.toolCall.title], ['a', 'p1', 'edit', 'Touching /work/a.md']);
  assert.deepEqual(request.diffs, [{ type: 'diff', path: '/work/a.md', oldText: 'one\n', newText: 'two\n' }]);
  await until(() => Date.now() - since > 900);                // three idle limits pass with the agent silent
  assert.equal((await answers()).length, 0, 'nothing is answered, and the idle clock does not run, while a person decides');
  decision.resolve('allow_once');
  assert.equal((await run).message, 'permission: {"outcome":{"outcome":"selected","optionId":"yes"}}');

  const denying = await setup(t);
  assert.equal((await denying.provider.run({ key: 'a', input: 'permission read /work/a.md' })).message, 'permission: {"outcome":{"outcome":"selected","optionId":"no"}}', 'the default policy rejects');
  await assert.rejects(denying.provider.run({ key: 'a', input: 'permission read /work/a.md no-reject' }), { code: 'stopped' });
  assert.deepEqual((await denying.answers()).at(-1).result, { outcome: { outcome: 'cancelled' } }, 'with no way to reject, the answer is never an allow');

  const hooked = async (answer, input = 'permission edit /work/a.md') => {
    const { provider } = await setup(t, { onPermission: () => answer() });
    return (await provider.run({ key: 'a', input })).message.replace('permission: ', '');
  };
  const selected = optionId => JSON.stringify({ outcome: { outcome: 'selected', optionId } });
  assert.equal(await hooked(() => 'yes-always'), selected('yes-always'), 'an option id is passed through: "always" is the host\'s to say');
  assert.equal(await hooked(() => 'allow_always'), selected('yes-always'));
  assert.equal(await hooked(() => 'reject_always'), selected('no'), 'a kind the agent did not offer is a rejection');
  assert.equal(await hooked(() => 'anything else'), selected('no'));
  assert.equal(await hooked(() => { throw new Error('broken hook'); }), selected('no'), 'a hook that throws rejects');
  assert.equal(await hooked(() => undefined), selected('no'), 'a hook that does not decide leaves it to the policy');
});

test("the 'allow-read' policy allows reads inside the session folder or the roots, once, and nothing else", async t => {
  const dir = await tempDir(t), root = path.join(dir, 'site');
  const { provider } = await setup(t, { permission: 'allow-read', roots: [root] }, { dir });
  const ask = async input => (await provider.run({ key: 'a', input })).message.replace('permission: ', '');
  const selected = optionId => JSON.stringify({ outcome: { outcome: 'selected', optionId } });
  assert.equal(await ask(`permission read ${path.join(root, 'a.md')}`), selected('yes'), 'allowed once, never always');
  assert.equal(await ask(`permission search ${path.join(provider.workDir, 'notes')}`), selected('yes'));
  assert.equal(await ask('permission read /etc/passwd'), selected('no'), 'a read outside is not allowed');
  assert.equal(await ask(`permission read ${path.join(root, '..', 'secret')}`), selected('no'));
  for (const kind of ['edit', 'execute', 'delete', 'fetch', 'other']) assert.equal(await ask(`permission ${kind} ${path.join(root, 'a.md')}`), selected('no'), kind);
  assert.throws(() => new AcpProvider({ command: FAKE, workDir: dir, permission: 'allow' }), { code: 'config' }, 'there is no "allow everything" policy');
});

test('cancel and an abort signal both stop a run; a pending permission question is answered "cancelled"', async t => {
  const { provider, received, answers } = await setup(t, { onPermission: (request, { signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve('allow_once'))) });
  const first = provider.run({ key: 'a', input: 'hang' });
  await until(async () => (await received('session/prompt')).length === 1);
  assert.equal(provider.cancel('a'), true);
  await assert.rejects(first, error => error instanceof ProviderError && error.code === 'stopped');
  const controller = new AbortController();
  const second = provider.run({ key: 'b', input: 'hang', signal: controller.signal });
  await until(async () => (await received('session/prompt')).length === 2);
  controller.abort();
  await assert.rejects(second, { code: 'stopped' });
  assert.equal((await received('session/cancel')).length, 2, 'one session/cancel per stopped run');
  assert.equal(provider.cancel('nobody'), false);
  await assert.rejects(provider.run({ key: 'c', input: 'x', signal: AbortSignal.abort() }), { code: 'stopped' });
  assert.equal((await provider.run({ key: 'a', input: 'again' })).message, 'turn 1: again', 'the session survives a stop');
  assert.equal((await received('session/new')).length, 2);

  const asking = provider.run({ key: 'a', input: 'permission edit /work/a.md' });
  await until(async () => (await received('session/prompt')).length === 4);
  await new Promise(r => setTimeout(r, 50));
  provider.cancel('a');
  await assert.rejects(asking, { code: 'stopped' });
  assert.deepEqual((await answers()).at(-1).result, { outcome: { outcome: 'cancelled' } }, 'whatever the hook says afterwards');
});

test('a second run on a busy key is refused; an agent that ignores a stop loses its session after the grace', async t => {
  const { provider, received } = await setup(t);
  const first = provider.run({ key: 'a', input: 'deaf' });
  await until(async () => (await received('session/prompt')).length === 1);
  await assert.rejects(provider.run({ key: 'a', input: 'more' }), { code: 'busy' });
  provider.cancel('a');
  await assert.rejects(first, { code: 'stopped' });
  assert.equal((await provider.run({ key: 'a', input: 'next' })).provenance.session, 'new');
});

test('a run past its overall or idle timeout is stopped and its session dropped', async t => {
  const { provider, received } = await setup(t);
  // The session exists before the clock starts: a run that times out while its agent is still starting has no turn to cancel.
  await provider.run({ key: 'a', input: 'first' });
  await assert.rejects(provider.run({ key: 'a', input: 'hang', timeout: 150 }), { code: 'timeout', message: 'The request ran out of time and was stopped.' });
  assert.equal((await provider.run({ key: 'a', input: 'next' })).message, 'turn 1: next', 'a fresh session after a timeout');
  const started = Date.now();
  await assert.rejects(provider.run({ key: 'b', input: 'hang', idleTimeout: 120 }), { code: 'timeout', message: 'The agent sent nothing for 0.1 seconds and was stopped.' });
  assert.ok(Date.now() - started < 2000);
  await until(async () => (await received('session/cancel')).length === 2);   // the agent is told to stop (its log is written a moment after the run rejects)
  assert.equal((await provider.run({ key: 'b', input: 'slow', idleTimeout: 200 })).message, '0 1 2 3 4 5 ', 'an agent that keeps talking is not idle, however long the turn');
  const quick = await setup(t, { idleTimeout: 120 });
  await assert.rejects(quick.provider.run({ key: 'a', input: 'hang' }), { code: 'timeout' }, 'the provider can set the idle limit for every run');
});

test('an agent error fails the run; a dead child fails it, and the next run starts a new child and loads the session', async t => {
  const { provider, received } = await setup(t, {}, { agent: { load: true } });
  await assert.rejects(provider.run({ key: 'a', input: 'fail' }), { code: 'failed', message: 'Internal error: The model is unavailable.' });
  await assert.rejects(provider.run({ key: 'a', input: 'refuse' }), { code: 'failed', message: 'The agent declined the request.' });
  const before = await provider.run({ key: 'b', input: 'one' });
  await assert.rejects(provider.run({ key: 'b', input: 'die' }), { code: 'unavailable' });
  const after = await provider.run({ key: 'b', input: 'back' });
  assert.deepEqual([after.message, after.provenance.session, after.provenance.sessionId], ['turn 2: back', 'loaded', before.provenance.sessionId], 'the session the child held is loaded into the new one');
  assert.equal((await received('initialize')).length, 2);
});

test('lines that are not protocol messages are skipped and reported, not fatal', async t => {
  const noise = [];
  const { provider } = await setup(t, { onNoise: line => noise.push(line) });
  assert.equal((await provider.run({ key: 'a', input: 'garbage' })).message, 'still here');
  assert.deepEqual(noise, ['Loaded cached credentials.', '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId"', '[1,2,3]', '"just a string"', '{"neither":"a request nor a reply"}']);
  const quiet = await setup(t);
  assert.equal((await quiet.provider.run({ key: 'a', input: 'garbage' })).message, 'still here');
});

test('an agent that wants signing in gets an auth error naming its methods; nobody is signed in for them', async t => {
  const { provider, received } = await setup(t, {}, { agent: { auth: true } });
  const error = await provider.run({ key: 'a', input: 'hello' }).then(() => null, e => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.code, 'auth');
  assert.match(error.message, /needs signing in.*fake-login, fake-terminal \(terminal\)/);
  assert.deepEqual(error.authMethods, ['fake-login', 'fake-terminal (terminal)']);
  assert.equal((await received('authenticate')).length, 0, 'authenticate is never sent unasked');

  const named = await setup(t, { authMethodId: 'fake-login' }, { agent: { auth: true, authOk: true } });
  assert.equal((await named.provider.run({ key: 'a', input: 'hello' })).message, 'turn 1: hello', 'a method the host names is sent');
  assert.deepEqual((await named.received('authenticate'))[0].params, { methodId: 'fake-login' });
  const refused = await setup(t, { authMethodId: 'fake-login' }, { agent: { auth: true } });
  await assert.rejects(refused.provider.run({ key: 'a', input: 'hello' }), { code: 'auth', message: /did not accept.*A browser is needed/ });
  const terminal = await setup(t, { authMethodId: 'fake-terminal' }, { agent: { auth: true, authOk: true } });
  await assert.rejects(terminal.provider.run({ key: 'a', input: 'hello' }), { code: 'auth' }, 'a terminal method is never sent to authenticate');
  assert.equal((await terminal.received('authenticate')).length, 0);
});

test('instructions, MCP servers, the session folder and extra roots reach the agent where the protocol has a place', async t => {
  const dir = await tempDir(t), cwd = path.join(dir, 'project'), extra = path.join(dir, 'shared');
  const servers = [{ name: 'notes', command: '/usr/bin/notes-mcp' }];
  const plain = await setup(t, { mcpServers: servers }, { dir });
  await plain.provider.run({ key: 'a', instructions: 'Be brief.', input: 'one', cwd, additionalDirectories: [extra] });
  await plain.provider.run({ key: 'a', instructions: 'Be brief.', input: 'two' });
  assert.deepEqual((await plain.received('session/new'))[0].params, { cwd, mcpServers: [{ name: 'notes', command: '/usr/bin/notes-mcp', args: [], env: [] }] });
  assert.deepEqual((await plain.received('session/prompt')).map(m => m.params.prompt.map(part => part.text)), [['Be brief.', 'one'], ['two']],
    'with no systemPrompt capability the instructions head the first prompt of the session, once');

  const able = await setup(t, {}, { agent: { systemPrompt: true, additionalDirectories: true, mcpHttp: true }, dir });
  const http = { type: 'http', name: 'api', url: 'https://mcp.example.test/mcp' };
  await able.provider.run({ key: 'a', instructions: 'Be brief.', input: 'one', cwd, additionalDirectories: [extra], mcpServers: [http] });
  assert.deepEqual((await able.received('session/new'))[0].params, { cwd, mcpServers: [{ ...http, headers: [] }], additionalDirectories: [extra],
    systemPrompt: { mode: 'append', content: [{ type: 'text', text: 'Be brief.' }] } });
  assert.deepEqual((await able.received('session/prompt'))[0].params.prompt.map(part => part.text), ['one']);

  await assert.rejects(plain.provider.run({ key: 'b', input: 'x', mcpServers: [http] }), { code: 'config', message: /does not connect to MCP servers over http/ });
  await assert.rejects(plain.provider.run({ key: 'b', input: 'x', mcpServers: [{ name: 'rel', command: 'notes-mcp' }] }), { code: 'config' });
  await assert.rejects(plain.provider.run({ key: 'b', input: 'x', cwd: 'relative' }), { code: 'config' });
});

test('terminal methods are refused unless the host supplies all five hooks', async t => {
  const bare = await setup(t);
  assert.match((await bare.provider.run({ key: 'a', input: 'terminal' })).message, /^terminal refused -32601/);
  const calls = [];
  const hook = (name, result) => (params, context) => { calls.push([name, params.terminalId ?? params.command, context.key]); return result; };
  const { provider } = await setup(t, { terminal: { create: hook('create', { terminalId: 'term1' }), waitForExit: hook('waitForExit', { exitCode: 0, signal: null }),
    output: hook('output', { output: 'hi\n', truncated: false }), kill: hook('kill'), release: hook('release') } });
  assert.equal((await provider.run({ key: 'a', input: 'terminal' })).message, 'terminal: {"exitCode":0,"signal":null} {"output":"hi\\n","truncated":false}');
  assert.deepEqual(calls, [['create', 'echo', 'a'], ['waitForExit', 'term1', 'a'], ['output', 'term1', 'a'], ['kill', 'term1', 'a'], ['release', 'term1', 'a']]);
  assert.throws(() => new AcpProvider({ command: FAKE, workDir: '/tmp/x', terminal: { create() {} } }), { code: 'config' });
});

test('a command that cannot start is unavailable; close() rejects what is in flight; bad configuration is refused', async t => {
  const dir = await tempDir(t);
  const missing = new AcpProvider({ command: [path.join(dir, 'no-such-program')], workDir: dir });
  await assert.rejects(missing.run({ key: 'a', input: 'x' }), { code: 'unavailable' });
  const { provider, received } = await setup(t);
  const run = provider.run({ key: 'a', input: 'hang' });
  await until(async () => (await received('session/prompt')).length === 1);
  provider.close();
  await assert.rejects(run, { code: 'unavailable' });
  assert.throws(() => new AcpProvider({ command: [], workDir: dir }), { code: 'config' });
  assert.throws(() => new AcpProvider({ command: ['gemini', '--acp'], workDir: dir }), { code: 'config', message: /absolute path/ });
  assert.throws(() => new AcpProvider({ command: FAKE }), { code: 'config' });
  assert.throws(() => new AcpProvider({ command: FAKE, workDir: dir, roots: ['relative'] }), { code: 'config' });
  assert.throws(() => new AcpProvider({ command: FAKE, workDir: dir, writeFile: 'yes' }), { code: 'config' });
  await assert.rejects(provider.run({ input: 'x' }), { code: 'config' });
  await assert.rejects(provider.run({ key: 'a', input: '' }), { code: 'config' });
});

test('diffToEdit: the smallest whole-line edit that has one place to go, or why there is none', () => {
  const file = 'Title\n\nWe meet in March.\nBring notes.\n\nWe meet in March.\nThe end.\n';
  const edit = (oldText, newText, options) => diffToEdit({ path: '/p/a.md', oldText, newText }, options);
  assert.deepEqual(edit('We meet in March.\nBring notes.\n', 'We meet in April.\nBring notes.\n').edit, { file: '/p/a.md', find: 'We meet in March.', replace: 'We meet in April.' });
  // A whole-file diff whose changed line occurs twice: widened by a line each way until it is unique.
  assert.deepEqual(edit(file, file.replace('March.\nBring', 'April.\nBring'), { file: 'a.md' }).edit,
    { file: 'a.md', find: '\nWe meet in March.\nBring notes.', replace: '\nWe meet in April.\nBring notes.' });
  assert.deepEqual(edit(file, file.replace('March.\nThe', 'May.\nThe')).edit.find, '\nWe meet in March.\nThe end.');
  // An insertion and a deletion have no changed text of their own, so they take the lines beside them.
  assert.deepEqual(edit('a\nb\n', 'a\nnew\nb\n').edit, { file: '/p/a.md', find: 'b', replace: 'new\nb' });
  assert.deepEqual(edit('a\nb\nc\n', 'a\nc\n').edit, { file: '/p/a.md', find: 'b\nc', replace: 'c' });
  assert.deepEqual(edit('one line', 'one long line').edit, { file: '/p/a.md', find: 'one line', replace: 'one long line' });
  // Several changes in one diff become one edit that spans them.
  assert.deepEqual(edit('a\nb\nc\nd\n', 'A\nb\nc\nD\n').edit, { file: '/p/a.md', find: 'a\nb\nc\nd', replace: 'A\nb\nc\nD' });
  // Judged against the live draft when it is given.
  const draft = 'Intro.\nWe meet in March.\nMore.\nWe meet in March.\n';
  assert.equal(edit('We meet in March.\n', 'We meet in April.\n', { current: draft }).code, 'ambiguous');
  assert.equal(edit('We meet in June.\n', 'We meet in April.\n', { current: draft }).code, 'not-found');
  assert.deepEqual(edit('Intro.\nWe meet in March.\n', 'Intro.\nWe meet in April.\n', { current: draft }).edit.find, 'Intro.\nWe meet in March.\n');
  assert.equal(edit('x\nx\n', 'x\ny\n').edit.find, 'x\nx\n');
  assert.equal(edit('x\nx\nx\n', 'x\ny\nx\n').edit.find, 'x\nx\nx');
  assert.equal(edit(null, 'new').code, 'new-file');
  assert.equal(edit(undefined, 'new').code, 'new-file');
  assert.equal(edit('', 'new').code, 'empty-file');
  assert.equal(edit('same', 'same').code, 'no-change');
  assert.equal(diffToEdit({ path: '/p' }).code, 'invalid');
  assert.equal(diffToEdit(null).code, 'invalid');
  assert.equal(edit('a'.repeat(100001), 'b').code, 'too-large');
  for (const result of [edit(null, 'x'), edit('a', 'a')]) assert.equal(typeof result.problem, 'string');
  // Every edit it returns is one the proposals ledger accepts and applies to the same result.
  const proposals = createProposals();
  for (const [before, after] of [[file, file.replace('Bring notes.', 'Bring two notes.')], ['a\nb\n', 'a\nnew\nb\n'], ['a\nb\nc\n', 'a\nc\n'], ['a\nb\nc\nd\n', 'A\nb\nc\nD\n'], ['x\nx\nx\n', 'x\ny\nx\n'], ['tail', 'tail\nmore\n'], ['a\n\n\nb', 'a\n\nb']]) {
    const made = proposals.make({ id: 't' }, edit(before, after, { file: 'f' }).edit, { f: before });
    assert.equal(made.ok && made.doc.f, after, JSON.stringify([before, after]));
  }
});
