import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, chmod, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CliOneshotProvider, runProcess, parseJsonAnswer, ENV_KEYS } from '../server/providers/cli-oneshot.mjs';
import { fixture, tempDir } from './helpers.mjs';
import { SHORT_NAME } from '../server/package-info.mjs';

const echo = [process.execPath, fixture('echo-agent.mjs')];

// A fake CLI: an executable script that records its arguments and stdin, then behaves as told.
async function fakeCli(t, body) {
  const dir = await tempDir(t), bin = path.join(dir, 'fake-cli'), record = path.join(dir, 'calls.jsonl');
  await writeFile(bin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, input, cwd: process.cwd(), env: Object.keys(process.env) }) + '\\n');
  ${body}
});
`);
  await chmod(bin, 0o755);
  const calls = async () => (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { bin, dir, calls };
}

test('command preset: prompt on stdin, answer on stdout, in the folder the host names', async t => {
  const dir = await tempDir(t);
  const provider = new CliOneshotProvider({ preset: 'command', command: echo });
  const result = await provider.run({ instructions: 'Answer in JSON.', input: ['context', 'the question'], cwd: dir, json: true });
  assert.equal(result.data.summary, `read ${'Answer in JSON.\n\ncontext\n\nthe question'.length} characters`);
  assert.equal(result.data.cwd, dir);
  assert.deepEqual(result.provenance, { provider: 'cli-oneshot', preset: 'command', model: 'provider default' });
  assert.ok(result.data.env.every(name => ENV_KEYS.includes(name)), `only allowlisted variables reach the child: ${result.data.env}`);
  assert.equal(typeof result.message, 'string');
});

test('the child does not inherit secrets from the host environment', async t => {
  process.env.AGENT_CHAT_TEST_SECRET = 'do-not-pass'; t.after(() => { delete process.env.AGENT_CHAT_TEST_SECRET; });
  const provider = new CliOneshotProvider({ preset: 'command', command: echo });
  const { data } = await provider.run({ input: 'x', json: true });
  assert.ok(!data.env.includes('AGENT_CHAT_TEST_SECRET'));
  const wider = new CliOneshotProvider({ preset: 'command', command: echo, envKeys: [...ENV_KEYS, 'AGENT_CHAT_TEST_SECRET'] });
  assert.ok((await wider.run({ input: 'x', json: true })).data.env.includes('AGENT_CHAT_TEST_SECRET'), 'unless the host allows a name');
});

test('a fenced or wrapped JSON answer is still read; text answers pass through', async () => {
  const provider = new CliOneshotProvider({ preset: 'command', command: echo });
  assert.match((await provider.run({ input: 'fenced please', json: true })).data.summary, /^read /);
  assert.deepEqual(parseJsonAnswer('noise {"a": 1} trailing'), { a: 1 });
  assert.equal(parseJsonAnswer('no json here'), null);
  assert.equal(parseJsonAnswer(42), null);
  const plain = new CliOneshotProvider({ preset: 'command', command: [process.execPath, '-e', 'process.stdout.write("just words")'] });
  assert.equal((await plain.run({ input: 'x' })).message, 'just words');
  await assert.rejects(plain.run({ input: 'x', json: true }), { code: 'failed' });
});

test('failure, timeout, abort and cancel each have their own code', async () => {
  const provider = new CliOneshotProvider({ preset: 'command', command: echo });
  await assert.rejects(provider.run({ input: 'exit now' }), error => error.code === 'failed' && /could not do it/.test(error.message));
  await assert.rejects(provider.run({ input: 'sleep', timeout: 100 }), { code: 'timeout', status: 504 });
  const controller = new AbortController();
  const aborted = provider.run({ input: 'sleep', signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(aborted, { code: 'stopped', status: 499 });
  await assert.rejects(provider.run({ input: 'x', signal: AbortSignal.abort() }), { code: 'stopped' });
  const keyed = provider.run({ key: 'k', input: 'sleep' });
  await assert.rejects(provider.run({ key: 'k', input: 'x' }), { code: 'busy' });
  assert.equal(provider.cancel('k'), true);
  await assert.rejects(keyed, { code: 'stopped' });
  assert.equal(provider.cancel('k'), false);
  await assert.rejects(new CliOneshotProvider({ preset: 'command', command: ['/no/such/program'] }).run({ input: 'x' }), { code: 'unavailable', status: 503 });
  await assert.rejects(new CliOneshotProvider({ preset: 'command' }).run({ input: 'x' }), { code: 'unavailable' });
  await assert.rejects(provider.run({ input: '' }), { code: 'config' });
  assert.throws(() => new CliOneshotProvider({ preset: 'nope' }), { code: 'config' });
});

test('codex preset: checks the login, then runs read-only with tools and user config off', async t => {
  const { bin, calls } = await fakeCli(t, `
  if (args[0] === 'login') process.exit(0);
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ summary: 'from codex' }));`);
  const schema = { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } };
  const before = (await readdir(os.tmpdir())).filter(name => name.startsWith(`${SHORT_NAME}-`));
  const result = await new CliOneshotProvider({ preset: 'codex', bin, model: 'some-model' }).run({ input: 'the prompt', outputSchema: schema, json: true, cwd: '/' });
  assert.deepEqual(result.data, { summary: 'from codex' });
  const [login, exec] = await calls();
  assert.deepEqual(login.args, ['login', 'status']);
  assert.equal(exec.input, 'the prompt');
  assert.deepEqual(exec.args.slice(0, 3), ['-a', 'never', 'exec']);
  for (const flag of ['--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules']) assert.ok(exec.args.includes(flag), flag);
  assert.equal(exec.args[exec.args.indexOf('--sandbox') + 1], 'read-only');
  const disabled = exec.args.flatMap((arg, i) => arg === '--disable' ? [exec.args[i + 1]] : []);
  assert.deepEqual(disabled, ['shell_tool', 'computer_use', 'hooks', 'plugins', 'apps', 'multi_agent', 'multi_agent_v2']);
  assert.equal(exec.args[exec.args.indexOf('-c') + 1], 'web_search="disabled"');
  assert.equal(exec.args[exec.args.indexOf('-m') + 1], 'some-model');
  assert.ok(exec.args.includes('--output-schema'));
  assert.equal(exec.args.at(-1), '-', 'the prompt is read from stdin');
  assert.notEqual(exec.cwd, '/', 'codex runs in an empty temporary folder, not where the host points');
  const after = (await readdir(os.tmpdir())).filter(name => name.startsWith(`${SHORT_NAME}-`));
  assert.deepEqual(after, before, 'the temporary folder is removed');
});

test('codex preset: needs an absolute executable, a login, and reports sign-in trouble', async t => {
  await assert.rejects(new CliOneshotProvider({ preset: 'codex', bin: 'codex' }).run({ input: 'x' }), { code: 'unavailable' });
  const out = await fakeCli(t, `process.exit(1);`);
  await assert.rejects(new CliOneshotProvider({ preset: 'codex', bin: out.bin }).run({ input: 'x' }), { code: 'auth', message: /not signed in/ });
  const expired = await fakeCli(t, `if (args[0] === 'login') process.exit(0); process.stderr.write('401 Unauthorized'); process.exit(1);`);
  await assert.rejects(new CliOneshotProvider({ preset: 'codex', bin: expired.bin }).run({ input: 'x' }), { code: 'auth', message: /could not authenticate/ });
  const broken = await fakeCli(t, `if (args[0] === 'login') process.exit(0); process.stderr.write('boom'); process.exit(2);`);
  await assert.rejects(new CliOneshotProvider({ preset: 'codex', bin: broken.bin }).run({ input: 'x' }), { code: 'failed', message: /boom/ });
  const noSchema = await fakeCli(t, `if (args[0] === 'login') process.exit(0); fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'plain');`);
  assert.equal((await new CliOneshotProvider({ preset: 'codex', bin: noSchema.bin }).run({ input: 'x' })).message, 'plain');
  assert.ok(!(await noSchema.calls())[1].args.includes('--output-schema'));
});

test('claude preset: print mode with read-only tools and no user settings', async t => {
  const { bin, calls, dir } = await fakeCli(t, `process.stdout.write(JSON.stringify({ type: 'result', result: 'from claude' }));`);
  const result = await new CliOneshotProvider({ preset: 'claude', bin, model: 'a-model' }).run({ input: 'the prompt', cwd: dir });
  assert.equal(result.message, 'from claude');
  const [call] = await calls();
  assert.equal(call.cwd, dir);
  assert.equal(call.input, 'the prompt');
  assert.deepEqual(call.args, ['-p', '--output-format', 'json', '--tools', 'Read,Grep,Glob', '--no-session-persistence',
    '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', '--model', 'a-model']);
  const bad = await fakeCli(t, `process.stdout.write('not json'); `);
  await assert.rejects(new CliOneshotProvider({ preset: 'claude', bin: bad.bin }).run({ input: 'x' }), { code: 'failed' });
});

test('runProcess caps runaway output', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => process.stdout.write("x".repeat(65536)), 1)'], { maxOutput: 200000, timeout: 10000 });
  assert.ok(result.stdout.length < 2_000_000);
  assert.notEqual(result.code, 0);
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (check, ms = 20000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('Timed out waiting for a condition.'); await new Promise(r => setTimeout(r, 10)); } };

test('a multi-byte character split between two writes is read whole', async () => {
  const code = `const b = Buffer.from('日本語 naïve 🙂'); let i = 0; (function next() { if (i >= b.length) return; process.stdout.write(b.subarray(i, i + 1), () => setTimeout(next, 1)); process.stderr.write(b.subarray(i, i + 1)); i++; })();`;
  const result = await runProcess(process.execPath, ['-e', code]);
  assert.equal(result.stdout, '日本語 naïve 🙂');
  assert.equal(result.stderr, '日本語 naïve 🙂');
});

test('a child that ignores SIGTERM is killed after a timeout or a stop, not left running', async t => {
  const dir = await tempDir(t), pidFile = path.join(dir, 'pid');
  const stubborn = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const pid = async () => { let text = ''; await waitFor(() => { try { text = require_(pidFile); return !!text; } catch { return false; } }); return Number(text); };
  const { readFileSync, rmSync } = await import('node:fs');
  const require_ = file => readFileSync(file, 'utf8');
  for (const how of ['timeout', 'stopped']) {
    rmSync(pidFile, { force: true });
    const controller = new AbortController();
    // The timeout is long enough for the child to have started and said so, even on a loaded machine.
    const run = runProcess(process.execPath, ['-e', stubborn], { timeout: how === 'timeout' ? 4000 : 60000, signal: controller.signal, killGrace: 100 });
    run.catch(() => {});
    const child = await pid();
    t.after(() => { try { process.kill(child, 'SIGKILL'); } catch { /* gone, as it should be */ } });
    if (how === 'stopped') controller.abort();
    await assert.rejects(run, { code: how });
    await waitFor(() => !alive(child));
  }
});

test('output past the cap: nothing more is kept and the child is ended, even one that ignores SIGTERM', async () => {
  const flood = `process.on('SIGTERM', () => {}); const chunk = 'x'.repeat(65536); (function next() { process.stdout.write(chunk, next); })();`;
  const began = Date.now();
  const result = await runProcess(process.execPath, ['-e', flood], { maxOutput: 200000, killGrace: 100, timeout: 120000 });
  assert.equal(result.truncated, true);
  assert.notEqual(result.code, 0);
  assert.ok(result.stdout.length <= 200000 + 65536 * 2, `kept ${result.stdout.length} characters`);
  assert.ok(Date.now() - began < 30000, `took ${Date.now() - began} ms`);
});

test('a command that cannot be started at all is unavailable, with a ProviderError', async () => {
  await assert.rejects(runProcess('bad\0name', []), error => error.name === 'ProviderError' && error.code === 'unavailable');
  await assert.rejects(runProcess(process.execPath, ['-e', '1'], { cwd: '/no/such/folder/anywhere' }), error => error.name === 'ProviderError' && error.code === 'unavailable');
});

test('codex preset: a stop during the login check is honoured at once', async t => {
  const { bin } = await fakeCli(t, `if (args[0] === 'login') return setTimeout(() => process.exit(0), 120000); process.exit(0);`);
  const provider = new CliOneshotProvider({ preset: 'codex', bin });
  const controller = new AbortController(), began = Date.now();
  const run = provider.run({ key: 'k', input: 'x', signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(run, { code: 'stopped' });
  assert.ok(Date.now() - began < 30000, `took ${Date.now() - began} ms`);
});

test('processGroup: stopping a run also ends what the child started', async t => {
  const dir = await tempDir(t), file = path.join(dir, 'pids');
  const controller = new AbortController();
  const run = runProcess(process.execPath, [fixture('scripted-child.mjs'), 'family', file], { signal: controller.signal, processGroup: true, killGrace: 200 });
  run.catch(() => {});
  const { existsSync, readFileSync } = await import('node:fs');
  await waitFor(() => existsSync(file) && readFileSync(file, 'utf8').endsWith('}'));
  const pids = JSON.parse(readFileSync(file, 'utf8'));
  t.after(() => { for (const pid of Object.values(pids)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } });
  controller.abort();
  await assert.rejects(run, { code: 'stopped' });
  await waitFor(() => !alive(pids.child) && !alive(pids.grandchild));
});

test('validate: a host checks a structured answer before it is returned', async () => {
  const provider = new CliOneshotProvider({ preset: 'command', command: echo });
  const ok = await provider.run({ input: 'x', json: true, validate: data => typeof data.summary === 'string' });
  assert.match(ok.data.summary, /^read /);
  const repaired = await provider.run({ input: 'x', json: true, validate: data => ({ summary: data.summary.toUpperCase() }) });
  assert.match(repaired.data.summary, /^READ /);
  await assert.rejects(provider.run({ input: 'x', json: true, validate: () => false }), { code: 'failed', message: /did not pass/ });
  await assert.rejects(provider.run({ input: 'x', json: true, validate: () => 'summary must be short' }), { code: 'failed', message: /summary must be short/ });
  await assert.rejects(provider.run({ input: 'x', json: true, validate: () => { throw new Error('schema says no'); } }), { code: 'failed', message: /schema says no/ });
});
