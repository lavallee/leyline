// Subscribing to a conversation and resuming: the store's subscribe(), the Server-Sent
// Events helper, and the browser client, including a fuzz of random disconnects.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createConversationStore as create } from '../server/conversations.mjs';
import { streamConversation } from '../server/stream.mjs';
import { applyEvent } from '../server/events.mjs';
import { followConversation } from '../src/stream-client.mjs';
import { tempDir, until, deferred, beforeCleanup } from './helpers.mjs';

const createConversationStore = options => { const store = create(options); beforeCleanup(() => store.close()); return store; };
const settled = turn => until(() => ['succeeded', 'failed', 'stopped'].includes(turn.status));
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

// A host's server: GET /stream/<key> is the conversation's stream. `current()` gives the store, so a test can replace it.
async function serve(current, options = {}) {
  const sockets = new Set(), streams = new Set();
  const server = http.createServer((req, res) => {
    const key = decodeURIComponent(req.url.split('/')[2] || '');
    const stream = streamConversation(current(), key, req, res, options);
    streams.add(stream); stream.done.then(() => streams.delete(stream));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  beforeCleanup(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { url: key => `http://127.0.0.1:${server.address().port}/stream/${encodeURIComponent(key)}`, sockets, streams };
}

// Reads a stream by hand, as text, so the tests can see exactly what was sent.
function listen(url, headers = {}) {
  const got = { events: [], comments: 0, status: null, raw: '', ended: false };
  const req = http.get(url, { headers }, res => {
    got.status = res.statusCode; got.headers = res.headers; got.res = res;
    res.setEncoding('utf8');
    res.on('data', chunk => {
      got.raw += chunk;
      let at;
      while ((at = got.raw.indexOf('\n\n')) >= 0) {
        const block = got.raw.slice(0, at); got.raw = got.raw.slice(at + 2);
        const fields = Object.fromEntries(block.split('\n').filter(line => !line.startsWith(':')).map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
        if (block.startsWith(':')) got.comments++;
        if (fields.data) got.events.push({ type: fields.event || 'message', id: fields.id, data: JSON.parse(fields.data) });
        if (fields.retry) got.retry = Number(fields.retry);
      }
    });
    res.on('end', () => { got.ended = true; }); res.on('error', () => { got.ended = true; });
  });
  req.on('error', () => { got.ended = true; });
  got.close = () => req.destroy();
  beforeCleanup(got.close);
  return got;
}

test('subscribe delivers what happened after a position, then what happens next', async t => {
  const dir = await tempDir(t), gate = deferred(), errors = [];
  const store = createConversationStore({ dir, coalesce: 0, saveDelay: 0, onError: e => errors.push(e.message), run: async (turn, lane, signal, tools) => {
    tools.activity({ id: 'r', kind: 'reasoning', append: 'Reading the draft with care. ', status: 'running' });
    tools.text('The reply ');
    await store.save(lane.key);                               // what has arrived so far becomes events now, not when the timer fires
    if (turn.user === 'wait') await gate.promise;
    tools.text('arrives.');
    return { message: 'The reply arrives.' };
  } });
  const start = await store.snapshot('k');
  assert.deepEqual([start.seq, start.conversation], [0, { key: 'k', turns: [] }]);
  assert.equal(start.cursor, `${start.epoch}:0`);
  await settled(await store.send('k', { user: 'first' }));
  const all = [], raw = [], late = [];
  const stopAll = store.subscribe('k', { after: start.cursor }, (event, at) => all.push([event, at]));
  const ready = await stopAll.ready;
  assert.deepEqual(ready, store.position('k'));
  assert.deepEqual(all.map(([event]) => event.seq), all.map((_, i) => i + 1), 'everything since the position, in order');
  assert.deepEqual(all.map(([, at]) => at.cursor), all.map((_, i) => `${start.epoch}:${i + 1}`));
  assert.deepEqual([...new Set(all.map(([event]) => event.type))], ['turn.created', 'turn.status', 'turn.activity', 'turn.text', 'turn.finished']);
  // A copy made from the snapshot and the events is the conversation.
  const copy = start.conversation;
  for (const [event] of all) assert.ok(applyEvent(copy, plain(event)));
  assert.deepEqual(copy, plain(store.get('k')));
  const before = all.length;
  store.subscribe('k', { after: all[2][0].seq, raw: true }, (line, at) => raw.push([line, at.seq]));
  store.subscribe('k', event => late.push(event));           // no position: only what happens from now on
  store.subscribe('k', () => { throw new Error('a listener broke'); });
  await until(() => raw.length === before - 3);
  assert.ok(raw.every(([line, seq]) => typeof line === 'string' && JSON.parse(line).seq === seq), 'raw: the JSON text of each event');
  assert.equal(store.subscribers('k'), 4);
  const turn = await store.send('k', { user: 'wait' });
  await until(() => turn.preview === 'The reply ' && late.some(e => e.type === 'turn.text'));
  assert.deepEqual(late.find(e => e.type === 'turn.text').set, { preview: 'The reply ' });
  stopAll();
  gate.resolve(); await settled(turn);
  assert.equal(turn.preview, undefined, 'the preview is gone once the reply is the message');
  assert.equal(all.length, before + late.filter(e => e.seq <= all.at(-1)[0].seq).length, 'a stopped subscription hears nothing more');
  assert.deepEqual(late.at(-1).unset, ['preview']);
  assert.equal(late.at(-1).type, 'turn.finished');
  assert.ok(errors.includes('a listener broke'), 'a throwing listener is reported and the others still hear');
  assert.equal(store.subscribers('k'), 3);
  await store.close();
  assert.equal(late.at(-1).type, 'closed');
  assert.throws(() => store.subscribe('k', {}), TypeError);
});

test('a position the store no longer holds is answered with a gap', async t => {
  const dir = await tempDir(t);
  let store = create({ dir, keepEvents: 5, run: async () => ({ message: 'ok' }) });
  for (let i = 0; i < 4; i++) await settled(await store.send('k', { user: `r${i}` }));
  const here = store.position('k'), heard = [];
  const hear = after => { const list = []; heard.push(list); return store.subscribe('k', { after }, (event, at) => list.push({ type: event.type, seq: event.seq, gap: at.gap })).ready; };
  await hear(`${here.epoch}:0`);                              // older than the five events kept
  await hear(`${here.epoch}:${here.seq - 2}`);                // still held
  await hear(`someoneelse:${here.seq}`);                      // another epoch: a restart
  await hear(`${here.epoch}:${here.seq + 50}`);               // the future
  await hear('not a cursor');
  assert.deepEqual(heard[0], [{ type: 'gap', seq: here.seq, gap: true }]);
  assert.deepEqual(heard[1].map(e => e.seq), [here.seq - 1, here.seq]);
  for (const list of heard.slice(2)) assert.deepEqual(list, [{ type: 'gap', seq: here.seq, gap: true }]);
  await store.close();
  store = createConversationStore({ dir, run: async () => ({ message: 'ok' }) });
  const again = [];
  await store.subscribe('k', { after: here.cursor }, event => again.push(event.type)).ready;
  assert.deepEqual(again, ['gap'], 'a cursor from before a restart is a gap: numbers handed out then may never have reached the disk');
  assert.notEqual(store.position('k').epoch, here.epoch);
});

test('the stream: a snapshot, then events; Last-Event-ID resumes exactly; an old position gets a new snapshot', async t => {
  const dir = await tempDir(t);
  const store = createConversationStore({ dir, keepEvents: 12, coalesce: 0, saveDelay: 0, run: async turn => ({ message: `reply to ${turn.user}` }) });
  const host = await serve(() => store, { retry: 250 });
  const first = listen(host.url('k'));
  await until(() => first.events.length === 1);
  assert.equal(first.status, 200);
  assert.match(first.headers['content-type'], /^text\/event-stream/);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal(first.retry, 250);
  assert.deepEqual(first.events[0], { type: 'snapshot', id: store.position('k').cursor, data: { cursor: store.position('k').cursor, reason: 'start', conversation: { key: 'k', turns: [] } } });
  await settled(await store.send('k', { user: 'one' }));
  await until(() => first.events.at(-1).data.type === 'turn.finished');
  assert.deepEqual(first.events.slice(1).map(e => e.data.seq), [1, 2, 3]);
  assert.ok(first.events.slice(1).every(e => e.type === 'message' && e.id === `${store.position('k').epoch}:${e.data.seq}`));
  first.close();
  await until(() => store.subscribers('k') === 0);
  // While nobody listens, more happens. A client that returns with the last id it saw gets exactly the rest.
  await settled(await store.send('k', { user: 'two' }));
  const second = listen(host.url('k'), { 'last-event-id': first.events.at(-1).id });
  await until(() => second.events.length === 3);
  assert.deepEqual(second.events.map(e => [e.type, e.data.seq]), [['message', 4], ['message', 5], ['message', 6]]);
  const copy = first.events[0].data.conversation;
  for (const event of [...first.events.slice(1), ...second.events]) assert.ok(applyEvent(copy, event.data));
  assert.deepEqual(copy, plain(store.get('k')));
  second.close();
  // Enough happens that the old position is no longer held.
  for (let i = 0; i < 5; i++) await settled(await store.send('k', { user: `more ${i}` }));
  const third = listen(host.url('k'), { 'last-event-id': first.events[1].id });
  await until(() => third.events.length === 1);
  assert.deepEqual([third.events[0].type, third.events[0].data.reason], ['snapshot', 'gap']);
  assert.deepEqual(third.events[0].data.conversation, plain(store.get('k')));
  const unknown = listen(host.url('k'), { 'last-event-id': 'nonsense' });
  await until(() => unknown.events.length === 1);
  assert.equal(unknown.events[0].data.reason, 'gap');
});

test('the stream: heartbeats while quiet, clean teardown, and an unreadable conversation is an HTTP error', async t => {
  const dir = await tempDir(t);
  const store = createConversationStore({ dir, run: async () => ({ message: 'ok' }) });
  const host = await serve(() => store, { heartbeat: 10 });
  const client = listen(host.url('k'));
  await until(() => client.comments >= 3);
  assert.equal(store.subscribers('k'), 1);
  assert.equal(host.streams.size, 1);
  client.close();
  await until(() => store.subscribers('k') === 0 && host.streams.size === 0);
  // The store closing ends the streams it feeds.
  const other = listen(host.url('k'));
  await until(() => other.events.length === 1);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(dir, 'broken.json'));
  const broken = listen(host.url('broken'));
  await until(() => broken.ended);
  assert.equal(broken.status, 500);
  await store.close();
  await until(() => other.ended && host.streams.size === 0);
});

test('the stream: a client that stops reading is not buffered for without bound, and is given a snapshot when it returns', async t => {
  const dir = await tempDir(t), gate = deferred(), filler = 'x'.repeat(4000);
  let produced = 0;
  const store = createConversationStore({ dir, coalesce: 0, saveDelay: 0, maxActivities: 100000, keepEvents: 50, run: async (turn, lane, signal, tools) => {
    for (let i = 0; i < 3000; i++) { tools.activity({ id: `a${i % 50}`, kind: 'activity', text: `${i} ${filler}`, status: 'running' }); produced++; if (i % 20 === 0) await tick(); }
    await gate.promise;
    return { message: 'done' };
  } });
  const host = await serve(() => store, { maxBuffered: 64_000, heartbeat: 0 });
  const slow = listen(host.url('k'));
  await until(() => slow.events.length === 1);
  slow.res.pause();                                           // the client stops reading; 12 MB of events follow
  const [stream] = [...host.sockets];
  let most = 0;
  const watch = setInterval(() => { most = Math.max(most, stream.writableLength); }, 1);
  const turn = await store.send('k', { user: 'flood' });
  await until(() => produced === 3000);
  clearInterval(watch);
  most = Math.max(most, stream.writableLength);
  // What may wait in memory for it: the bound and the event that crossed it, or one snapshot (50 items of 4 KB), never the flood.
  assert.ok(most < 300_000, `bounded: ${most} bytes were waiting at most, of 12,000,000 produced`);
  assert.equal(store.subscribers('k'), 0, 'the store is no longer asked to deliver to it');
  slow.res.resume();
  await until(() => slow.events.some(e => e.type === 'snapshot' && e.data.reason === 'lag'));
  gate.resolve(); await settled(turn);
  await until(() => slow.events.at(-1).id === store.position('k').cursor);
  const from = slow.events.findLastIndex(e => e.type === 'snapshot'), copy = slow.events[from].data.conversation;
  for (const event of slow.events.slice(from + 1)) assert.ok(applyEvent(copy, event.data));
  assert.deepEqual(copy, plain(store.get('k')), 'what it holds in the end is the conversation');
});

test('the client: follows, reconnects with backoff, and resumes where it stopped', async t => {
  const dir = await tempDir(t), statuses = [], gaps = [], changes = [];
  const store = createConversationStore({ dir, coalesce: 0, saveDelay: 0, run: async (turn, lane, signal, tools) => { tools.text('Half'); await store.save(lane.key); tools.text('way'); return { message: 'Done.' }; } });
  const host = await serve(() => store);
  let refuse = 0, requests = [];
  const fetcher = (url, init) => { requests.push(init.headers['last-event-id'] ?? null); if (refuse > 0) { refuse--; return Promise.reject(new Error('connection refused')); } return fetch(url, init); };
  const client = followConversation(host.url('k'), { fetch: fetcher, minDelay: 1, maxDelay: 8, onStatus: (status, detail) => statuses.push([status, detail?.delay]), onGap: reason => gaps.push(reason), onChange: (state, event) => changes.push(event?.type ?? 'snapshot') });
  beforeCleanup(() => client.close());
  await until(() => client.state);
  assert.deepEqual(client.state, { key: 'k', turns: [] });
  await settled(await store.send('k', { user: 'one' }));
  await until(() => client.cursor === store.position('k').cursor);
  assert.deepEqual(client.state, plain(store.get('k')));
  assert.deepEqual([...new Set(changes)], ['snapshot', 'turn.created', 'turn.status', 'turn.text', 'turn.finished']);
  // The connection drops, and the server cannot be reached for a while.
  const seen = client.cursor;
  refuse = 4; requests = [];
  for (const socket of host.sockets) socket.destroy();
  await settled(await store.send('k', { user: 'two' }));
  await until(() => client.cursor === store.position('k').cursor);
  assert.deepEqual(client.state, plain(store.get('k')));
  assert.deepEqual(requests, Array(5).fill(seen), 'every attempt asked to resume from the last event applied');
  assert.deepEqual(gaps, [], 'nothing was missed, so nothing was replaced');
  const waits = statuses.filter(([status]) => status === 'waiting').map(([, delay]) => delay).slice(-5);
  assert.ok(waits.every(delay => delay <= 8) && waits[3] > waits[0], `the wait grows and is capped: ${waits}`);
  client.close();
  await until(() => statuses.at(-1)[0] === 'closed' && store.subscribers('k') === 0);
});

test('fuzz: random disconnects, resumes, slow readers and a server restart leave every client with the server’s state', async t => {
  for (const seed of [1, 2, 3]) {
    let state = seed; const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
    const dir = await tempDir(t), problems = [], gates = new Set();
    const open = () => create({ dir, maxLanes: 3, coalesce: seed === 2 ? 0 : 2, saveDelay: 3, keepEvents: seed === 3 ? 15 : 400, compactEvery: 60, onError: e => problems.push(`store: ${e.message}`),
      run: async (turn, lane, signal, tools) => {
        const steps = 2 + Math.floor(next() * 12);
        for (let i = 0; i < steps; i++) {
          const roll = next();
          if (roll < 0.4) tools.text(`word${i} `, { segment: i > 6 ? 1 : 0 });
          else if (roll < 0.8) tools.activity({ id: `r${i % 3}`, kind: 'reasoning', append: `thinking ${i} about the draft. `, status: 'running' });
          else { turn.proposals = [...(turn.proposals || []), { key: `e${i}`, fate: 'applied' }]; tools.save(); }
          if (signal.aborted) throw new Error('aborted');
          if (next() < 0.5) await tick(); else await new Promise((resolve, reject) => { const gate = { resolve }; gates.add(gate); signal.addEventListener('abort', () => { gates.delete(gate); reject(new Error('aborted')); }); });
        }
        if (next() < 0.15) throw new Error('the pretend agent failed');
        return { message: `reply to ${turn.user}` };
      } });
    let store = open();
    const host = await serve(() => store, { maxBuffered: seed === 2 ? 3000 : 1_000_000, heartbeat: 5 });
    const keys = ['a', 'b'], clients = [];
    for (const key of keys) for (let n = 0; n < 2; n++) {
      const client = followConversation(host.url(key), { minDelay: 1, maxDelay: 4, silence: 2000, onGap: reason => { client.gaps.push(reason); }, onStatus: status => { client.status = status; } });
      Object.assign(client, { key, gaps: [] }); clients.push(client); beforeCleanup(() => client.close());
    }
    for (let step = 0; step < 220; step++) {
      const key = keys[Math.floor(next() * keys.length)], roll = next(), turns = store.get(key)?.turns ?? [];
      if (roll < 0.3) store.send(key, { user: `s${step}` }).catch(e => { if (!['full', 'closed'].includes(e.code)) problems.push(`send: ${e.message}`); });
      else if (roll < 0.6) { const gate = [...gates][Math.floor(next() * gates.size)]; if (gate) { gates.delete(gate); gate.resolve(); } }
      else if (roll < 0.68) clients[Math.floor(next() * clients.length)].reconnect();                       // the browser drops the connection
      else if (roll < 0.76) { const sockets = [...host.sockets]; sockets[Math.floor(next() * sockets.length)]?.destroy(); }   // the network does
      else if (roll < 0.8 && turns.length) store.stop(key, turns[Math.floor(next() * turns.length)].id).catch(() => {});
      else if (roll < 0.84 && turns.length) store.update(key, turns[Math.floor(next() * turns.length)].id, turn => { turn.note = `note ${step}`; }).catch(() => {});
      else if (roll < 0.87) store.reset(key).catch(() => {});
      else if (roll < 0.885) { await store.close(); for (const gate of gates) gate.resolve(); gates.clear(); store = open(); }   // the server restarts
      if (next() < 0.6) await tick(); else await new Promise(resolve => setTimeout(resolve, Math.floor(next() * 4)));
    }
    await until(() => { for (const gate of gates) gate.resolve(); gates.clear(); return keys.every(key => !store.busy(key)); }, 60000);
    for (const key of keys) await store.open(key);
    await until(() => clients.every(client => client.cursor === store.position(client.key).cursor), 60000)
      .catch(() => { throw new Error(`seed ${seed}: clients did not catch up: ${JSON.stringify(clients.map(client => ({ key: client.key, at: client.cursor, server: store.position(client.key).cursor, status: client.status, gaps: client.gaps })))}; streams ${host.streams.size}, subscribers ${keys.map(key => store.subscribers(key))}`); });
    for (const client of clients) assert.deepEqual(client.state, (await store.snapshot(client.key)).conversation, `seed ${seed}: a client of ${client.key} holds the server's state`);
    assert.deepEqual(problems, [], `seed ${seed}`);
    assert.ok(clients.every(client => !client.gaps.includes('mismatch')), `seed ${seed}: no event ever failed to apply`);
    for (const client of clients) client.close();
    await until(() => keys.every(key => store.subscribers(key) === 0));
    await store.close();
  }
});
