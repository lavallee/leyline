import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { stat, readFile, writeFile, chmod, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { issueKey, sameSecret, sessionFile, stateHome, writeSession, readSession, removeSession, verifyRequest, createCommandEndpoint, call, readStdin } from '@lyra-forge/agent-chat/server/commands';
import { tempDir } from './helpers.mjs';

const request = (overrides = {}, key = 'k'.repeat(48), port = 4173) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${key}` }, ...overrides });

test('keys are random and compared in constant time', () => {
  const a = issueKey(), b = issueKey();
  assert.match(a, /^[0-9a-f]{48}$/); assert.notEqual(a, b);
  assert.equal(sameSecret(a, a), true);
  assert.equal(sameSecret(a, b), false);
  assert.equal(sameSecret(a.slice(0, 10), a), false, 'a prefix does not match');
  assert.equal(sameSecret(undefined, a), false);
  assert.equal(sameSecret('', ''), false, 'an empty secret never matches');
});

test('verifyRequest wants loopback, a loopback Host, no Origin and the right bearer key', () => {
  const key = 'k'.repeat(48), ok = { key, port: 4173 };
  assert.equal(verifyRequest(request(), ok), true);
  assert.equal(verifyRequest(request({ socket: { remoteAddress: '::1' }, headers: { host: 'localhost:4173', authorization: `Bearer ${key}` } }), ok), true);
  assert.equal(verifyRequest(request({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), ok), true);
  assert.equal(verifyRequest(request({ socket: { remoteAddress: '192.168.1.20' } }), ok), false, 'another machine');
  assert.equal(verifyRequest(request({ headers: { host: 'evil.example:4173', authorization: `Bearer ${key}` } }), ok), false, 'DNS rebinding: the Host header is not ours');
  assert.equal(verifyRequest(request({ headers: { host: '127.0.0.1:9999', authorization: `Bearer ${key}` } }), ok), false, 'another port');
  assert.equal(verifyRequest(request({ headers: { host: '127.0.0.1:4173', authorization: `Bearer ${key}`, origin: 'http://127.0.0.1:4173' } }), ok), false, 'any Origin header means a web page');
  assert.equal(verifyRequest(request({ headers: { host: '127.0.0.1:4173', authorization: `Bearer ${'x'.repeat(48)}` } }), ok), false);
  assert.equal(verifyRequest(request({ headers: { host: '127.0.0.1:4173', authorization: key } }), ok), false, 'the Bearer scheme is required');
  assert.equal(verifyRequest(request({ headers: { host: '127.0.0.1:4173' } }), ok), false);
  assert.equal(verifyRequest({ headers: {} }, ok), false);
});

test('session files live under the state directory, private, and are replaced whole', async t => {
  const stateDir = await tempDir(t);
  const file = await writeSession({ app: 'copycat', name: 'agent-4173', url: 'http://127.0.0.1:4173', key: 'first', stateDir });
  assert.equal(file, path.join(stateDir, 'copycat', 'agent-4173.json'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  await chmod(file, 0o644);   // an older, looser file
  await writeSession({ app: 'copycat', name: 'agent-4173', url: 'http://127.0.0.1:4173', key: 'second', stateDir });
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'replacing a loose file tightens it');
  assert.deepEqual(await readSession({ app: 'copycat', name: 'agent-4173', stateDir }), { url: 'http://127.0.0.1:4173', key: 'second' });
  assert.deepEqual(await readdir(path.dirname(file)), ['agent-4173.json'], 'no temporary file is left behind');
  await removeSession({ app: 'copycat', name: 'agent-4173', stateDir });
  await assert.rejects(readSession({ app: 'copycat', name: 'agent-4173', stateDir }));
  await removeSession({ app: 'copycat', name: 'agent-4173', stateDir });
  for (const bad of [{ app: '../etc', name: 'x' }, { app: 'a', name: 'b/c' }, { app: '', name: 'x' }, { app: 'a', name: '.hidden' }])
    assert.throws(() => sessionFile({ ...bad, stateDir }), TypeError);
  await assert.rejects(writeSession({ app: 'a', name: 'b', url: 'https://example.com', key: 'k', stateDir }), /loopback/);
  assert.equal(stateHome({ XDG_STATE_HOME: '/custom/state' }), '/custom/state');
  assert.match(stateHome({}), /\.local\/state$/);
  assert.match(stateHome({ XDG_STATE_HOME: 'relative' }), /\.local\/state$/, 'a relative XDG_STATE_HOME is ignored');
});

async function host(t, operations) {
  const stateDir = await tempDir(t);
  let endpoint;
  const server = http.createServer(async (req, res) => { if (!await endpoint.handle(req, res)) res.writeHead(200, { 'content-type': 'text/plain' }).end('the rest of the host'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  endpoint = createCommandEndpoint({ port, operations });
  await writeSession({ app: 'testhost', name: `agent-${port}`, url: `http://127.0.0.1:${port}`, key: endpoint.key, stateDir });
  return { port, stateDir, key: endpoint.key, session: { app: 'testhost', name: `agent-${port}`, stateDir } };
}
// A raw HTTP request, so the test can send headers fetch() would not allow.
const raw = (port, lines, body = '') => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => socket.end([...lines, `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close', '', body].join('\r\n')));
  let text = ''; socket.on('data', d => { text += d; }); socket.on('end', () => resolve({ status: Number(text.split(' ')[1]), text })); socket.on('error', reject);
});

test('end to end: a CLI calls the host’s operations over loopback with the session key', async t => {
  const calls = [];
  const { session, port } = await host(t, {
    show: async data => { calls.push(data); return { files: { 'content.md': '# Title' } }; },
    edit: data => { if (!Array.isArray(data.edits)) throw Object.assign(new Error('Give 1 to 40 edits.'), { status: 400 }); return { results: data.edits.map(() => 'made') }; },
    crash: () => { throw new Error('internal detail with a /secret/path'); },
    nothing: () => undefined,
  });
  assert.deepEqual(await call({ ...session, operation: 'show', data: { page: 'abc:main' } }), { files: { 'content.md': '# Title' } });
  assert.deepEqual(calls, [{ page: 'abc:main' }]);
  assert.deepEqual(await call({ ...session, operation: 'edit', data: { edits: [{}, {}] } }), { results: ['made', 'made'] });
  assert.deepEqual(await call({ ...session, operation: 'nothing' }), {});
  await assert.rejects(call({ ...session, operation: 'edit' }), { message: 'Give 1 to 40 edits.' });
  await assert.rejects(call({ ...session, operation: 'crash' }), { message: 'The command failed.' });
  await assert.rejects(call({ ...session, operation: 'no-such-operation' }), { message: 'Not found.' });
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/other`)).text(), 'the rest of the host', 'paths outside the prefix are left to the host');
});

test('end to end: requests that fail the checks get the same plain 404', async t => {
  const { port, key } = await host(t, { show: () => ({ secret: 'draft text' }) });
  const post = (headers, body = '{}') => raw(port, ['POST /agent/show HTTP/1.1', ...headers], body);
  const good = [`Host: 127.0.0.1:${port}`, 'Content-Type: application/json', `Authorization: Bearer ${key}`];
  assert.equal((await post(good)).status, 200);
  const refused = [
    await post([`Host: 127.0.0.1:${port}`, 'Content-Type: application/json']),
    await post([`Host: 127.0.0.1:${port}`, 'Content-Type: application/json', 'Authorization: Bearer wrong']),
    await post([...good, `Origin: http://127.0.0.1:${port}`]),
    await post([`Host: attacker.example:${port}`, 'Content-Type: application/json', `Authorization: Bearer ${key}`]),
  ];
  for (const response of refused) { assert.equal(response.status, 404); assert.ok(!response.text.includes('draft text')); }
  assert.equal((await raw(port, ['GET /agent/show HTTP/1.1', ...good])).status, 405);
  assert.equal((await post([`Host: 127.0.0.1:${port}`, 'Content-Type: text/plain', `Authorization: Bearer ${key}`])).status, 405, 'a simple form post is not accepted');
  assert.equal((await post(good, '{ not json')).status, 400);
  assert.equal((await post(good, '[1,2]')).status, 400);
});

test('the endpoint limits the body size and accepts a port known only later', async t => {
  let port = 0;
  const endpoint = createCommandEndpoint({ port: () => port, operations: { echo: data => data }, maxBody: 100, prefix: '/doc/' });
  const server = http.createServer((req, res) => endpoint.handle(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  port = server.address().port;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${endpoint.key}` };
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/doc/echo`, { method: 'POST', headers, body: '{"a":1}' })).json(), { a: 1 });
  const big = await fetch(`http://127.0.0.1:${port}/doc/echo`, { method: 'POST', headers, body: JSON.stringify({ a: 'x'.repeat(500) }) }).then(r => r.status, () => 'closed');
  assert.ok(big === 413 || big === 'closed');
});

test('call() explains a missing session, a dead server, and refuses a session that points elsewhere', async t => {
  const stateDir = await tempDir(t);
  await assert.rejects(call({ app: 'testhost', name: 'agent-1', operation: 'show', stateDir }), /No testhost session found for "agent-1"/);
  await writeSession({ app: 'testhost', name: 'agent-1', url: 'http://127.0.0.1:1', key: 'k', stateDir });
  await assert.rejects(call({ app: 'testhost', name: 'agent-1', operation: 'show', stateDir }), /Could not reach testhost/);
  // A tampered session file must not send the key to another machine.
  await mkdir(path.join(stateDir, 'testhost'), { recursive: true });
  await writeFile(path.join(stateDir, 'testhost', 'agent-2.json'), JSON.stringify({ url: 'http://collector.example', key: 'the-key' }));
  let fetched = false;
  await assert.rejects(call({ app: 'testhost', name: 'agent-2', operation: 'show', stateDir, fetch: () => { fetched = true; } }), /does not point at this machine/);
  assert.equal(fetched, false);
});

test('readStdin collects a stream', async () => {
  async function* chunks() { yield '{"edits":'; yield '[]}'; }
  assert.equal(await readStdin(chunks()), '{"edits":[]}');
});
