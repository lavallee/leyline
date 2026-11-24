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
import { mkdir, open as openFile, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
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
  unreadable: 'This conversation could not be read just now. Nothing was changed; try again.',
  closed: 'This server is shutting down. Send the request again in a moment.',
};

/**
 * An error the store raises on purpose. `code`: 'full' | 'busy' | 'not-found' | 'invalid' |
 * 'unreadable' (a conversation file exists but could not be read; nothing was changed) |
 * 'closed' (send() after close()) |
 * 'corrupt' (only ever passed to onError: a file was not a conversation and was moved
 * aside to `error.file`).
 */
export class ConversationError extends Error {
  constructor(message, code, status) { super(message); this.name = 'ConversationError'; this.code = code; this.status = status ?? { full: 409, busy: 409, 'not-found': 404, unreadable: 500, corrupt: 500, closed: 503 }[code] ?? 400; }
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
 * @param {object} [options.messages] wording overrides; see MESSAGES in this file. `interrupted`,
 *   `removed` and `stopped` may each be a function of the turn, for a host whose wording
 *   depends on the kind of request (what a stopped request leaves behind, say).
 * @param {(error: Error, turn: object) => string} [options.describeFailure] the message stored on a failed turn
 * @param {(event: object, item: object) => object|void} [options.describeActivity] rewords an activity before it is stored
 * @param {(lane: object, turn: object) => void} [options.onLaneClosed] after a lane finishes: the place to reset a side lane's agent
 * @param {(record: object) => void} [options.onCall] one record per finished turn; see ./telemetry.mjs
 * @param {(error: Error) => void} [options.onError] problems that have nowhere else to go (a failed write, a throwing hook,
 *   a file that was not a conversation and has been moved aside)
 * @param {boolean} [options.fsync] flush each file to the disk before it replaces the old one, and the folder
 *   after. Slower; survives a power cut. Default false: a write survives the process dying, not the machine.
 * @param {number} [options.stopGrace] milliseconds a stopped run is given to settle before its turn is recorded
 *   as stopped anyway and its lane freed; what the run returns later is dropped. Default: wait for the run.
 * @param {number} [options.evictAfter] milliseconds after which a conversation nobody has used, with nothing
 *   running, waiting or unwritten, is dropped from memory (it is read again on the next open()). Default: never.
 *   A host that holds on to conversation objects must not set it: after an eviction open() gives a new object.
 */
export function createConversationStore({ dir, run, maxLanes = 4, maxTurns = 200, maxActivities = 200, saveDelay = 600, messages = {},
  describeFailure = error => String(error?.message || error).slice(0, 300), describeActivity, onLaneClosed, onCall, onError: report = () => {},
  fsync = false, stopGrace = Infinity, evictAfter = Infinity } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('Give the store a directory.');
  if (typeof run !== 'function') throw new TypeError('Give the store a run(turn, lane, signal, tools) function.');
  const words = { ...MESSAGES, ...messages };
  // The wording for something that happened to a turn: a string, or a function of the turn.
  const say = (name, turn) => { const word = words[name]; return typeof word === 'function' ? guard(() => word(turn)) || MESSAGES[name] : word; };
  const conversations = new Map();  // key -> conversation
  const loading = new Map();        // key -> Promise<conversation>
  const queues = new Map();         // key -> [{ turn, payload }]
  const running = new Map();        // lane id -> { turn, lane, controller, timer }
  const files = new Map();          // key -> { writing: Promise|null, queued: { promise, resolve, reject }|null }
  const sending = new Map();        // key -> requests accepted but not yet written
  const arriving = new Map();       // turn -> the promise of the send() that is writing it
  const resets = new Map();         // key -> the reset in progress
  const used = new Map();           // key -> when it was last touched, for eviction
  const inFlight = new Set();       // every write not yet settled
  let folder = null, serial = 0, sweeper = null, closed = false, sealed = false;
  const now = () => new Date().toISOString();
  // A host's own error handler must not be able to break the store either.
  const onError = error => { try { report(error); } catch { /* nothing more to do */ } };
  const guard = fn => { try { return fn(); } catch (error) { onError(error); } };
  const count = (map, key, by) => { const n = (map.get(key) || 0) + by; if (n > 0) map.set(key, n); else map.delete(key); };
  const touch = key => { if (Number.isFinite(evictAfter)) used.set(key, Date.now()); };

  const check = key => { if (typeof key !== 'string' || !key || key.includes('\0')) throw new ConversationError('Invalid conversation key.', 'invalid'); return key; };
  // A lane is at work until its turn has its final status. The last write and the hooks
  // that follow do not keep a conversation busy.
  const lanesOf = key => [...running.values()].filter(r => r.lane.key === key && !r.done);

  // The folder is made once. Temporary files a dead process left behind are cleared then
  // (only ones old enough that no living writer can still be using them).
  const ready = () => folder ||= (async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const name of await readdir(dir).catch(() => [])) {
      if (!name.endsWith('.tmp')) continue;
      const file = path.join(dir, name), info = await stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 60000) await rm(file, { force: true }).catch(() => {});
    }
  })().catch(error => { folder = null; throw error; });

  // One file, written whole: to a temporary file of its own (so two writers can never share
  // one, and its mode is always 0600), then renamed over the real one.
  async function write(file, bytes, again = true) {
    await ready();
    const temporary = `${file}.${process.pid}-${(++serial).toString(36)}.tmp`;
    try {
      const handle = await openFile(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); if (fsync) await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      // The folder was removed under us: make it again, once.
      if (error?.code === 'ENOENT' && again) { folder = null; return write(file, bytes, false); }
      throw error;
    }
    if (fsync) { const handle = await openFile(path.dirname(file), 'r').catch(() => null); if (handle) try { await handle.sync(); } catch { /* not every file system allows it */ } finally { await handle.close(); } }
  }

  // Writes a conversation. Each conversation has its own queue, so a large one does not
  // hold up the others, and at most one write waits behind the one in progress: every
  // caller that arrives meanwhile shares it, and it writes the conversation as it is when
  // it starts. The promise resolves once the state at the time of the call is on disk.
  function persist(conversation) {
    const key = conversation.key;
    // After close() has written everything, this store writes nothing more: the folder may
    // belong to another store by then, and a late write would put old state over its work.
    if (sealed) return Promise.reject(new ConversationError(words.closed, 'closed'));
    let state = files.get(key);
    if (!state) files.set(key, state = { writing: null, queued: null });
    if (state.queued) return state.queued.promise;
    touch(key);
    const queued = state.queued = {};
    queued.promise = new Promise((resolve, reject) => { queued.resolve = resolve; queued.reject = reject; });
    queued.promise.catch(() => {});
    inFlight.add(queued.promise);
    const start = () => {
      state.queued = null;
      let work;
      try { work = write(path.join(dir, fileNameFor(key)), JSON.stringify(conversation, null, 2)); } catch (error) { work = Promise.reject(error); }
      const finished = state.writing = work.then(queued.resolve, queued.reject).then(() => {
        inFlight.delete(queued.promise);
        if (state.writing === finished) state.writing = null;
      });
    };
    if (state.writing) state.writing.then(start); else start();
    return queued.promise;
  }
  const unwritten = key => { const state = files.get(key); return !!state && (!!state.writing || !!state.queued); };

  /** Loads a conversation, or starts an empty one. Turns an earlier process left unfinished are marked failed. */
  function open(key) {
    try { check(key); } catch (error) { return Promise.reject(error); }
    touch(key);
    if (conversations.has(key)) return Promise.resolve(conversations.get(key));
    if (!loading.has(key)) loading.set(key, (async () => {
      try {
        const file = path.join(dir, fileNameFor(key));
        let stored = { key, turns: [] }, recovered = false, text;
        // Only a file that is not there means "none yet". Any other failure to read it is
        // reported and nothing is assumed, or the next write would replace a file that may be whole.
        try { text = await readFile(file, 'utf8'); }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw Object.assign(new ConversationError(words.unreadable, 'unreadable'), { cause: error }); }
        if (text !== undefined) {
          let read = null, problem = null;
          try { read = JSON.parse(text); } catch { problem = 'corrupt'; }
          if (!problem && !(read && typeof read === 'object' && Array.isArray(read.turns))) problem = 'corrupt';
          if (!problem && read.key !== undefined && read.key !== key) problem = 'foreign';
          if (problem) {
            // Not this conversation, or not a conversation at all. It is kept under another
            // name for a person to look at, and the conversation starts empty.
            const aside = `${file}.${problem}-${now().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
            try { await rename(file, aside); }
            catch (error) { throw Object.assign(new ConversationError(words.unreadable, 'unreadable'), { cause: error }); }
            onError(Object.assign(new ConversationError(problem === 'foreign' ? `A conversation file held another conversation and was moved aside to ${aside}.`
              : `A conversation file could not be read as a conversation and was moved aside to ${aside}.`, 'corrupt'), { key, file: aside }));
          } else stored = { ...read, key, turns: read.turns.filter(turn => turn && typeof turn === 'object' && !Array.isArray(turn)) };
        }
        for (const turn of stored.turns) if (turn.status === 'running' || turn.status === 'queued') {
          Object.assign(turn, { status: 'failed', message: say('interrupted', turn), finishedAt: turn.finishedAt || now() });
          if (!Array.isArray(turn.activities)) turn.activities = [];
          settleActivity(turn.activities, false); recovered = true;
        }
        conversations.set(key, stored);
        if (recovered) await persist(stored).catch(onError);
        return stored;
      } finally { loading.delete(key); }
    })());
    return loading.get(key);
  }

  /**
   * Adds a request to a conversation and starts it when a lane is free.
   * @param {string} key
   * @param {object} request `user` is the text shown for the request. `payload` is handed to
   *   run() and not stored. `requestId`, when given, makes the send safe to repeat: a second
   *   send with the same id returns the turn the first one made (it is stored on the turn,
   *   so this holds across a restart). Every other field is stored on the turn as given.
   * @returns {Promise<object>} the turn, already written to disk
   */
  async function send(key, { user, payload, ...fields } = {}) {
    const conversation = await open(key);
    while (resets.has(key)) await resets.get(key).catch(() => {});
    // A closed store takes nothing more: another store may own the folder by now.
    if (closed) throw new ConversationError(words.closed, 'closed');
    if (typeof user !== 'string') throw new ConversationError('A request needs its text (user).', 'invalid');
    if (fields.requestId !== undefined) {
      if (typeof fields.requestId !== 'string' || !fields.requestId || fields.requestId.length > 200) throw new ConversationError('A request id is a short string.', 'invalid');
      const made = conversation.turns.find(turn => turn.requestId === fields.requestId);
      if (made) { await arriving.get(made); return made; }
    }
    if (conversation.turns.length >= maxTurns) throw new ConversationError(words.full, 'full');
    for (const name of [...RESERVED, '__proto__']) delete fields[name];
    const at = now();
    const turn = { id: randomUUID(), user, status: 'queued', createdAt: at, startedAt: at, message: '', ...fields, activities: [] };
    conversation.turns.push(turn);
    // Until it is written the request counts as work in the conversation (so a reset is
    // refused), but it is not in the queue: a stop that arrives now simply marks it.
    count(sending, key, 1);
    const written = persist(conversation).then(() => {
      if (turn.status !== 'queued' || !conversation.turns.includes(turn)) return;   // stopped, or the store closed, meanwhile
      const queue = queues.get(key) || []; queues.set(key, queue);
      queue.push({ turn, payload });
    }, error => { const index = conversation.turns.indexOf(turn); if (index >= 0) conversation.turns.splice(index, 1); throw error; })
      .finally(() => { count(sending, key, -1); arriving.delete(turn); });
    arriving.set(turn, written.catch(() => {}));
    await written;
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
      const runtime = { turn: next.turn, lane, controller: new AbortController(), timer: null, grace: null };
      running.set(lane.id, runtime);
      execute(conversation, next, runtime).catch(onError).finally(() => {
        // The main lane may already have been taken again by the next turn: only this turn's own entry goes.
        if (running.get(lane.id) === runtime) running.delete(lane.id);
        guard(() => onLaneClosed?.(lane, next.turn));
        pump(conversation);
      });
    }
    if (!queue.length) queues.delete(key);
  }

  async function execute(conversation, { turn, payload }, runtime) {
    const { lane, controller } = runtime;
    // Once the turn has its final status nothing more is recorded on it, whatever a run that outlived it does.
    const save = () => { if (runtime.done) return; runtime.timer ||= setTimeout(() => { runtime.timer = null; persist(conversation).catch(onError); }, saveDelay); };
    const activity = event => { if (runtime.done) return null; const item = foldActivity(turn.activities, event, { max: maxActivities, describe: describeActivity }); if (item) save(); return item; };
    let result, failure;
    Object.assign(turn, { status: 'running', startedAt: now(), lane: lane.name });
    try {
      await persist(conversation);
      if (controller.signal.aborted) throw new Error(MESSAGES.stopped);   // stopped before it began: the host's run is never called
      const work = Promise.resolve().then(() => run(turn, lane, controller.signal, { payload, conversation, activity, save }));
      work.catch(() => {});
      result = await Promise.race([work, new Promise((_, reject) => { runtime.abandon = () => reject(new Error(MESSAGES.stopped)); })]);
      if (controller.signal.aborted) throw new Error(MESSAGES.stopped);
      const { id, status, activities, ...fields } = result && typeof result === 'object' ? result : {};
      delete fields.__proto__;
      Object.assign(turn, fields, { status: 'succeeded', message: typeof fields.message === 'string' ? fields.message : '' });
    } catch (error) {
      failure = error;
      const stopped = controller.signal.aborted;
      turn.status = stopped ? 'stopped' : 'failed';
      turn.message = stopped ? say('stopped', turn) : guard(() => describeFailure(error, turn)) || 'The request could not be completed.';
    }
    runtime.done = true;
    clearTimeout(runtime.timer); runtime.timer = null;
    clearTimeout(runtime.grace); runtime.grace = null;
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
      Object.assign(found, { status: 'stopped', message: say('removed', found), finishedAt: now() });
      await persist(conversation);
    } else if (found.status === 'running') {
      const runtime = lanesOf(key).find(r => r.turn === found);
      runtime?.controller.abort();
      // A run that ignores its signal is not waited for beyond stopGrace.
      if (runtime && Number.isFinite(stopGrace) && !runtime.grace) { runtime.grace = setTimeout(() => runtime.abandon?.(), Math.max(0, stopGrace)); runtime.grace.unref?.(); }
    }
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
    while (resets.has(key)) await resets.get(key).catch(() => {});
    if (busy(key)) throw new ConversationError(words.busy, 'busy');
    if (closed) throw new ConversationError(words.closed, 'closed');
    // From here until the empty conversation is written, requests for this key wait: none
    // can slip into the turns being archived, or run outside the conversation that replaces them.
    const work = (async () => {
      if (conversation.turns.length) {
        const archive = path.join(dir, 'archive'); await mkdir(archive, { recursive: true, mode: 0o700 });
        await write(path.join(archive, `${now().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}.json`), JSON.stringify(conversation, null, 2));
      }
      conversation.turns = [];
      await persist(conversation);
      return conversation;
    })();
    resets.set(key, work);
    try { return await work; } finally { if (resets.get(key) === work) resets.delete(key); }
  }

  const busy = key => lanesOf(key).length > 0 || (queues.get(key)?.length || 0) > 0 || sending.has(key);

  /** Drops an idle conversation from memory; open() reads it again. False, and nothing happens, while it has work or unwritten changes. */
  function unload(key) {
    if (!conversations.has(key) || busy(key) || unwritten(key) || resets.has(key) || loading.has(key)) return false;
    conversations.delete(key); files.delete(key); used.delete(key);
    return true;
  }
  if (Number.isFinite(evictAfter) && evictAfter > 0) {
    sweeper = setInterval(() => { const before = Date.now() - evictAfter; for (const [key, at] of used) if (at <= before) { if (conversations.has(key)) unload(key); else used.delete(key); } }, Math.max(10, Math.min(evictAfter / 2, 60000)));
    sweeper.unref?.();
  }

  return {
    open, send, turn, stop, stopAll, reset, busy, unload,
    /** The keys of the conversations in memory. */
    loaded: () => [...conversations.keys()],
    /** The loaded conversation for a key, or undefined before open(). */
    get: key => conversations.get(key),
    /** What is running in a lane, by lane id: { turn, lane } or undefined. For a host's agent command route. */
    running: laneId => { const r = running.get(laneId); return r && !r.done ? { turn: r.turn, lane: r.lane } : undefined; },
    /** The lanes at work on a conversation. */
    lanes: key => lanesOf(key).map(r => ({ turn: r.turn, lane: r.lane })),
    /** Schedules nothing, writes now. For a host that changed a conversation outside a run. */
    save: async key => persist(await open(key)),
    /** Resolves when every write so far has reached the disk. */
    flush: async () => { while (inFlight.size) await Promise.allSettled([...inFlight]); },
    /** Aborts everything running, drops what is waiting, and waits for the last write. Afterwards send() is refused with code 'closed'. */
    async close() {
      closed = true;
      clearInterval(sweeper); sweeper = null;
      queues.clear();
      // Everything still waiting, in a queue or on its way into one, is removed.
      for (const conversation of conversations.values()) for (const t of conversation.turns) if (t.status === 'queued') Object.assign(t, { status: 'stopped', message: say('removed', t), finishedAt: now() });
      const active = [...running.values()];
      for (const r of active) r.controller.abort();
      const until = Date.now() + 2000;
      while (running.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      for (const conversation of conversations.values()) await persist(conversation).catch(onError);
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      sealed = true;
    },
  };
}
