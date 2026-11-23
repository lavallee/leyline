// The two server modules that came with 0.2.3. Their behaviour must not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CodexRpc } from '@lyra-forge/agent-chat/server/rpc';
import { createRoutineBank } from '@lyra-forge/agent-chat/server/routines';
import { routineSlug, routineMatches } from '@lyra-forge/agent-chat/routines';
import { fixture, tempDir } from './helpers.mjs';

test('CodexRpc: calls resolve, notifications and requests are emitted, a dead child rejects', async t => {
  const dir = await tempDir(t);
  const rpc = new CodexRpc({ command: [process.execPath, fixture('fake-app-server.mjs')], cwd: dir, env: process.env });
  t.after(() => rpc.close());
  await assert.rejects(rpc.call('initialize', {}), /not running/);
  assert.equal(rpc.start(), rpc.start(), 'start is idempotent');
  const notes = [], requests = [];
  rpc.on('notification', m => notes.push(m.method)); rpc.on('request', m => { requests.push(m.method); rpc.reply(m.id, { decision: 'decline' }); });
  assert.deepEqual(await rpc.call('initialize', {}), {});
  const { thread } = await rpc.call('thread/start', {});
  const done = new Promise(resolve => rpc.on('notification', m => m.method === 'turn/completed' && resolve()));
  await rpc.call('turn/start', { threadId: thread.id, input: [{ text: 'approve' }] });
  await done;
  assert.ok(notes.includes('turn/started') && notes.includes('item/completed'));
  assert.deepEqual(requests, ['item/commandExecution/requestApproval']);
  const dying = rpc.call('turn/start', { threadId: thread.id, input: [{ text: 'hang' }] }).then(() => rpc.call('never/answered', {}, 60000));
  rpc.close();
  await assert.rejects(dying, /stopped/);
  const quick = new CodexRpc({ command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], cwd: dir }); t.after(() => quick.close());
  quick.start();
  await assert.rejects(quick.call('anything', {}, 50), /timed out: anything/);
});

test('routine bank: banked routines override shipped ones and are stored privately', async t => {
  const dir = await tempDir(t), shipped = path.join(dir, 'shipped'), banked = path.join(dir, 'banked');
  const options = { extension: '.json', parse: (name, body) => ({ name, ...JSON.parse(body) }), compose: parts => JSON.stringify(parts) };
  createRoutineBank({ banked: shipped, ...options }).save('proofread', { title: 'Proofread', code: 'shipped version', engines: ['page'] });
  const bank = createRoutineBank({ shipped, banked, ...options });
  assert.deepEqual(bank.list().map(r => [r.name, r.source]), [['proofread', 'shipped']]);
  assert.equal(bank.save('proofread', { title: 'Proofread', code: 'my version', engines: ['page'] }).code, 'my version');
  bank.save('tighten', { title: 'A tighten', code: 'x', engines: ['page'] });
  assert.deepEqual(bank.list().map(r => [r.name, r.source, r.code]), [['tighten', 'banked', 'x'], ['proofread', 'banked', 'my version']]);
  assert.equal((await stat(path.join(banked, 'tighten.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(banked)).sort(), ['proofread.json', 'tighten.json']);
  assert.throws(() => bank.save('../escape', {}), /Invalid routine name/);
});

test('routine slugs and slash matching', () => {
  assert.equal(routineSlug('  Check the Figures! '), 'check-the-figures');
  const routines = [{ name: 'proofread', title: 'Proofread', engines: ['page'] }, { name: 'fit', title: 'Fit the limit', engines: ['thread'] }];
  assert.deepEqual(routineMatches(routines, '/pro', 'page').map(r => r.name), ['proofread']);
  assert.deepEqual(routineMatches(routines, '/', 'thread').map(r => r.name), ['fit']);
  assert.deepEqual(routineMatches(routines, 'no slash', 'page'), []);
});
