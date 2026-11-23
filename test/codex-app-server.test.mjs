import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CodexAppServerProvider, commandLine } from '@lyra-forge/agent-chat/server/providers/codex-app-server';
import { ProviderError, foldActivity } from '@lyra-forge/agent-chat/server/providers';
import { fixture, tempDir, readLines, until } from './helpers.mjs';

async function setup(t, options = {}) {
  const dir = await tempDir(t), log = path.join(dir, 'log.jsonl');
  const provider = new CodexAppServerProvider({ command: [process.execPath, fixture('fake-app-server.mjs')], workDir: path.join(dir, 'work'),
    clientInfo: { name: 'testhost', title: 'Test Host', version: '1.2.3' }, env: { ...process.env, FAKE_LOG: log, OPENAI_API_KEY: 'sk-should-not-pass' }, ...options });
  t.after(() => provider.close());
  return { provider, dir, log, received: async method => (await readLines(log)).filter(m => m.method === method) };
}

test('a run streams normalised activity and resolves with the last message', async t => {
  const { provider, log, received } = await setup(t);
  const events = [], items = [];
  const result = await provider.run({ key: 'doc:main', instructions: 'Be brief.', input: ['<draft>hello</draft>', 'tidy it'],
    onEvent: event => { events.push(event); foldActivity(items, event); } });
  assert.equal(result.message, 'turn 1: <draft>hello</draft> | tidy it');
  assert.deepEqual(result.provenance, { provider: 'codex-app-server', model: 'fake-model', threadId: 't1' });
  assert.deepEqual(result.usage, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10, totalTokens: 150 });

  for (const event of events) {
    assert.ok(['reasoning', 'activity'].includes(event.kind), 'kind is normalised');
    assert.ok(['running', 'done', 'failed'].includes(event.status), 'status is normalised');
    assert.ok(Object.keys(event).every(k => ['id', 'kind', 'title', 'text', 'append', 'command', 'output', 'paths', 'status'].includes(k)), `no stray fields: ${Object.keys(event)}`);
  }
  assert.ok(!JSON.stringify(events).includes('RAW REASONING'), 'raw reasoning is never passed on');
  const by = id => items.find(a => a.id === id);
  assert.equal(by('r1').text, 'Reading the text.\nDeciding.');
  assert.equal(by('r1').status, 'done');
  assert.equal(by('c1').command, 'ls notes', 'the shell wrapper is removed');
  assert.match(by('c1').text, /a\.md\nb\.md/);
  assert.equal(by('c2').status, 'failed', 'a non-zero exit is a failed step');
  assert.deepEqual(by('f1').paths, ['/work/notes/a.md']);
  assert.equal(by('w1').title, 'Searching the web');
  assert.equal(by('m0').text, 'Looking around first.', 'commentary is a note');
  assert.equal(by('m2-note').text, 'Halfway there.', 'an earlier message is a note, the last is the reply');

  const [start] = await received('thread/start');
  assert.equal(start.params.approvalPolicy, 'never');
  assert.equal(start.params.sandbox, 'read-only', 'read-only unless the host says otherwise');
  assert.equal(start.params.developerInstructions, 'Be brief.');
  assert.equal(start.params.serviceName, 'testhost');
  assert.equal(start.params.model, 'fake-model');
  assert.deepEqual(start.params.config.mcp_servers, { notes: { enabled: false }, mail: { enabled: false } });
  assert.deepEqual(start.params.config.plugins, { helper: { enabled: false } });
  assert.deepEqual(start.params.config.apps, { _default: { enabled: false } });
  const [turn] = await received('turn/start');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly' });
  assert.equal(turn.params.effort, 'low');
  assert.equal(turn.params.input.length, 2);
  const lines = await readLines(log);
  assert.deepEqual(lines[0], { env: { hasOpenAiKey: false } }, 'the API key variable is not handed to the child');
  assert.deepEqual(lines.find(m => m.method === 'initialize').params.clientInfo, { name: 'testhost', title: 'Test Host', version: '1.2.3' });
});

test('a key keeps its thread; a new key or a reset gets a fresh one', async t => {
  const { provider, received } = await setup(t);
  assert.equal((await provider.run({ key: 'a', input: 'one' })).message, 'turn 1: one');
  const second = await provider.run({ key: 'a', input: 'two' });
  assert.equal(second.message, 'turn 2: two', 'the thread remembers');
  assert.equal(second.usage.inputTokens, 100, 'usage is for this run, not the whole thread');
  assert.equal((await provider.run({ key: 'b', input: 'three' })).message, 'turn 1: three');
  provider.reset('a');
  assert.equal((await provider.run({ key: 'a', input: 'four' })).message, 'turn 1: four');
  assert.equal((await received('thread/start')).length, 3);
  assert.equal((await received('initialize')).length, 1, 'one child serves every thread');
});

test('the host sets the sandbox roots, effort, schema and extra thread config', async t => {
  const { provider, received } = await setup(t, { disableUserExtensions: false, threadConfig: { 'features.multi_agent': false }, model: 'pinned', dropEnv: [] });
  const schema = { type: 'object', properties: { message: { type: 'string' } } };
  await provider.run({ key: 'k', input: 'go', effort: 'medium', outputSchema: schema, threadConfig: { web_search: 'disabled' },
    sandbox: { mode: 'workspace-write', cwd: '/srv/project', writableRoots: ['/srv/project/work'], network: true } });
  const [start] = await received('thread/start'), [turn] = await received('turn/start');
  assert.equal(start.params.sandbox, 'workspace-write');
  assert.equal(start.params.cwd, '/srv/project');
  assert.equal(start.params.model, 'pinned');
  assert.deepEqual(start.params.config, { 'features.multi_agent': false, web_search: 'disabled' }, 'user extensions are left alone when asked');
  assert.deepEqual(turn.params.sandboxPolicy, { type: 'workspaceWrite', writableRoots: ['/srv/project/work'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.equal(turn.params.effort, 'medium');
  assert.deepEqual(turn.params.outputSchema, schema);
  assert.equal((await received('config/read')).length, 0);
  assert.equal((await received('model/list')).length, 0);
});

test('cancel and an abort signal both stop a run', async t => {
  const { provider, received } = await setup(t);
  const first = provider.run({ key: 'a', input: 'hang' });
  await until(async () => (await received('turn/start')).length === 1);
  assert.equal(provider.cancel('a'), true);
  await assert.rejects(first, error => error instanceof ProviderError && error.code === 'stopped');
  const controller = new AbortController();
  const second = provider.run({ key: 'b', input: 'hang', signal: controller.signal });
  await until(async () => (await received('turn/start')).length === 2);
  controller.abort();
  await assert.rejects(second, { code: 'stopped' });
  assert.equal((await received('turn/interrupt')).length, 2);
  assert.equal(provider.cancel('nobody'), false);
  await assert.rejects(provider.run({ key: 'c', input: 'x', signal: AbortSignal.abort() }), { code: 'stopped' });
  assert.equal((await provider.run({ key: 'a', input: 'again' })).message, 'turn 2: again', 'the thread survives a stop');
});

test('a run past its timeout is interrupted and its thread dropped', async t => {
  const { provider, received } = await setup(t);
  await assert.rejects(provider.run({ key: 'a', input: 'hang', timeout: 150 }), { code: 'timeout' });
  assert.equal((await provider.run({ key: 'a', input: 'next' })).message, 'turn 1: next', 'a fresh thread after a timeout');
  assert.ok((await received('turn/interrupt')).length >= 1);
});

test('a second run on a busy key is refused', async t => {
  const { provider, received } = await setup(t);
  const first = provider.run({ key: 'a', input: 'hang' });
  await until(async () => (await received('turn/start')).length === 1);
  await assert.rejects(provider.run({ key: 'a', input: 'more' }), { code: 'busy' });
  provider.cancel('a');
  await assert.rejects(first, { code: 'stopped' });
});

test('approval requests are declined unless the host answers them', async t => {
  const { provider, log } = await setup(t);
  await provider.run({ key: 'a', input: 'approve this' });
  assert.deepEqual((await readLines(log)).find(m => m.id >= 9000 && m.result).result, { decision: 'decline' });
  const asked = [];
  const other = await setup(t, { onApproval: request => { asked.push(request.method); return { decision: 'accept' }; } });
  await other.provider.run({ key: 'a', input: 'approve this' });
  assert.deepEqual(asked, ['item/commandExecution/requestApproval']);
  assert.deepEqual((await readLines(other.log)).find(m => m.id >= 9000 && m.result).result, { decision: 'accept' });
});

test('an agent error fails the run; a dead child fails it and the next run starts a new child', async t => {
  const { provider, received } = await setup(t);
  await assert.rejects(provider.run({ key: 'a', input: 'fail' }), { code: 'failed', message: 'The model is unavailable.' });
  await assert.rejects(provider.run({ key: 'b', input: 'die' }), { code: 'unavailable' });
  assert.equal((await provider.run({ key: 'b', input: 'back' })).message, 'turn 1: back');
  assert.equal((await received('initialize')).length, 2);
});

test('a command that cannot start is reported as unavailable, and close() rejects what is in flight', async t => {
  const dir = await tempDir(t);
  const missing = new CodexAppServerProvider({ command: [path.join(dir, 'no-such-program')], workDir: dir });
  await assert.rejects(missing.run({ key: 'a', input: 'x' }), { code: 'unavailable' });
  const { provider, received } = await setup(t);
  const run = provider.run({ key: 'a', input: 'hang' });
  await until(async () => (await received('turn/start')).length === 1);
  provider.close();
  await assert.rejects(run, { code: 'unavailable' });
  assert.throws(() => new CodexAppServerProvider({ command: [], workDir: dir }), { code: 'config' });
  assert.throws(() => new CodexAppServerProvider({}), { code: 'config' });
});

test('commandLine strips the shell wrapper', () => {
  assert.equal(commandLine(['/bin/bash', '-lc', 'ls -la']), 'ls -la');
  assert.equal(commandLine("/usr/bin/zsh -c 'echo hi'"), 'echo hi');
  assert.equal(commandLine('git status'), 'git status');
  assert.equal(commandLine(undefined), '');
});
