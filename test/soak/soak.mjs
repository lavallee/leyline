#!/usr/bin/env node
// npm run soak: the conversation store under a fake provider, for many turns across lanes,
// with random stops and resets, and with the process holding it killed outright (SIGKILL)
// again and again. After each death the folder is checked and the store reopened on it.
// The workers fold their logs into snapshots every few dozen events, so the kills land in
// appends and in compactions alike; and after some lives this script cuts a log off in the
// middle of its last line, or leaves half a line on the end of it, which is what a process
// killed inside an append leaves. Each worker also keeps a copy of every conversation up to
// date from the store's events alone, dropping and resuming its subscription at random, and
// reports if the copy ever differs from the store.
//
// What must hold, every time:
//   - every conversation in the folder reads back whole from its snapshot and its log (a
//     crash leaves at worst an unfinished last line, and nothing has had to be moved aside
//     as corrupt);
//   - every turn the store reported finished is still there with the status it reported, in
//     its conversation or in the archive a reset made;
//   - every request the store accepted is still there in some state;
//   - after reopening, no turn is left running or queued;
//   - memory stays bounded however long it runs.
//
//   SOAK_SECONDS=30 (default)   how long to keep going
//   SOAK_SEED=1                 the first worker's seed; each life uses the next
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { appendFile, mkdtemp, readFile, readdir, rm, stat, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConversationStore, fileNameFor, logNameFor, readConversation } from '../../server/conversations.mjs';

const seconds = Number(process.env.SOAK_SECONDS || 30), firstSeed = Number(process.env.SOAK_SEED || 1);
const KEYS = ['alpha', 'beta', 'gamma', 'a key/with odd:characters?', 'delta', 'epsilon'];
const FINAL = ['succeeded', 'failed', 'stopped'];
const HEAP_LIMIT_MB = 120;
const dir = await mkdtemp(path.join(os.tmpdir(), 'soak-'));
const finished = new Map(), accepted = new Map();   // turn id -> { key, status }
const totals = { lives: 0, killed: 0, closed: 0, finished: 0, accepted: 0, resets: 0, recovered: 0, maxHeapMb: 0, files: 0, torn: 0, tornFound: 0, compactions: 0, resumes: 0, gaps: 0, compared: 0 };
const problems = [];

// One worker life: runs until it is killed after a random time, or asked to close.
function life(seed) {
  return new Promise(resolve => {
    const worker = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [dir, String(seed)], { execArgv: ['--expose-gc'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const graceful = seed % 4 === 0, lasts = 150 + (seed * 7919) % 1400;
    worker.on('message', m => {
      if (m.problem) problems.push(`life ${seed}: ${m.problem}`);
      if (m.finished) { finished.set(m.finished, { key: m.key, status: m.status }); totals.finished++; }
      if (m.accepted) { accepted.set(m.accepted, { key: m.key }); totals.accepted++; }
      if (m.reset) totals.resets++;
      if (m.stream) { totals.resumes += m.stream.resumes; totals.gaps += m.stream.gaps; totals.compared += m.stream.compared; }
      if (m.heapMb) { totals.maxHeapMb = Math.max(totals.maxHeapMb, m.heapMb); if (m.loaded > KEYS.length) problems.push('more conversations in memory than exist'); }
    });
    const timer = setTimeout(() => { if (graceful) worker.send('close'); else worker.kill('SIGKILL'); }, lasts);
    worker.on('exit', (code, signal) => { clearTimeout(timer); totals.lives++; if (signal === 'SIGKILL') totals.killed++; else if (code === 0) totals.closed++; else problems.push(`life ${seed}: the worker exited with ${code ?? signal}`); resolve(); });
  });
}

// Everything on disk, read as a stranger would: nothing may be invalid.
async function onDisk() {
  const kept = new Map();   // turn id -> status
  const names = await readdir(dir);
  for (const name of names) {
    if (name === 'archive' || name.endsWith('.tmp')) continue;   // a crash may leave a temporary file; the store clears old ones itself
    assert.ok(name.endsWith('.json') || name.endsWith('.events.jsonl'), `nothing was moved aside or left over: ${name}`);
    if (!name.endsWith('.json')) { assert.ok(names.includes(name.replace(/\.events\.jsonl$/, '.json')), `${name} has its snapshot`); continue; }
    const snapshot = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    assert.ok(Array.isArray(snapshot.turns) && name === fileNameFor(snapshot.key), `${name} is its own conversation`);
    if (snapshot.eventSeq > 0) totals.compactions++;
    const log = await readFile(path.join(dir, logNameFor(snapshot.key))).catch(() => null);
    if (log && log.length && log.at(-1) !== 10) totals.tornFound++;
    const conversation = await readConversation(dir, snapshot.key);   // the snapshot with its log replayed; throws if they do not fit
    for (const turn of conversation.turns) kept.set(turn.id, turn.status);
    totals.files = Math.max(totals.files, names.length);
  }
  for (const name of await readdir(path.join(dir, 'archive')).catch(() => [])) {
    if (name.endsWith('.tmp')) continue;
    for (const turn of JSON.parse(await readFile(path.join(dir, 'archive', name), 'utf8')).turns) if (!kept.has(turn.id) || FINAL.includes(turn.status)) kept.set(turn.id, turn.status);
  }
  return kept;
}

// What a process killed inside an append leaves: the log ends part-way through a line.
// Half a line is added to the end of one log. (Lines are never cut away here: this script
// cannot tell which of them the store had already reported written.)
async function tearALog(seed) {
  const logs = (await readdir(dir)).filter(name => name.endsWith('.events.jsonl'));
  if (!logs.length) return;
  const file = path.join(dir, logs[seed % logs.length]);
  await appendFile(file, '{"seq":999999,"at":"2026-01-01T00:00:00.000Z","type":"turn.activity","turnId":"0000', { mode: 0o600 });
  totals.torn++;
}

const began = Date.now();
try {
  for (let seed = firstSeed; Date.now() - began < seconds * 1000; seed++) {
    await life(seed);
    const kept = await onDisk();
    for (const [id, { key, status }] of finished) assert.equal(kept.get(id), status, `life ${seed}: a turn of ${key} reported ${status} is ${kept.get(id) ?? 'gone'} after the process died`);
    for (const [id, { key }] of accepted) assert.ok(kept.has(id), `life ${seed}: a request accepted for ${key} is gone after the process died`);
    if (seed % 3 === 0) { await tearALog(seed); const again = await onDisk(); for (const [id, { status }] of finished) assert.equal(again.get(id), status, `life ${seed}: a half-written last line changed what a reader sees`); }
    // Reopen on the same folder, as a restarted host would.
    const store = createConversationStore({ dir, run: async () => ({ message: '' }), onError: error => problems.push(`reopen: ${error.message}`) });
    for (const key of KEYS) for (const turn of (await store.open(key)).turns) {
      assert.ok(FINAL.includes(turn.status), `life ${seed}: a turn of ${key} is still ${turn.status} after reopening`);
      assert.ok((turn.activities ?? []).every(a => a.status !== 'running'), 'no activity is left running');
      if (turn.message?.startsWith('The server restarted')) totals.recovered++;
    }
    await store.close();
    assert.deepEqual(problems, []);
    assert.ok(totals.maxHeapMb < HEAP_LIMIT_MB, `the worker's heap reached ${totals.maxHeapMb} MB`);
  }
  assert.ok(totals.killed > 0 && totals.finished > 0, 'the soak did some work');
  assert.ok(totals.compactions > 0 && totals.torn > 0 && totals.resumes > 0 && totals.compared > 0, `the soak covered compaction, torn logs and resumed subscriptions: ${JSON.stringify(totals)}`);
  for (const name of await readdir(dir)) if (name.endsWith('.events.jsonl')) assert.equal((await readFile(path.join(dir, name))).at(-1), 10, `${name}: after the last reopening no log ends in half a line`);
  console.log(`soak passed in ${((Date.now() - began) / 1000).toFixed(1)} s: ${totals.lives} process lives (${totals.killed} killed, ${totals.closed} closed), ${totals.accepted} requests accepted, ${totals.finished} turns finished, ${totals.resets} resets, ${totals.recovered} interrupted turns seen on reopen, ${totals.compactions} snapshots found made by compaction, ${totals.torn} logs left with half a line (${totals.tornFound} more found torn by a kill), ${totals.resumes} subscriptions resumed (${totals.gaps} with a gap) and ${totals.compared} copies compared with the store, peak worker heap ${totals.maxHeapMb} MB (limit ${HEAP_LIMIT_MB}).`);
} catch (error) {
  console.error(`soak FAILED after ${((Date.now() - began) / 1000).toFixed(1)} s (seed ${firstSeed}); the folder is kept at ${dir}`);
  console.error(error.message);
  process.exitCode = 1;
}
if (!process.exitCode) await rm(dir, { recursive: true, force: true });
