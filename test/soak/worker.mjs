// One life of a host process for the soak: a conversation store driven at random until
// the parent kills this process or asks it to close. Everything the parent may later hold
// the store to is reported over the IPC channel, and only once the store has said it is so.
import { createConversationStore } from '../../server/conversations.mjs';
import { isDeepStrictEqual } from 'node:util';
import { applyEvent } from '../../server/events.mjs';

const [dir, seedText] = process.argv.slice(2);
let state = Number(seedText) >>> 0;
const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
const pick = list => list[Math.floor(next() * list.length)];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tell = message => { try { process.send(message); } catch { /* the parent has gone */ } };
const KEYS = ['alpha', 'beta', 'gamma', 'a key/with odd:characters?', 'delta', 'epsilon'];
const MAX_LANES = 3;
const inLane = new Map();

const store = createConversationStore({ dir, maxLanes: MAX_LANES, maxTurns: 40, saveDelay: 15, stopGrace: 200, compactEvery: 40, keepEvents: 60, coalesce: 4,
  onError: error => tell({ problem: `onError: ${error.code ?? ''} ${error.message}` }),
  // Reported after the store's last write for the turn: from here on a crash must not lose it.
  onCall: record => tell({ finished: record.turnId, key: record.key, status: record.status }),
  run: async (turn, lane, signal, tools) => {
    if (inLane.has(lane.id)) tell({ problem: `lane ${lane.id} was given two turns at once` });
    inLane.set(lane.id, turn.id);
    try {
      const steps = Math.floor(next() * 8), stubborn = next() < 0.05;
      for (let i = 0; i < steps; i++) {
        if (i % 4 === 1) tools.text(`piece ${i} of the reply. `, { segment: i > 4 ? 1 : 0 });
        tools.activity(i % 3 ? { id: `r${i % 2}`, kind: 'reasoning', append: 'Reading the draft. ', status: 'running' } : { id: `c${i}`, kind: 'activity', command: `step ${i}`, status: 'done', output: 'ok' });
        await sleep(Math.floor(next() * 12));
        if (signal.aborted && !stubborn) throw new Error('stopped by the signal');
      }
      // A run that ignores its signal: stopGrace frees its lane while it is still going, so
      // from here it no longer counts as the lane's turn.
      if (stubborn && signal.aborted) { if (inLane.get(lane.id) === turn.id) inLane.delete(lane.id); await sleep(400); return { message: 'too late' }; }
      if (next() < 0.1) throw new Error('the pretend agent failed');
      return { message: `answer to ${turn.user}`, usage: { inputTokens: 10, outputTokens: 5 } };
    } finally { if (inLane.get(lane.id) === turn.id) inLane.delete(lane.id); }
  } });

// A copy of each conversation kept up to date from the store's events alone, as a browser
// would keep one: taken from a snapshot, then every event applied in order. The
// subscription is dropped and resumed from where it stopped, at random; a position the
// store no longer holds comes back as a gap, and the copy is taken afresh.
const copies = new Map(), stream = { resumes: 0, gaps: 0, compared: 0 };
const plain = value => JSON.parse(JSON.stringify(value));
async function follow(key, after) {
  const copy = copies.get(key) || { key };
  copies.set(key, copy);
  const take = async () => { const taken = await store.snapshot(key); copy.state = taken.conversation; copy.cursor = taken.cursor; copy.seq = taken.seq; };
  if (after === undefined) await take();
  copy.stop = store.subscribe(key, { after: after ?? copy.cursor }, (event, at) => {
    if (event.type === 'closed') return;
    if (event.type === 'gap') { stream.gaps++; copy.stale = true; return; }
    if (copy.stale) return;
    if (!applyEvent(copy.state, plain(event))) tell({ problem: `the copy of ${key} could not apply ${event.type}` });
    copy.cursor = at.cursor; copy.seq = at.seq;
  });
  await copy.stop.ready;
  if (copy.stale) { copy.stop(); copy.stale = false; await follow(key); }
}
async function check(key) {
  const copy = copies.get(key);
  if (!copy?.stop || copy.stale) return;
  const now = await store.snapshot(key);
  if (copy.seq !== now.seq) return;                          // an event is on its way; the next check will see it
  stream.compared++;
  if (!isDeepStrictEqual(plain(copy.state), now.conversation)) tell({ problem: `the copy of ${key} kept from events differs from the store at ${now.cursor}` });
}
setInterval(() => { tell({ stream: { ...stream } }); stream.resumes = stream.gaps = stream.compared = 0; }, 100).unref();

let closing = false, sent = 0;
process.on('message', async message => {
  if (message !== 'close') return;
  closing = true;
  await store.close();
  tell({ closed: true });
  process.exit(0);
});
setInterval(() => { globalThis.gc?.(); tell({ heapMb: Math.round(process.memoryUsage().heapUsed / 2 ** 20), loaded: store.loaded().length }); }, 250).unref();

const expected = code => ['full', 'busy', 'closed', 'not-found'].includes(code);
const report = what => error => { if (!expected(error.code)) tell({ problem: `${what}: ${error.code ?? ''} ${error.message}` }); };
while (!closing) {
  const key = pick(KEYS), roll = next(), turns = store.get(key)?.turns ?? [];
  if (roll < 0.5) {
    const requestId = next() < 0.3 ? `req-${process.pid}-${sent}` : undefined;
    const sending = store.send(key, { user: `request ${++sent}`, note: 'x'.repeat(Math.floor(next() * 2000)), ...(requestId ? { requestId } : {}), payload: { secret: 'never stored' } });
    sending.then(turn => tell({ accepted: turn.id, key }), error => { if (error.code === 'full') store.reset(key).then(() => tell({ reset: key }), report('reset')); else report('send')(error); });
    // The same request again, as a browser retrying would send it: it must be the same turn.
    if (requestId && next() < 0.5) Promise.all([sending, store.send(key, { user: 'retry', requestId })]).then(([a, b]) => { if (a !== b) tell({ problem: 'a repeated requestId made a second turn' }); }, () => {});
  } else if (roll < 0.62 && turns.length) store.stop(key, pick(turns).id).catch(report('stop'));
  else if (roll < 0.67) store.stopAll(key).catch(report('stopAll'));
  else if (roll < 0.72) store.reset(key).then(() => tell({ reset: key }), report('reset'));
  else if (roll < 0.78) store.save(key).catch(report('save'));
  else if (roll < 0.8) store.unload(key);
  else if (roll < 0.86) { const copy = copies.get(key); if (!copy) follow(key).catch(report('follow')); else if (copy.stop && !copy.stale) { copy.stop(); copy.stop = null; stream.resumes++; setTimeout(() => follow(key, copy.cursor).catch(report('resume')), Math.floor(next() * 30)); } }
  else if (roll < 0.95) check(key).catch(report('check'));
  for (const k of KEYS) if (store.lanes(k).length > MAX_LANES) tell({ problem: 'more lanes at work than the cap' });
  await sleep(Math.floor(next() * 6));
}
