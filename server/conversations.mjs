// The turn store behind a chat panel: conversations keyed by a host string, each a list
// of turns, kept in one private JSON file per conversation. It queues requests, runs
// them side by side in lanes up to a cap, records activity as it arrives, and survives a
// restart. Generalised from the stores Copycat and Skein each wrote (their src/chat.js).
//
// It knows nothing about documents, prompts or agents. The host supplies
//   run(turn, lane, signal, tools) -> Promise<{ message, ...fields }>
// and does whatever it likes inside: call a provider, check an answer, build proposals.
//
// A turn:
//   { id, user, status, createdAt, startedAt, finishedAt?, message, activities: [], ...host fields }
//   status: 'queued' -> 'running' -> 'succeeded' | 'failed' | 'stopped'
//
// Lanes: the first request to start takes the main lane, whose id is `${key}:main` and
// never changes, so an agent keyed by it keeps its memory from turn to turn. A request
// that starts while the main lane is busy gets a side lane with an id of its own, used
// once: a fresh agent. `maxLanes: 1` gives a strict one-at-a-time queue.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { foldActivity, settleActivity } from './providers/contract.mjs';

export const TURN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'stopped'];
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const RESERVED = ['id', 'status', 'createdAt', 'startedAt', 'finishedAt', 'activities'];

const MESSAGES = {
  interrupted: 'The server restarted before this request finished. It is kept; send it again to continue.',
  removed: 'Removed before it started.',
  stopped: 'Stopped.',
  full: 'This conversation is full. Start a new one to continue.',
  busy: 'Stop the current requests before starting a new conversation.',
  unknownTurn: 'That request is not in this conversation.',
};

/** An error the store raises on purpose. `code`: 'full' | 'busy' | 'not-found' | 'invalid'. */
export class ConversationError extends Error {
  constructor(message, code, status) { super(message); this.name = 'ConversationError'; this.code = code; this.status = status ?? { full: 409, busy: 409, 'not-found': 404 }[code] ?? 400; }
}

/** The file name a key is stored under: the key itself when it is plainly safe, a hash of it otherwise. */
export const fileNameFor = key => `${SAFE_KEY.test(key) ? key : createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`;

/**
 * @param {object} options
 * @param {string} options.dir where conversations are kept; created private (0700), files 0600
 * @param {(turn: object, lane: object, signal: AbortSignal, tools: object) => Promise<object>} options.run
 *   lane: { id, name, main, key }.
 *   tools: { payload, conversation, activity(event), save() }. `payload` is whatever the
 *   host passed to send() and is never written to disk; `activity` folds a provider event
 *   into turn.activities; `save` schedules a write after the host changes the turn itself.
 * @param {number} [options.maxLanes] requests running at once per conversation; default 4
 * @param {number} [options.maxTurns] default 200
 * @param {number} [options.maxActivities] per turn; default 200
 * @param {number} [options.saveDelay] milliseconds activity writes are batched for; default 600
 * @param {object} [options.messages] wording overrides; see MESSAGES in this file
 * @param {(error: Error, turn: object) => string} [options.describeFailure] the message stored on a failed turn
 * @param {(event: object, item: object) => object|void} [options.describeActivity] rewords an activity before it is stored
 * @param {(lane: object, turn: object) => void} [options.onLaneClosed] after a lane finishes: the place to reset a side lane's agent
 * @param {(record: object) => void} [options.onCall] one record per finished turn; see ./telemetry.mjs
 * @param {(error: Error) => void} [options.onError] problems that have nowhere else to go (a failed write, a throwing hook)
 */
export function createConversationStore({ dir, run, maxLanes = 4, maxTurns = 200, maxActivities = 200, saveDelay = 600, messages = {},
  describeFailure = error => String(error?.message || error).slice(0, 300), describeActivity, onLaneClosed, onCall, onError = () => {} } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('Give the store a directory.');
  if (typeof run !== 'function') throw new TypeError('Give the store a run(turn, lane, signal, tools) function.');
  const words = { ...MESSAGES, ...messages };
  const conversations = new Map();  // key -> conversation
  const loading = new Map();        // key -> Promise<conversation>
  const queues = new Map();         // key -> [{ turn, payload }]
  const running = new Map();        // lane id -> { turn, lane, controller, timer }
  let writes = Promise.resolve();
  const now = () => new Date().toISOString();
  const guard = fn => { try { return fn(); } catch (error) { onError(error); } };

  const check = key => { if (typeof key !== 'string' || !key || key.includes('\0')) throw new ConversationError('Invalid conversation key.', 'invalid'); return key; };
  // A lane is at work until its turn has its final status. The last write and the hooks
  // that follow do not keep a conversation busy.
  const lanesOf = key => [...running.values()].filter(r => r.lane.key === key && !r.done);

  // One write at a time, each to a temporary file that is then renamed over the real one.
  function persist(conversation) {
    const file = path.join(dir, fileNameFor(conversation.key));
    const bytes = JSON.stringify(conversation, null, 2);
    const operation = writes.then(async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(`${file}.tmp`, bytes, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    writes = operation.catch(() => {});
    return operation;
  }

  /** Loads a conversation, or starts an empty one. Turns an earlier process left unfinished are marked failed. */
  function open(key) {
    try { check(key); } catch (error) { return Promise.reject(error); }
    if (conversations.has(key)) return Promise.resolve(conversations.get(key));
    if (!loading.has(key)) loading.set(key, (async () => {
      let stored = { key, turns: [] }, recovered = false;
      try {
        const read = JSON.parse(await readFile(path.join(dir, fileNameFor(key)), 'utf8'));
        if (read && Array.isArray(read.turns) && (read.key === key || read.key === undefined)) stored = { ...read, key };
      } catch { /* none yet, or unreadable: start empty and leave the file for the next write */ }
      for (const turn of stored.turns) if (turn.status === 'running' || turn.status === 'queued') {
        Object.assign(turn, { status: 'failed', message: words.interrupted, finishedAt: turn.finishedAt || now() });
        settleActivity(turn.activities ||= [], false); recovered = true;
      }
      conversations.set(key, stored); loading.delete(key);
      if (recovered) await persist(stored).catch(onError);
      return stored;
    })());
    return loading.get(key);
  }

  /**
   * Adds a request to a conversation and starts it when a lane is free.
   * @param {string} key
   * @param {object} request `user` is the text shown for the request. `payload` is handed to
   *   run() and not stored. Every other field is stored on the turn as given.
   * @returns {Promise<object>} the turn, already written to disk
   */
  async function send(key, { user, payload, ...fields } = {}) {
    const conversation = await open(key);
    if (typeof user !== 'string') throw new ConversationError('A request needs its text (user).', 'invalid');
    if (conversation.turns.length >= maxTurns) throw new ConversationError(words.full, 'full');
    for (const name of RESERVED) delete fields[name];
    const at = now();
    const turn = { id: randomUUID(), user, status: 'queued', createdAt: at, startedAt: at, message: '', ...fields, activities: [] };
    conversation.turns.push(turn);
    try { await persist(conversation); } catch (error) { conversation.turns.splice(conversation.turns.indexOf(turn), 1); throw error; }
    const queue = queues.get(key) || []; queues.set(key, queue);
    queue.push({ turn, payload });
    pump(conversation);
    return turn;
  }

  function pump(conversation) {
    const key = conversation.key, queue = queues.get(key) || [];
    while (queue.length) {
      const busy = lanesOf(key);
      if (busy.length >= maxLanes) return;
      const next = queue.shift();
      const name = busy.some(r => r.lane.main) ? next.turn.id.slice(0, 8) : 'main';
      const lane = { id: `${key}:${name}`, name, main: name === 'main', key };
      const runtime = { turn: next.turn, lane, controller: new AbortController(), timer: null };
      running.set(lane.id, runtime);
      execute(conversation, next, runtime).finally(() => {
        running.delete(lane.id);
        guard(() => onLaneClosed?.(lane, next.turn));
        pump(conversation);
      });
    }
    if (!queue.length) queues.delete(key);
  }

  async function execute(conversation, { turn, payload }, runtime) {
    const { lane, controller } = runtime;
    const save = () => { runtime.timer ||= setTimeout(() => { runtime.timer = null; persist(conversation).catch(onError); }, saveDelay); };
    const activity = event => { const item = foldActivity(turn.activities, event, { max: maxActivities, describe: describeActivity }); if (item) save(); return item; };
    let result, failure;
    Object.assign(turn, { status: 'running', startedAt: now(), lane: lane.name });
    try {
      await persist(conversation);
      result = await run(turn, lane, controller.signal, { payload, conversation, activity, save });
      if (controller.signal.aborted) throw new Error(words.stopped);
      const { id, status, activities, ...fields } = result && typeof result === 'object' ? result : {};
      Object.assign(turn, fields, { status: 'succeeded', message: typeof fields.message === 'string' ? fields.message : '' });
    } catch (error) {
      failure = error;
      const stopped = controller.signal.aborted;
      turn.status = stopped ? 'stopped' : 'failed';
      turn.message = stopped ? words.stopped : guard(() => describeFailure(error, turn)) || 'The request could not be completed.';
    }
    runtime.done = true;
    clearTimeout(runtime.timer); runtime.timer = null;
    settleActivity(turn.activities, turn.status === 'succeeded');
    turn.finishedAt = now();
    await persist(conversation).catch(onError);
    if (onCall) guard(() => onCall({ key: conversation.key, lane: lane.id, turnId: turn.id, status: turn.status,
      startedAt: turn.startedAt, finishedAt: turn.finishedAt, durationMs: Date.parse(turn.finishedAt) - Date.parse(turn.startedAt),
      provenance: turn.provenance, usage: turn.usage, ...(turn.status === 'failed' ? { error: String(failure?.message || failure).slice(0, 300) } : {}) }));
  }

  /** The turn with that id, or a ConversationError with code 'not-found'. */
  async function turn(key, id) {
    const found = (await open(key)).turns.find(t => t.id === id);
    if (!found) throw new ConversationError(words.unknownTurn, 'not-found');
    return found;
  }

  /** Stops one request: a waiting one is removed, a running one has its signal aborted. Returns the turn. */
  async function stop(key, id) {
    const conversation = await open(key), found = await turn(key, id);
    if (found.status === 'queued') {
      const queue = queues.get(key) || [], at = queue.findIndex(q => q.turn === found);
      if (at >= 0) queue.splice(at, 1);
      Object.assign(found, { status: 'stopped', message: words.removed, finishedAt: now() });
      await persist(conversation);
    } else if (found.status === 'running') lanesOf(key).find(r => r.turn === found)?.controller.abort();
    return found;
  }

  /** Stops every request of a conversation, waiting and running. */
  async function stopAll(key) {
    const conversation = await open(key);
    for (const t of conversation.turns.filter(t => t.status === 'queued' || t.status === 'running')) await stop(key, t.id);
  }

  /**
   * Starts the conversation afresh. The old turns are copied to `archive/` first.
   * Refused with code 'busy' while anything is running or waiting.
   */
  async function reset(key) {
    const conversation = await open(key);
    if (busy(key)) throw new ConversationError(words.busy, 'busy');
    if (conversation.turns.length) {
      const archive = path.join(dir, 'archive'); await mkdir(archive, { recursive: true, mode: 0o700 });
      await writeFile(path.join(archive, `${now().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}.json`), JSON.stringify(conversation, null, 2), { mode: 0o600 });
    }
    conversation.turns = [];
    await persist(conversation);
    return conversation;
  }

  const busy = key => lanesOf(key).length > 0 || (queues.get(key)?.length || 0) > 0;

  return {
    open, send, turn, stop, stopAll, reset, busy,
    /** The loaded conversation for a key, or undefined before open(). */
    get: key => conversations.get(key),
    /** What is running in a lane, by lane id: { turn, lane } or undefined. For a host's agent command route. */
    running: laneId => { const r = running.get(laneId); return r && !r.done ? { turn: r.turn, lane: r.lane } : undefined; },
    /** The lanes at work on a conversation. */
    lanes: key => lanesOf(key).map(r => ({ turn: r.turn, lane: r.lane })),
    /** Schedules nothing, writes now. For a host that changed a conversation outside a run. */
    save: async key => persist(await open(key)),
    /** Resolves when every write so far has reached the disk. */
    flush: () => writes,
    /** Aborts everything running, drops what is waiting, and waits for the last write. */
    async close() {
      for (const [key, queue] of queues) { for (const { turn: t } of queue) Object.assign(t, { status: 'stopped', message: words.removed, finishedAt: now() }); queues.delete(key); }
      const active = [...running.values()];
      for (const r of active) r.controller.abort();
      const until = Date.now() + 2000;
      while (running.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      for (const conversation of conversations.values()) await persist(conversation).catch(onError);
      await writes;
    },
  };
}
