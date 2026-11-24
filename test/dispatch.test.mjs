import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDispatch, callRunner, DispatchError } from '../server/dispatch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STAND_IN = [process.execPath, path.join(here, 'fixtures/runner.mjs')];
const COMMAND = path.join(here, '../bin/runner-command.mjs');

async function setup(t, script, destinations = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dispatch-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.jsonl'), scriptFile = path.join(dir, 'script.json');
  await writeFile(scriptFile, JSON.stringify(script));
  const env = { ...process.env, RUNNER_LOG: log, RUNNER_SCRIPT: scriptFile };
  const work = createDispatch({ dir: path.join(dir, 'work'), destinations: {
    fix: { label: 'Fix it', runner: STAND_IN, where: { root: '/repo', paths: ['render.py'] }, approval: 'owner', env },
    now: { label: 'At once', runner: STAND_IN, approval: 'none', env },
    ...destinations } });
  const calls = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l)); } catch { return []; } };
  const rescript = value => writeFile(scriptFile, JSON.stringify(value));
  return { dir, work, calls, rescript, env };
}

test('an item waits for the owner, is sent with the contract’s fields, and its runner’s answers are kept', async t => {
  const { work, calls, rescript } = await setup(t, { submit: { id: 'job-1', status: 'queued', link: 'http://127.0.0.1:9/job-1' } });
  const item = await work.create('doc', { destination: 'fix', brief: 'The date in the header comes from created.\nUse updated.', from: { document: 'Overview', file: 'artifact.toml', quote: 'November 23', start: 4, end: 15, extra: 'dropped' } });
  assert.deepEqual([item.status, item.title, item.by], ['held', 'The date in the header comes from created.', 'person']);
  assert.deepEqual(item.from, { document: 'Overview', file: 'artifact.toml', quote: 'November 23', start: 4, end: 15 });
  assert.deepEqual(await calls(), [], 'nothing is sent before the owner sends it');
  const sent = await work.send('doc', item.id);
  assert.deepEqual([sent.status, sent.job, sent.link], ['queued', 'job-1', 'http://127.0.0.1:9/job-1']);
  const [call] = await calls();
  assert.equal(call.operation, 'submit');
  assert.deepEqual({ ...call.input, key: typeof call.input.key }, { v: 1, key: 'string', title: item.title, brief: item.brief, from: item.from, where: { root: '/repo', paths: ['render.py'] }, by: 'person' });
  await assert.rejects(work.send('doc', item.id), /Only an item that is waiting/);

  await rescript({ status: { id: 'job-1', status: 'done', summary: 'Renderer uses updated now.', result: { message: 'Changed render.py.', links: [{ label: 'Diff', url: 'http://127.0.0.1:9/d' }, { label: 'bad', url: 'javascript:alert(1)' }], files: [{ path: 'render.py', change: 'edited' }] }, extra: 1 } });
  const [after] = await work.refresh('doc');
  assert.deepEqual([after.status, after.summary, after.result], ['done', 'Renderer uses updated now.', { message: 'Changed render.py.', links: [{ label: 'Diff', url: 'http://127.0.0.1:9/d' }], files: [{ path: 'render.py', change: 'edited' }] }]);
  assert.deepEqual((await calls()).at(-1), { operation: 'status', input: { v: 1, id: 'job-1' } });
  await work.refresh('doc');
  assert.equal((await calls()).length, 2, 'a finished item is not asked about again');
  await assert.rejects(work.cancel('doc', item.id), /no longer open/);
});

test('a destination without approval sends at once; an agent’s item waits unless the destination says otherwise', async t => {
  const { work, calls } = await setup(t, { submit: { id: 'j', status: 'running' } }, {});
  assert.equal((await work.create('doc', { destination: 'now', brief: 'Go' })).status, 'running');
  assert.equal((await work.create('doc', { destination: 'now', brief: 'Go', by: 'agent' })).status, 'held', 'an agent’s item waits for the owner by default');
  assert.equal((await calls()).length, 1);
  assert.deepEqual(work.list('doc').map(i => i.status), ['held', 'running'], 'newest first');
  assert.deepEqual(work.choices(), [{ name: 'fix', label: 'Fix it', approval: 'owner' }, { name: 'now', label: 'At once', approval: 'none' }]);
  await assert.rejects(work.create('doc', { destination: 'elsewhere', brief: 'x' }), /not set up/);
  await assert.rejects(work.create('doc', { destination: 'fix', brief: '  ' }), /Say what should be done/);
});

test('a runner that fails or answers badly leaves the item waiting, with what it said', async t => {
  const { work, rescript } = await setup(t, { submit: 'fail:no repository at /repo' });
  const item = await work.create('doc', { destination: 'fix', brief: 'x' });
  await assert.rejects(work.send('doc', item.id), err => err instanceof DispatchError && /refused submit: no repository at \/repo/.test(err.message));
  assert.deepEqual(work.list('doc').map(i => [i.status, i.error]), [['held', 'The runner refused submit: no repository at /repo.']]);
  await rescript({ submit: 'garbage' });
  await assert.rejects(work.send('doc', item.id), /was not JSON/);
  await rescript({ submit: { id: 'j', status: 'thinking' } });
  await assert.rejects(work.send('doc', item.id), /status this does not know/);
  const now = await work.create('doc', { destination: 'now', brief: 'x' });
  assert.deepEqual([now.status, now.error], ['held', 'The runner answered with a status this does not know (thinking).'], 'sent at once and refused: it waits, with the reason');
  assert.equal((await work.cancel('doc', item.id)).status, 'cancelled', 'a waiting item is dropped without asking the runner');
});

test('a runner that does not answer in time is stopped and reported', async () => {
  await assert.rejects(callRunner([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], 'status', { id: 'x' }, { timeout: 0.3 }), /did not answer within 0.3 seconds/);
  await assert.rejects(callRunner([], 'status', {}), /no runner command/);
});

// The command runner, for real: a job runs a command in the background and is followed by status.
const runCommand = (operation, body, env) => new Promise((resolve, reject) => {
  const child = execFile(process.execPath, [COMMAND, operation], { env }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(JSON.parse(stdout)));
  child.stdin.end(JSON.stringify(body));
});
async function until(fn, what) {
  for (let i = 0; i < 400; i++) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 25)); }
  throw new Error(`timed out waiting for ${what}`);
}

test('the command runner runs a job in its folder, reports how it ended, keeps a key to one job and can cancel', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'runner-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const agent = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{require("fs").writeFileSync("seen.txt",s);console.log("working");console.log("");console.log(s.includes("> November 23")?"Changed the date.":"No quote.")})';
  const env = { ...process.env, DISPATCH_RUNNER_STATE: path.join(dir, 'state'), DISPATCH_RUNNER_COMMAND: JSON.stringify([process.execPath, '-e', agent]) };
  const job = { v: 1, key: 'doc-1', title: 'Fix the date', brief: 'Use the updated field.', from: { document: 'Overview', quote: 'November 23' }, where: { root: dir, paths: ['render.py'] }, by: 'person' };
  const first = await runCommand('submit', job, env);
  assert.match(first.id, /^[a-f0-9]{24}$/); assert.ok(['queued', 'running', 'done'].includes(first.status));
  assert.equal((await runCommand('submit', job, env)).id, first.id, 'the same key is the same job');
  const done = await until(async () => { const s = await runCommand('status', { v: 1, id: first.id }, env); return s.status === 'done' && s; }, 'the job to finish');
  assert.equal(done.result.message, 'Changed the date.');
  const seen = await readFile(path.join(dir, 'seen.txt'), 'utf8');
  assert.match(seen, /^# Fix the date\nUse the updated field\./); assert.match(seen, /Work only in: render\.py\./);

  const failing = { ...env, DISPATCH_RUNNER_COMMAND: JSON.stringify([process.execPath, '-e', 'console.log("oops"); process.exit(4)']) };
  const bad = await runCommand('submit', { ...job, key: 'doc-2' }, failing);
  const failed = await until(async () => { const s = await runCommand('status', { v: 1, id: bad.id }, failing); return s.status === 'failed' && s; }, 'the failing job');
  assert.equal(failed.summary, 'The command ended with exit 4.'); assert.match(failed.result.message, /oops/);

  const slow = { ...env, DISPATCH_RUNNER_COMMAND: JSON.stringify([process.execPath, '-e', 'setTimeout(() => {}, 20000)']) };
  const long = await runCommand('submit', { ...job, key: 'doc-3' }, slow);
  await until(async () => (await runCommand('status', { v: 1, id: long.id }, slow)).status === 'running', 'the slow job to start');
  assert.equal((await runCommand('cancel', { v: 1, id: long.id }, slow)).status, 'cancelled');

  await assert.rejects(runCommand('submit', { ...job, v: 2 }, env), err => /version 1/.test(err.stderr));
  await assert.rejects(runCommand('status', { v: 1, id: '../../etc' }, env), err => /no such job/.test(err.stderr));
  await assert.rejects(runCommand('submit', job, { ...env, DISPATCH_RUNNER_COMMAND: '' }), err => /DISPATCH_RUNNER_COMMAND/.test(err.stderr));
});
