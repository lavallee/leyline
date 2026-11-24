import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as rpcModule from '../server/codex-rpc.mjs';
import { fixture, tempDir, until } from './helpers.mjs';

const { CodexRpc } = rpcModule;
const child = (...args) => [process.execPath, fixture('scripted-child.mjs'), ...args];
// A small seeded generator, so a failing run can be repeated.
const random = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function replay(t, text, sizes, options = {}) {
  const dir = await tempDir(t), file = path.join(dir, 'stream');
  await writeFile(file, text); await writeFile(`${file}.chunks`, JSON.stringify(sizes));
  const rpc = new CodexRpc({ command: child('replay', file), ...options });
  t.after(() => rpc.close());
  const seen = { notification: [], request: [], oversize: [] };
  for (const name of Object.keys(seen)) rpc.on(name, value => seen[name].push(value));
  rpc.start();
  return { rpc, seen };
}

test('lines that are JSON but not messages are ignored, and what follows still arrives', async t => {
  const lines = ['null', '42', '"text"', '[1,2]', 'true', '{ not json', '', '{"method":"after","params":{"n":1}}', '{"id":7,"method":"ask","params":{}}'];
  const { seen } = await replay(t, lines.join('\n') + '\n', [4096]);
  await until(() => seen.request.length === 1);
  assert.deepEqual(seen.notification, [{ method: 'after', params: { n: 1 } }]);
  assert.deepEqual(seen.request, [{ id: 7, method: 'ask', params: {} }]);
});

test('framing holds however the bytes are split: random chunks, CRLF, blank lines, multi-byte text', async t => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const next = random(seed), messages = [];
    let text = '';
    for (let i = 0; i < 400; i++) {
      const message = { method: 'note', params: { n: i, text: ['plain', 'naïve café', '日本語のテキスト', '🙂🙃 emoji', 'x'.repeat(Math.floor(next() * 3000)), 'line\\nbreak "quoted"'][Math.floor(next() * 6)] } };
      messages.push(message);
      text += JSON.stringify(message) + (next() < 0.3 ? '\r\n' : '\n') + (next() < 0.1 ? '\n' : '');
    }
    const sizes = Array.from({ length: 97 }, () => 1 + Math.floor(next() ** 3 * 5000));
    const { rpc, seen } = await replay(t, text, sizes);
    await until(() => seen.notification.length >= messages.length, 10000);
    assert.deepEqual(seen.notification, messages, `seed ${seed}`);
    rpc.close();
  }
});

test('a line longer than the cap is dropped and reported, and the lines after it still arrive', async t => {
  const big = JSON.stringify({ method: 'huge', params: { text: 'x'.repeat(300000) } });
  const text = ['{"method":"before","params":{}}', big, '{"method":"after","params":{}}', ''].join('\n');
  const { seen } = await replay(t, text, [1000, 7, 4096], { maxLine: 100000 });
  await until(() => seen.notification.some(m => m.method === 'after'));
  assert.deepEqual(seen.notification.map(m => m.method), ['before', 'after']);
  assert.equal(seen.oversize.length, 1);
});

test('a child that writes a great deal to stderr is not left blocked on it', async t => {
  const rpc = new CodexRpc({ command: child('stderr-flood') });
  t.after(() => rpc.close());
  let bytes = 0;
  rpc.start();
  rpc.on('stderr', chunk => { bytes += chunk.length; });
  assert.deepEqual(await rpc.call('ping', { n: 1 }, 5000), { n: 1 });
  assert.ok(bytes > 0, 'stderr is offered to listeners');
});

test('close() ends a child that ignores SIGTERM', async t => {
  const rpc = new CodexRpc({ command: child('stubborn'), killGrace: 100 });
  const proc = rpc.start();
  await once(rpc, 'notification');
  const exited = once(proc, 'exit');
  rpc.close();
  const [, signal] = await Promise.race([exited, new Promise((_, reject) => setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('the child outlived close()')); }, 3000))]);
  assert.equal(signal, 'SIGKILL');
});

test('calls carry stable codes: closed, timeout, rpc, invalid; and none is settled twice or left waiting', async t => {
  const rpc = new CodexRpc({ command: child('echo') });
  await assert.rejects(rpc.call('early'), { code: 'closed' });
  rpc.start();
  assert.deepEqual(await rpc.call('ping', { a: 1 }), { a: 1 });
  const circular = {}; circular.self = circular;
  await assert.rejects(rpc.call('bad', circular), { code: 'invalid' });
  assert.equal(rpc.calls.size, 0, 'a call that was never sent leaves nothing behind');
  // A reply that never comes: the fake only answers requests it can parse, so ask on a dead id by pausing the child.
  rpc.proc.kill('SIGSTOP');
  await assert.rejects(rpc.call('slow', {}, 60), { code: 'timeout' });
  rpc.proc.kill('SIGCONT');
  const pending = rpc.call('never', {}, 5000);
  rpc.close();
  await assert.rejects(pending, { code: 'closed' });
  await assert.rejects(rpc.call('after'), { code: 'closed' });
  assert.equal(rpc.calls.size, 0);
  // The transport can be started again after a close, without waiting for the old child to go.
  rpc.start();
  assert.deepEqual(await rpc.call('ping', { again: true }), { again: true });
  rpc.close();
});

test('an error reply without a usable message is still an Error with a message and the code rpc', async t => {
  const { rpc } = await replay(t, '', [1]);
  const pending = rpc.call('x', {}, 2000);
  rpc.dispatch?.(JSON.stringify({ id: rpc.seq, error: { code: -32000 } })) ?? rpc.proc.stdout.emit('data', Buffer.from(JSON.stringify({ id: rpc.seq, error: { code: -32000 } }) + '\n'));
  await assert.rejects(pending, error => error.code === 'rpc' && typeof error.message === 'string' && error.message.length > 0 && error.message !== 'undefined');
});

test('a listener that throws does not stop the reader or take the host down', async t => {
  const { rpc, seen } = await replay(t, '{"method":"one","params":{}}\n{"method":"two","params":{}}\n', [4096]);
  const faults = [];
  rpc.on('fault', error => faults.push(error.message));
  rpc.prependListener('notification', message => { if (message.method === 'one') throw new Error('listener broke'); });
  await until(() => seen.notification.length === 2 || faults.length);
  await until(() => seen.notification.some(m => m.method === 'two'));
  assert.deepEqual(faults, ['listener broke']);
});

test('children are stopped when the host process exits', async t => {
  const dir = await tempDir(t), pidFile = path.join(dir, 'pid');
  const host = spawn(process.execPath, ['--input-type=module', '-e', `
    import { CodexRpc } from ${JSON.stringify(new URL('../server/codex-rpc.mjs', import.meta.url).href)};
    const rpc = new CodexRpc({ command: ${JSON.stringify(child('idle'))}, env: { ...process.env, PID_FILE: ${JSON.stringify(pidFile)} } });
    rpc.start(); rpc.on('notification', () => process.exit(0));`], { stdio: 'ignore' });
  await once(host, 'exit');
  const pid = Number(await readFile(pidFile, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ } });
  await until(() => !alive(pid), 3000);
});
