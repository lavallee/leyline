// The turn store behind a chat panel: conversations keyed by a host string, each a list
// of turns. It queues requests, runs them side by side in lanes up to a cap, records
// activity as it arrives, and survives a restart. Generalised from the stores Copycat and
// Skein each wrote (their src/chat.js).
//
// On disk a conversation is two private files:
//   <name>.json            a snapshot: { key, ...fields, turns, eventSeq }, written whole
//   <name>.events.jsonl    a log: a header line, then one JSON line per event since the snapshot
// Every change to a conversation is an event with a sequence number (./events.mjs). An
// update appends lines to the log; now and then the log is folded into a new snapshot
// (compaction). A reader takes the snapshot and replays the events numbered after it. A
// `<name>.json` file written by an earlier version (no log, no eventSeq) is read as it is
// and gets a log when it next changes.
//
// The store finds out what changed by comparing each turn with what it last recorded, so
// a host may change a turn directly: during a run and then call tools.save(), or
// afterwards and then call store.save(key), or, cheapest, through store.update().
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
import { appendFile, mkdir, open as openFile, readFile, readdir, rename, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { createHash, hash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { chosenOption, foldActivity, settleActivity } from './providers/contract.mjs';
import { applyEvent, formatCursor, parseCursor } from './events.mjs';

export const TURN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'stopped'];
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const RESERVED = ['id', 'status', 'createdAt', 'startedAt', 'finishedAt', 'activities'];
const FINAL = ['succeeded', 'failed', 'stopped'];
const LOG_VERSION = 1;
const MAX_PREVIEW = 200000;

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
 * 'closed' (send() after close()) | 'answered' (answer() for a question that is no longer waiting) |
 * 'corrupt' (only ever passed to onError: a file was not a conversation and was moved
 * aside to `error.file`).
 */
export class ConversationError extends Error {
  constructor(message, code, status) { super(message); this.name = 'ConversationError'; this.code = code; this.status = status ?? { full: 409, busy: 409, 'not-found': 404, unreadable: 500, corrupt: 500, closed: 503 }[code] ?? 400; }
}

/** The file name a key is stored under: the key itself when it is plainly safe, a hash of it otherwise. */
export const fileNameFor = key => `${SAFE_KEY.test(key) ? key : createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`;
/** The file name of a key's event log, beside its snapshot. */
export const logNameFor = key => fileNameFor(key).replace(/\.json$/, '.events.jsonl');

// ---------------------------------------------------------------- what changed in a turn
// A shadow is what the store last recorded of a turn: enough to tell what has changed
// since, without keeping a second copy. Strings are kept by reference (they cannot change
// underneath us), everything else as its JSON, or a digest of it when that is long.
const mark = json => json.length <= 1024 ? json : `#${hash('sha1', json, 'base64')}`;
const newShadow = () => ({ strings: new Map(), marks: new Map(), items: null, order: null, waiting: null });
// Activity items the store can follow one by one: objects with an id of their own.
function followable(items) {
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || (typeof item.id !== 'string' && typeof item.id !== 'number')) return false;
    if (item.text !== undefined && typeof item.text !== 'string') return false;
    if (ids.has(item.id)) return false;
    ids.add(item.id);
  }
  return true;
}
// What changed in one activity item since it was recorded, or null; the record is brought up to date.
function itemDelta(shadow, item, added) {
  const { text, ...rest } = item, fields = JSON.stringify(rest), had = shadow.items.get(rest.id);
  let delta = null;
  if (!had) { shadow.order.push(rest.id); delta = { id: rest.id, fields: rest, text: text ?? null }; }
  else {
    if (had.fields !== fields) delta = { id: rest.id, fields: rest };
    if (had.text !== text) {
      delta ||= { id: rest.id };
      // `added` is what the caller knows it put on the end; the lengths say whether that is all that happened.
      const more = typeof text !== 'string' ? null : added && typeof had.text === 'string' && text.length === had.text.length + added.length ? added : textDelta(had.text, text);
      if (more !== null) delta.append = more; else delta.text = text ?? null;
    }
  }
  if (delta) shadow.items.set(rest.id, { fields, text });
  return delta;
}
// Two changes to one item, as one.
function mergeDelta(first, next) {
  if (next.fields) first.fields = next.fields;
  if ('text' in next) { first.text = next.text; delete first.append; }
  else if (next.append) { if (typeof first.text === 'string') first.text += next.append; else if ('text' in first) first.text = next.append; else first.append = (first.append || '') + next.append; }
  return first;
}
// What was added, when a text is the old one with more at the end. (A slice and a comparison: startsWith walks character by character.)
const textDelta = (old, text) => old !== undefined && old.length >= 16 && text.length > old.length && text.slice(0, old.length) === old ? text.slice(old.length) : null;

/**
 * Compares a turn (or any object) with its shadow, brings the shadow up to date, and
 * returns what changed as the body of an event ({ set?, unset?, append?, activities? }),
 * or null when nothing did. `skip` names fields that are not compared.
 */
function difference(target, shadow, skip = NONE) {
  let set, unset, append, activities;
  const seen = new Set();
  for (const name of Object.keys(target)) {
    const value = target[name];
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || skip.has(name)) continue;
    seen.add(name);
    if (typeof value === 'string') {
      const old = shadow.strings.get(name);
      if (old === value) continue;
      const more = textDelta(old, value);
      if (more !== null) (append ||= {})[name] = more; else (set ||= {})[name] = value;
      shadow.strings.set(name, value); shadow.marks.delete(name);
      if (name === 'activities') shadow.items = null;
      continue;
    }
    if (name === 'activities' && Array.isArray(value) && followable(value)) {
      shadow.strings.delete(name); shadow.marks.delete(name);
      let whole = !shadow.items;
      if (!whole) { const order = shadow.order; whole = value.length < order.length; for (let i = 0; !whole && i < order.length; i++) whole = value[i].id !== order[i]; }
      if (whole) { shadow.items = new Map(); shadow.order = []; }
      const deltas = [];
      for (let i = 0; i < value.length; i++) { const delta = itemDelta(shadow, value[i]); if (delta) deltas.push(delta); }
      if (whole) (set ||= {})[name] = value; else if (deltas.length) activities = deltas;
      continue;
    }
    let json;
    try { json = JSON.stringify(value); } catch { json = undefined; }
    if (json === undefined) { seen.delete(name); continue; }   // nothing JSON can hold: as if it were not there
    const now = mark(json);
    if (name === 'activities') shadow.items = null;
    if (shadow.marks.get(name) === now && !shadow.strings.has(name)) continue;
    (set ||= {})[name] = value;
    shadow.marks.set(name, now); shadow.strings.delete(name);
  }
  for (const map of [shadow.strings, shadow.marks]) for (const name of [...map.keys()]) if (!seen.has(name)) { (unset ||= []).push(name); map.delete(name); }
  if (shadow.items && !seen.has('activities')) { (unset ||= []).push('activities'); shadow.items = null; shadow.order = null; }
  return set || unset || append || activities ? { ...(set ? { set } : {}), ...(unset ? { unset } : {}), ...(append ? { append } : {}), ...(activities ? { activities } : {}) } : null;
}
const NONE = new Set(), NOT_FIELDS = new Set(['key', 'turns', 'eventSeq']);

// The name an event gets, from what it changes. Consumers may ignore it: see ./events.mjs.
function kindOf(change) {
  if (change.set?.status) return FINAL.includes(change.set.status) ? 'turn.finished' : 'turn.status';
  const names = [...Object.keys(change.set || {}), ...(change.unset || []), ...Object.keys(change.append || {})];
  if (!names.length) return 'turn.activity';
  if (change.activities || names.length !== 1) return 'turn.patch';
  return { preview: 'turn.text', asks: 'turn.ask', steers: 'turn.steer', proposals: 'turn.proposals' }[names[0]] || 'turn.patch';
}

// ---------------------------------------------------------------- reading what is on disk
const absent = error => ['ENOENT', 'ENOTDIR'].includes(error?.code);

// A log as it was read: the events numbered after `base`, how many bytes of the file are
// whole lines, and what is wrong with it, if anything. A last line with no line ending is
// a write a dying process did not finish; it is not an error, and is left out.
function readLog(bytes, key, base) {
  const end = bytes.lastIndexOf(10) + 1, events = [];
  const result = { events, good: end, torn: end < bytes.length, lines: 0, problem: null, header: false };
  let expected = base + 1, first = true;
  for (const line of bytes.subarray(0, end).toString('utf8').split('\n')) {
    if (!line) continue;
    let value; try { value = JSON.parse(line); } catch { value = null; }
    if (first) {
      first = false;
      if (!value || typeof value !== 'object' || value.log !== LOG_VERSION) { result.problem = 'corrupt'; return result; }
      if (value.key !== key) { result.problem = 'foreign'; return result; }
      // A log that starts after the snapshot ends belongs to a snapshot that is no longer there.
      if (!Number.isSafeInteger(value.base) || value.base > base) { result.problem = 'corrupt'; return result; }
      result.header = true;
      continue;
    }
    result.lines++;
    if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.seq)) { result.problem = 'corrupt'; return result; }
    if (value.seq <= base) continue;           // already in the snapshot: a crash between writing it and starting the new log
    if (value.seq !== expected) { result.problem = 'corrupt'; return result; }
    events.push(value); expected++;
  }
  return result;
}

/**
 * Reads a conversation from a store's folder without a store: the snapshot with its log
 * replayed. For tools and tests that look at the files as a stranger would. Changes
 * nothing on disk. Resolves to the conversation ({ key, turns, ...fields }) or null when
 * there is none; rejects when a file cannot be read or is not a conversation.
 */
export async function readConversation(dir, key) {
  let conversation = null, base = 0;
  const text = await readFile(path.join(dir, fileNameFor(key)), 'utf8').catch(error => { if (absent(error)) return undefined; throw error; });
  if (text !== undefined) {
    const read = JSON.parse(text);
    if (!read || typeof read !== 'object' || !Array.isArray(read.turns)) throw new ConversationError('That file is not a conversation.', 'corrupt');
    base = Number.isSafeInteger(read.eventSeq) ? read.eventSeq : 0;
    conversation = { ...read, key }; delete conversation.eventSeq;
  }
  const bytes = await readFile(path.join(dir, logNameFor(key))).catch(error => { if (absent(error)) return null; throw error; });
  if (bytes) {
    const log = readLog(bytes, key, base);
    if (log.problem) throw new ConversationError(`That conversation's event log is ${log.problem === 'foreign' ? 'for another conversation' : 'damaged'}.`, 'corrupt');
    conversation ||= { key, turns: [] };
    for (const event of log.events) if (!applyEvent(conversation, event)) throw new ConversationError('That conversation\'s event log does not fit its snapshot.', 'corrupt');
  }
  return conversation;
}

/**
 * @param {object} options
 * @param {string} options.dir where conversations are kept; created private (0700), files 0600
 * @param {(turn: object, lane: object, signal: AbortSignal, tools: object) => Promise<object>} options.run
 *   lane: { id, name, main, key }.
 *   tools: { payload, conversation, activity(event), text(piece, { segment }), save() }. `payload` is
 *   whatever the host passed to send() and is never written to disk; `activity` folds a provider event
 *   into turn.activities; `text` adds a piece of the reply to turn.preview while it arrives (the field is
 *   removed when the turn finishes and `message` holds the reply); `save` records what the host changed
 *   on the turn itself; `ask(question, { timeout, signal })` puts a question for a person on the turn
 *   (turn.asks) and resolves with the answer: pass it to a provider as `onAsk`; `steering(fn)` tells the
 *   store how to send more input into this run (for a provider that can: `tools.steering(input =>
 *   provider.steer(lane.id, input))`), which is what store.steer() then calls.
 * @param {number} [options.maxLanes] requests running at once per conversation; default 4
 * @param {number} [options.maxTurns] default 200
 * @param {number} [options.maxActivities] per turn; default 200
 * @param {number} [options.saveDelay] milliseconds activity writes are batched for; default 600
 * @param {number} [options.coalesce] milliseconds a running turn's activity and text are gathered for before
 *   they become one event for subscribers (and one line of the log); default 50. Never longer than saveDelay.
 * @param {number} [options.coalesceChars] characters of new text after which the event is made at once; default 4000
 * @param {number} [options.compactEvery] events in a conversation's log after which it is folded into a new
 *   snapshot; default 1000
 * @param {number} [options.compactBytes] the same, by the log's size; default 1,000,000
 * @param {number} [options.keepEvents] recent events kept in memory per conversation, for subscribers that
 *   resume; default 2000. A subscriber that asks for something older is told there is a gap.
 * @param {number} [options.keepBytes] the same, by size; default 4,000,000
 * @param {(ask: object, turn: object) => any} [options.onAsk] the policy for questions an agent asks of a person
 *   (see "Asks" in ./providers/contract.mjs). It is called with each ask as it is recorded and may answer it at once
 *   by returning an answer, or a promise of one; returning nothing leaves the ask waiting for store.answer().
 *   Default: answer 'decline' at once, so a host that does nothing about asks never has a turn waiting on one.
 * @param {number} [options.askTimeout] milliseconds an ask waits for a person before it is answered 'decline' and
 *   marked expired; default 300000. A provider may give a shorter time for one ask.
 * @param {(input: string|string[], turn: object, lane: object) => Promise<any>} [options.steer] how to send more input into
 *   a running turn, for store.steer(): typically `(input, turn, lane) => provider.steer(lane.id, input)`. A run may
 *   instead say so itself with tools.steering(fn), which takes precedence for that run. Without either, store.steer()
 *   answers 'unsupported'.
 * @param {object} [options.messages] wording overrides; see MESSAGES in this file. `interrupted`,
 *   `removed` and `stopped` may each be a function of the turn, for a host whose wording
 *   depends on the kind of request (what a stopped request leaves behind, say).
 * @param {(error: Error, turn: object) => string} [options.describeFailure] the message stored on a failed turn
 * @param {(event: object, item: object) => object|void} [options.describeActivity] rewords an activity before it is stored
 * @param {(lane: object, turn: object) => void} [options.onLaneClosed] after a lane finishes: the place to reset a side lane's agent
 * @param {(record: object) => void} [options.onCall] one record per finished turn; see ./telemetry.mjs
 * @param {(error: Error) => void} [options.onError] problems that have nowhere else to go (a failed write, a throwing hook,
 *   a file that was not a conversation and has been moved aside)
 * @param {boolean} [options.fsync] flush each write to the disk (a snapshot before it replaces the old one, and the
 *   folder after; the log after each append). Slower; survives a power cut. Default false: a write survives the
 *   process dying, not the machine.
 * @param {number} [options.stopGrace] milliseconds a stopped run is given to settle before its turn is recorded
 *   as stopped anyway and its lane freed; what the run returns later is dropped. Default: wait for the run.
 * @param {number} [options.evictAfter] milliseconds after which a conversation nobody has used, with nothing
 *   running, waiting, unwritten or subscribed, is dropped from memory (it is read again on the next open()). Default: never.
 *   A host that holds on to conversation objects must not set it: after an eviction open() gives a new object.
 */
export function createConversationStore({ dir, run, maxLanes = 4, maxTurns = 200, maxActivities = 200, saveDelay = 600, messages = {},
  describeFailure = error => String(error?.message || error).slice(0, 300), describeActivity, onLaneClosed, onCall, onError: report = () => {},
  fsync = false, stopGrace = Infinity, evictAfter = Infinity, coalesce = 50, coalesceChars = 4000, compactEvery = 1000, compactBytes = 1_000_000,
  keepEvents = 2000, keepBytes = 4_000_000, onAsk = () => 'decline', askTimeout = 300000, steer: steerRun } = {}) {
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
  const logs = new Map();           // key -> the conversation's event log: see newLog()
  const sending = new Map();        // key -> requests accepted but not yet written
  const arriving = new Map();       // turn -> the promise of the send() that is writing it
  const resets = new Map();         // key -> the reset in progress
  const used = new Map();           // key -> when it was last touched, for eviction
  const inFlight = new Set();       // every write not yet settled
  let folder = null, serial = 0, sweeper = null, closed = false, sealed = false;
  const now = () => new Date().toISOString();
  const emitDelay = Math.max(0, Math.min(coalesce, saveDelay));
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
      if (fsync) {
        const handle = await openFile(temporary, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      } else await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });   // one call into the file system, which is markedly quicker than a handle
      await rename(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      // The folder was removed under us: make it again, once.
      if (error?.code === 'ENOENT' && again) { folder = null; return write(file, bytes, false); }
      throw error;
    }
    if (fsync) { const handle = await openFile(path.dirname(file), 'r').catch(() => null); if (handle) try { await handle.sync(); } catch { /* not every file system allows it */ } finally { await handle.close(); } }
  }

  // Lines added to the end of a log. A process that dies part-way leaves at worst one
  // unfinished last line, which the next reader leaves out.
  async function append(file, text) {
    await ready();
    if (!fsync) return appendFile(file, text, { mode: 0o600 });
    const handle = await openFile(file, 'a', 0o600);
    try { await handle.appendFile(text); await handle.sync(); } finally { await handle.close(); }
  }

  // ---------------------------------------------------------------- events
  // A conversation's log, in memory:
  //   seq       the number of the last event made
  //   epoch     a name for this loading of the conversation. Sequence numbers handed out
  //             before a restart may never have reached the disk, so a position is only
  //             good within the epoch it came from.
  //   pending   lines made but not yet appended to the file
  //   recent    the last events, for subscribers that resume; `floor` is the number before the oldest
  //   shadows   turn -> what was last recorded of it
  const newLog = (seq = 0) => ({ seq, base: seq, epoch: randomBytes(5).toString('hex'), pending: [], recent: [], recentBytes: 0, floor: seq,
    subscribers: new Set(), shadows: new Map(), fields: newShadow(), dirty: new Set(), snapshot: false, header: false, lines: 0, bytes: 0, compact: false });

  function emit(log, body) {
    const event = { seq: log.seq + 1, at: now(), ...body };
    let line;
    try { line = JSON.stringify(event); } catch (error) { onError(error); return null; }
    log.seq++;
    log.pending.push(line);
    const entry = { seq: event.seq, line, event: null };
    log.recent.push(entry); log.recentBytes += line.length;
    while (log.recent.length > keepEvents || (log.recentBytes > keepBytes && log.recent.length > 1)) { const gone = log.recent.shift(); log.recentBytes -= gone.line.length; log.floor = gone.seq; }
    for (const subscriber of log.subscribers) subscriber.deliver(entry);
    return entry;
  }

  // Activity the store folded in itself is recorded item by item as it arrives (the store
  // knows which item changed, so nothing else is compared) and waits here to go out as one event.
  function noteItem(log, turn, item, added) {
    const shadow = log.shadows.get(turn);
    if (!shadow?.items || !(shadow.items.has(item.id) || turn.activities[shadow.order.length] === item) || (item.text !== undefined && typeof item.text !== 'string')) return false;
    const delta = itemDelta(shadow, item, added);
    if (!delta) return true;
    const waiting = shadow.waiting ||= new Map(), first = waiting.get(delta.id);
    if (first) mergeDelta(first, delta); else waiting.set(delta.id, delta);
    return true;
  }
  function emitWaiting(log, turn, shadow) {
    const activities = [...shadow.waiting.values()];
    shadow.waiting = null;
    emit(log, { type: 'turn.activity', turnId: turn.id, activities });
  }

  // Records what has changed on one turn since it was last recorded.
  function syncTurn(log, turn) {
    log.dirty.delete(turn);
    let shadow = log.shadows.get(turn);
    if (shadow?.waiting) emitWaiting(log, turn, shadow);
    if (!shadow) {
      log.shadows.set(turn, shadow = newShadow());
      if (emit(log, { type: 'turn.created', turn })) difference(turn, shadow); else log.shadows.delete(turn);
      return;
    }
    const change = difference(turn, shadow);
    if (change) emit(log, { type: kindOf(change), turnId: turn.id, ...change });
  }
  // The conversation's own fields, and the turns a run or a command has touched.
  function sync(conversation, log) {
    const change = difference(conversation, log.fields, NOT_FIELDS);
    if (change) emit(log, { type: 'conversation.patch', ...change });
    for (const turn of [...log.dirty]) if (log.shadows.has(turn)) syncTurn(log, turn); else log.dirty.delete(turn);
  }
  // Every turn, whether or not anyone said it changed: for a host that changed turns directly.
  function syncAll(conversation, log) {
    const present = new Set(conversation.turns);
    for (const turn of [...log.shadows.keys()]) if (!present.has(turn)) { log.shadows.delete(turn); log.dirty.delete(turn); emit(log, { type: 'turn.removed', turnId: turn.id }); }
    for (const turn of conversation.turns) if (turn && typeof turn === 'object') syncTurn(log, turn);
    sync(conversation, log);
  }

  // Folds the log into a new snapshot. The snapshot is written first; a crash before the
  // log is replaced leaves events the snapshot already holds, which a reader skips.
  async function compactNow(conversation, log) {
    const key = conversation.key;
    syncAll(conversation, log);
    const base = log.seq, covered = log.pending;
    log.pending = []; log.compact = false;
    const snapshot = JSON.stringify({ ...conversation, eventSeq: base }, null, 2);
    try { await write(path.join(dir, fileNameFor(key)), snapshot); }
    catch (error) { log.pending = covered.concat(log.pending); log.compact = true; throw error; }
    log.snapshot = true; log.base = base;
    if (!log.header) return;                                   // no log file yet: the first append starts one
    const header = `${JSON.stringify({ log: LOG_VERSION, key, base })}\n`;
    try { await write(path.join(dir, logNameFor(key)), header); log.lines = 0; log.bytes = header.length; }
    catch (error) { onError(error); }                          // the old log stays; what it holds is in the snapshot
  }

  async function flushLog(conversation) {
    const key = conversation.key, log = logs.get(key);
    if (!log) return;
    sync(conversation, log);
    if (log.compact || !log.snapshot || log.lines + log.pending.length >= compactEvery || log.bytes >= compactBytes) {
      if (log.snapshot && !log.compact && !log.pending.length && !log.lines) return;
      return compactNow(conversation, log);
    }
    if (!log.pending.length) return;
    const lines = log.pending; log.pending = [];
    const text = `${log.header ? '' : `${JSON.stringify({ log: LOG_VERSION, key, base: log.base })}\n`}${lines.join('\n')}\n`;
    try { await append(path.join(dir, logNameFor(key)), text); }
    catch (error) {
      log.pending = lines.concat(log.pending);
      // The folder was removed under us: everything goes back in one piece.
      if (error?.code === 'ENOENT') { folder = null; log.header = false; return compactNow(conversation, log); }
      throw error;
    }
    log.header = true; log.lines += lines.length; log.bytes += text.length;
  }

  // Writes a conversation. Each conversation has its own queue, so a large one does not
  // hold up the others, and at most one write waits behind the one in progress: every
  // caller that arrives meanwhile shares it, and it writes what has been recorded by the
  // time it starts. The promise resolves once the state at the time of the call is on disk.
  // `all` compares every turn first, for a host that changed some without saying which.
  function persist(conversation, all = false) {
    const key = conversation.key;
    // After close() has written everything, this store writes nothing more: the folder may
    // belong to another store by then, and a late write would put old state over its work.
    if (sealed) return Promise.reject(new ConversationError(words.closed, 'closed'));
    const log = logs.get(key);
    if (log) { if (all) syncAll(conversation, log); else sync(conversation, log); }
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
      try { work = flushLog(conversation); } catch (error) { work = Promise.reject(error); }
      const finished = state.writing = work.then(queued.resolve, queued.reject).then(() => {
        inFlight.delete(queued.promise);
        if (state.writing === finished) state.writing = null;
      });
    };
    if (state.writing) state.writing.then(start); else start();
    return queued.promise;
  }
  const unwritten = key => { const state = files.get(key); return !!state && (!!state.writing || !!state.queued) || !!logs.get(key)?.pending.length; };

  // A file that is not what it should be is kept under another name for a person to look at.
  async function aside(file, problem, key, what) {
    const moved = `${file}.${problem}-${now().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`;
    try { await rename(file, moved); }
    catch (error) { throw Object.assign(new ConversationError(words.unreadable, 'unreadable'), { cause: error }); }
    onError(Object.assign(new ConversationError(problem === 'foreign' ? `${what} held another conversation and was moved aside to ${moved}.`
      : `${what} could not be read as a conversation and was moved aside to ${moved}.`, 'corrupt'), { key, file: moved }));
  }

  /** Loads a conversation, or starts an empty one. Turns an earlier process left unfinished are marked failed. */
  function open(key) {
    try { check(key); } catch (error) { return Promise.reject(error); }
    touch(key);
    if (conversations.has(key)) return Promise.resolve(conversations.get(key));
    if (!loading.has(key)) loading.set(key, (async () => {
      try {
        const file = path.join(dir, fileNameFor(key)), logFile = path.join(dir, logNameFor(key));
        const unreadable = error => Object.assign(new ConversationError(words.unreadable, 'unreadable'), { cause: error });
        let stored = { key, turns: [] }, recovered = false, text, base = 0, snapshot = false, repair = false;
        // Only a file that is not there means "none yet". Any other failure to read it is
        // reported and nothing is assumed, or the next write would replace a file that may be whole.
        try { text = await readFile(file, 'utf8'); }
        catch (error) { if (!absent(error)) throw unreadable(error); }
        if (text !== undefined) {
          let read = null, problem = null;
          try { read = JSON.parse(text); } catch { problem = 'corrupt'; }
          if (!problem && !(read && typeof read === 'object' && Array.isArray(read.turns))) problem = 'corrupt';
          if (!problem && read.key !== undefined && read.key !== key) problem = 'foreign';
          // Not this conversation, or not a conversation at all: the conversation starts empty.
          if (problem) await aside(file, problem, key, 'A conversation file');
          else {
            stored = { ...read, key, turns: read.turns.filter(turn => turn && typeof turn === 'object' && !Array.isArray(turn)) };
            base = Number.isSafeInteger(read.eventSeq) && read.eventSeq >= 0 ? read.eventSeq : 0; delete stored.eventSeq; snapshot = true;
          }
        }
        // The events since the snapshot.
        let bytes = null, seq = base, lines = 0, size = 0, header = false;
        try { bytes = await readFile(logFile); }
        catch (error) { if (!absent(error)) throw unreadable(error); }
        if (bytes) {
          const read = readLog(bytes, key, base);
          let problem = read.problem === 'foreign' ? 'foreign' : null;
          if (!problem) for (const event of read.events) { if (!applyEvent(stored, event)) { problem = 'corrupt'; break; } seq = event.seq; }
          problem ||= read.problem;
          if (problem) {
            // What could be replayed is kept, the file is put aside, and a snapshot of what was recovered replaces both.
            await aside(logFile, problem, key, 'A conversation\'s event log');
            repair = true;
          } else {
            // A last line a dying process did not finish is cut off, so the next line starts clean.
            if (read.torn) try { await truncate(logFile, read.good); } catch (error) { throw unreadable(error); }
            header = read.header; lines = read.lines; size = read.good;
          }
        }
        stored.turns = stored.turns.filter(turn => turn && typeof turn === 'object' && !Array.isArray(turn));
        const log = newLog(seq);
        Object.assign(log, { base, snapshot, header, lines, bytes: size, compact: repair });
        // What is on disk is the starting point for telling what changes from here on.
        difference(stored, log.fields, NOT_FIELDS);
        for (const turn of stored.turns) { const shadow = newShadow(); difference(turn, shadow); log.shadows.set(turn, shadow); }
        for (const turn of stored.turns) if (turn.status === 'running' || turn.status === 'queued') {
          Object.assign(turn, { status: 'failed', message: say('interrupted', turn), finishedAt: turn.finishedAt || now() });
          if (!Array.isArray(turn.activities)) turn.activities = [];
          settleActivity(turn.activities, false); delete turn.preview; recovered = true;
          if (Array.isArray(turn.asks)) for (const asked of turn.asks) if (asked?.status === 'pending') Object.assign(asked, { status: 'cancelled', answer: 'cancel', answeredAt: now() });
          syncTurn(log, turn);
        }
        logs.set(key, log);
        conversations.set(key, stored);
        if (recovered || repair) await persist(stored).catch(onError);
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
    const at = now(), log = logs.get(key);
    const turn = { id: randomUUID(), user, status: 'queued', createdAt: at, startedAt: at, message: '', ...fields, activities: [] };
    conversation.turns.push(turn);
    syncTurn(log, turn);
    // Until it is written the request counts as work in the conversation (so a reset is
    // refused), but it is not in the queue: a stop that arrives now simply marks it.
    count(sending, key, 1);
    const written = persist(conversation).then(() => {
      if (turn.status !== 'queued' || !conversation.turns.includes(turn)) return;   // stopped, or the store closed, meanwhile
      const queue = queues.get(key) || []; queues.set(key, queue);
      queue.push({ turn, payload });
    }, error => {
      const index = conversation.turns.indexOf(turn);
      if (index >= 0) { conversation.turns.splice(index, 1); if (log.shadows.delete(turn)) emit(log, { type: 'turn.removed', turnId: turn.id }); log.dirty.delete(turn); }
      throw error;
    }).finally(() => { count(sending, key, -1); arriving.delete(turn); });
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
      const runtime = { turn: next.turn, lane, controller: new AbortController(), timer: null, grace: null, soon: null, fresh: 0, asks: new Map(), steer: null };
      runtime.entered = new Promise(resolve => { runtime.enter = resolve; });
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
    const { lane, controller } = runtime, log = logs.get(conversation.key);
    // Once the turn has its final status nothing more is recorded on it, whatever a run that outlived it does.
    // What changed becomes an event for subscribers after `coalesce` (at once when a lot of
    // text has arrived), and reaches the disk after `saveDelay`.
    const soon = () => {
      runtime.soon = null; runtime.fresh = 0;
      if (runtime.done) return;
      const shadow = log.shadows.get(turn);
      if (runtime.changed) { runtime.changed = false; syncTurn(log, turn); } else if (shadow?.waiting) emitWaiting(log, turn, shadow);
    };
    // `changed`: the host altered the turn itself, so all of it is compared; otherwise only what the store folded in is sent.
    const save = (size = 0, changed = true) => {
      if (runtime.done) return;
      log.dirty.add(turn);
      if (changed) runtime.changed = true;
      runtime.fresh += size;
      if (runtime.fresh >= coalesceChars) { clearTimeout(runtime.soon); soon(); }
      else if (emitDelay < saveDelay) runtime.soon ||= setTimeout(soon, emitDelay);
      runtime.timer ||= setTimeout(() => { runtime.timer = null; runtime.fresh = 0; runtime.changed = false; persist(conversation).catch(onError); }, saveDelay);
    };
    const activity = event => {
      if (runtime.done) return null;
      const item = foldActivity(turn.activities, event, { max: maxActivities, describe: describeActivity });
      // Text the fold only added to the end is known without comparing; anything else that touched the text is compared.
      const added = typeof event?.append === 'string' && event.text === undefined && !event.output && !describeActivity ? event.append : null;
      if (item) save(typeof event?.append === 'string' ? event.append.length : 0, !noteItem(log, turn, item, added));
      return item;
    };
    // The reply as it arrives. A new segment (the agent began another message) starts the preview again.
    const text = (piece, { segment = 0 } = {}) => {
      if (runtime.done || typeof piece !== 'string' || !piece) return;
      if (segment !== runtime.segment) { runtime.segment = segment; turn.preview = ''; }
      turn.preview = `${turn.preview || ''}${piece}`.slice(-MAX_PREVIEW);
      save(piece.length);
    };
    // A question for a person. It is recorded on the turn, offered to the store's policy, and
    // otherwise waits for answer(), the time limit, or the end of the turn, whichever is first.
    const ask = (question, { timeout = askTimeout, signal: unwanted } = {}) => new Promise(resolve => {
      if (runtime.done || controller.signal.aborted || unwanted?.aborted) return resolve('cancel');
      const { id: given, kind, title, detail, options, questions, provider, method } = question && typeof question === 'object' ? question : {};
      if (!Array.isArray(turn.asks)) turn.asks = [];
      let id = typeof given === 'string' && given && given.length <= 100 ? given : `ask-${turn.asks.length + 1}`;
      while (turn.asks.some(a => a?.id === id)) id = `${id}-${turn.asks.length + 1}`;
      const entry = { id, kind: typeof kind === 'string' ? kind : 'other', title: typeof title === 'string' ? title.slice(0, 300) : '', ...(provider ? { provider: String(provider) } : {}), ...(method ? { method: String(method) } : {}),
        detail: detail && typeof detail === 'object' ? detail : {}, options: (Array.isArray(options) ? options : []).filter(o => o && typeof o.id === 'string').slice(0, 20),
        ...(Array.isArray(questions) ? { questions } : {}), status: 'pending', askedAt: now() };
      let timer = null;
      const settle = (answer, status) => {
        if (entry.status !== 'pending') return false;
        clearTimeout(timer); unwanted?.removeEventListener('abort', withdrawn); runtime.asks.delete(id);
        // What was chosen is kept; what was typed in reply (which may be a secret) is not.
        Object.assign(entry, { status, answer: chosenOption(answer), answeredAt: now() });
        if (!runtime.done) { runtime.changed = true; log.dirty.add(turn); syncTurn(log, turn); persist(conversation).catch(onError); }
        resolve(answer);
        return true;
      };
      const withdrawn = () => settle('cancel', 'cancelled');
      turn.asks.push(entry);
      runtime.asks.set(id, { entry, settle });
      unwanted?.addEventListener('abort', withdrawn, { once: true });
      syncTurn(log, turn); persist(conversation).catch(onError);
      Promise.resolve().then(() => onAsk(entry, turn)).then(answer => {
        if (answer !== undefined && answer !== null) return settle(answer, 'answered');
        if (entry.status === 'pending' && timeout > 0 && Number.isFinite(timeout)) { timer = setTimeout(() => settle('decline', 'expired'), Math.min(timeout, 2 ** 31 - 1)); timer.unref?.(); }
      }, error => { onError(error); settle('decline', 'answered'); });
    });
    controller.signal.addEventListener('abort', () => { for (const waiting of [...runtime.asks.values()]) waiting.settle('cancel', 'cancelled'); }, { once: true });
    let result, failure;
    Object.assign(turn, { status: 'running', startedAt: now(), lane: lane.name });
    syncTurn(log, turn);
    try {
      await persist(conversation);
      if (controller.signal.aborted) throw new Error(MESSAGES.stopped);   // stopped before it began: the host's run is never called
      // `entered` settles once run() has been called and has done whatever it does before its first wait
      // (which is where it says how it can be steered), or once it is known that it never will be.
      const work = Promise.resolve().then(() => { try { return run(turn, lane, controller.signal, { payload, conversation, activity, text, ask, steering: fn => { runtime.steer = typeof fn === 'function' ? fn : null; }, save: () => save() }); } finally { runtime.enter(); } });
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
    for (const waiting of [...runtime.asks.values()]) waiting.settle('cancel', 'cancelled');   // the turn ended with a question still open
    runtime.done = true; runtime.enter();
    clearTimeout(runtime.timer); runtime.timer = null;
    clearTimeout(runtime.soon); runtime.soon = null;
    clearTimeout(runtime.grace); runtime.grace = null;
    settleActivity(turn.activities, turn.status === 'succeeded');
    turn.finishedAt = now();
    delete turn.preview;
    syncTurn(log, turn);
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
      syncTurn(logs.get(key), found);
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
   * Changes one turn and records the change: the supported way to alter a turn outside its
   * run (the fate of a proposal on a finished turn, say). `change(turn)` alters the turn in
   * place and may be async. Only that turn is compared with what was recorded, so the cost
   * does not grow with the conversation. Resolves to the turn once the change is on disk.
   */
  async function update(key, id, change) {
    const conversation = await open(key), found = await turn(key, id);
    if (typeof change !== 'function') throw new ConversationError('Give update() a function that changes the turn.', 'invalid');
    await change(found);
    const log = logs.get(key);
    if (log?.shadows.has(found)) syncTurn(log, found);
    await persist(conversation);
    return found;
  }

  /**
   * Sends more input into a running turn, and records it on the turn (turn.steers:
   * [{ id, text, at }]) once the agent has taken it. Resolves to { steered, turn, reason? }:
   *   { steered: true }                      the agent took the input
   *   { steered: false, reason: 'ended' }    the turn has finished (perhaps a moment ago): send the input as a new request
   *   { steered: false, reason: 'waiting' }  the turn has not started yet
   *   { steered: false, reason: 'unsupported' }  nothing says how to steer this run (the store's `steer` option, or tools.steering)
   * Rejects when the provider fails for another reason, and with 'not-found' for an unknown turn.
   * @param {string|string[]} input text, or a list of texts sent as separate parts of one message
   */
  async function steer(key, id, input) {
    const conversation = await open(key), found = await turn(key, id);
    const parts = (Array.isArray(input) ? input : [input]).filter(part => typeof part === 'string' && part.length);
    if (!parts.length) throw new ConversationError('Give the steer its text.', 'invalid');
    if (found.status === 'queued') return { steered: false, reason: 'waiting', turn: found };
    const runtime = lanesOf(key).find(r => r.turn === found);
    if (!runtime || runtime.controller.signal.aborted) return { steered: false, reason: 'ended', turn: found };
    await runtime.entered;                                     // a turn marked running a moment ago may not have reached its run yet
    if (runtime.done || runtime.controller.signal.aborted) return { steered: false, reason: 'ended', turn: found };
    const send = runtime.steer || (steerRun && (given => steerRun(given, found, runtime.lane)));
    if (!send) return { steered: false, reason: 'unsupported', turn: found };
    try { await send(Array.isArray(input) ? parts : parts[0]); }
    catch (error) { if (error?.code === 'ended' || runtime.done) return { steered: false, reason: 'ended', turn: found }; throw error; }
    // The agent has it. If the turn finished in the same moment the steer still happened, and is still recorded.
    const log = logs.get(key);
    if (!Array.isArray(found.steers)) found.steers = [];
    found.steers.push({ id: randomUUID().slice(0, 8), text: parts.join('\n\n').slice(0, 20000), at: now() });
    if (log.shadows.has(found)) syncTurn(log, found);
    await persist(conversation);
    return { steered: true, turn: found };
  }

  /**
   * Answers a question that is waiting on a turn (turn.asks, status 'pending'). `decision` is
   * the id of one of the ask's options, or an object { option, answers?, content? }: see
   * "Asks" in ./providers/contract.mjs. Resolves to the turn. Rejects with code 'not-found'
   * when the turn has no such ask, and with code 'answered' (409) when it is no longer
   * waiting: it was answered, it expired, or the turn has ended.
   */
  async function answer(key, id, askId, decision) {
    const found = await turn(key, id);
    const runtime = lanesOf(key).find(r => r.turn === found), waiting = runtime?.asks.get(askId);
    if (!waiting) {
      if (!(found.asks || []).some(a => a?.id === askId)) throw new ConversationError('That question is not on this request.', 'not-found');
      throw new ConversationError('That question is no longer waiting for an answer.', 'answered', 409);
    }
    if (decision === undefined || decision === null) throw new ConversationError('Give the answer: the id of one of the options.', 'invalid');
    waiting.settle(decision, 'answered');
    await persist(await open(key));
    return found;
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
      const log = logs.get(key);
      if (conversation.turns.length) {
        const archive = path.join(dir, 'archive'); await mkdir(archive, { recursive: true, mode: 0o700 });
        await write(path.join(archive, `${now().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}.json`), JSON.stringify(conversation, null, 2));
      }
      conversation.turns = [];
      log.shadows.clear(); log.dirty.clear();
      emit(log, { type: 'reset' });
      log.compact = true;                                       // the empty conversation is a new snapshot, and the log starts again
      await persist(conversation);
      return conversation;
    })();
    resets.set(key, work);
    try { return await work; } finally { if (resets.get(key) === work) resets.delete(key); }
  }

  const busy = key => lanesOf(key).length > 0 || (queues.get(key)?.length || 0) > 0 || sending.has(key);

  // ---------------------------------------------------------------- subscribing
  /**
   * The conversation as it is now, with the position in its stream that it corresponds to:
   * { key, cursor, epoch, seq, conversation }. `conversation` is a copy. Subscribing with
   * `after: cursor` then delivers exactly the events that follow.
   */
  async function snapshot(key) {
    const conversation = await open(key), log = logs.get(key);
    sync(conversation, log);
    return { key, cursor: formatCursor(log.epoch, log.seq), epoch: log.epoch, seq: log.seq, conversation: JSON.parse(JSON.stringify(conversation)) };
  }

  /**
   * Calls `listener(event, { seq, cursor })` for every event of a conversation after a
   * position, then for each new one as it happens.
   * @param {string} key
   * @param {object} [options]
   * @param {string|number} [options.after] a cursor from snapshot() or from an earlier event, or a bare
   *   sequence number from this process. Left out: only events from now on.
   * @param {boolean} [options.raw] deliver each event as its JSON text instead of an object (for a stream
   *   helper that would only turn it back into text)
   * @param {Function} listener An event object is shared between subscribers: do not change it.
   *   When the position asked for is no longer held (it is older than `keepEvents`, or from
   *   before a restart), the listener first receives { type: 'gap', seq, cursor }: what it has
   *   is out of date and it should take snapshot() again; live events follow from there. When
   *   the store closes or drops the conversation from memory it receives { type: 'closed' }.
   * @returns {(() => void) & {ready: Promise<{cursor: string, seq: number, epoch: string}>}} call it to stop.
   *   `ready` resolves once the events asked for have been delivered and the subscription is live.
   */
  function subscribe(key, options, listener) {
    if (typeof options === 'function') { listener = options; options = {}; }
    const { after, raw = false } = options || {};
    if (typeof listener !== 'function') throw new TypeError('Give subscribe() a listener.');
    let stopped = false, subscriber = null;
    const tell = (entry, extra) => guard(() => listener(raw ? entry.line : (entry.event ||= JSON.parse(entry.line)), { seq: entry.seq, cursor: formatCursor(logs.get(key)?.epoch ?? '0', entry.seq), ...extra }));
    const stop = () => { stopped = true; if (subscriber) logs.get(key)?.subscribers.delete(subscriber); };
    stop.ready = open(key).then(conversation => {
      const log = logs.get(key);
      const here = () => ({ cursor: formatCursor(log.epoch, log.seq), seq: log.seq, epoch: log.epoch });
      const ended = () => { const end = { type: 'closed' }; tell({ seq: log.seq, line: JSON.stringify(end), event: raw ? null : end }, { closed: true }); };
      if (stopped) return here();
      if (closed) { ended(); return here(); }                   // a closed store has nothing more to say, and says so
      sync(conversation, log);
      if (after !== undefined && after !== null) {
        const from = parseCursor(after);
        if (!from || (from.epoch !== null && from.epoch !== log.epoch) || from.seq > log.seq || from.seq < log.floor) {
          const gap = { type: 'gap', seq: log.seq, cursor: formatCursor(log.epoch, log.seq) };
          tell({ seq: log.seq, line: JSON.stringify(gap), event: raw ? null : gap }, { gap: true });
        } else for (const entry of log.recent.slice(log.recent.findIndex(e => e.seq > from.seq) >>> 0)) { if (stopped) break; tell(entry); }
      }
      if (stopped) return here();
      subscriber = { deliver: tell, end: ended };
      log.subscribers.add(subscriber);
      return here();
    });
    stop.ready.catch(() => {});
    return stop;
  }
  const endSubscribers = key => { const log = logs.get(key); if (!log) return; const all = [...log.subscribers]; log.subscribers.clear(); for (const subscriber of all) subscriber.end(); };

  /** Drops an idle conversation from memory; open() reads it again. False, and nothing happens, while it has work, unwritten changes or subscribers. */
  function unload(key) {
    if (!conversations.has(key) || busy(key) || unwritten(key) || resets.has(key) || loading.has(key) || logs.get(key)?.subscribers.size) return false;
    conversations.delete(key); files.delete(key); used.delete(key); logs.delete(key);
    return true;
  }
  if (Number.isFinite(evictAfter) && evictAfter > 0) {
    sweeper = setInterval(() => { const before = Date.now() - evictAfter; for (const [key, at] of used) if (at <= before) { if (conversations.has(key)) unload(key); else used.delete(key); } }, Math.max(10, Math.min(evictAfter / 2, 60000)));
    sweeper.unref?.();
  }

  return {
    open, send, turn, stop, stopAll, reset, busy, unload, update, snapshot, subscribe, answer, steer,
    /** The keys of the conversations in memory. */
    loaded: () => [...conversations.keys()],
    /** The loaded conversation for a key, or undefined before open(). */
    get: key => conversations.get(key),
    /** What is running in a lane, by lane id: { turn, lane } or undefined. For a host's agent command route. */
    running: laneId => { const r = running.get(laneId); return r && !r.done ? { turn: r.turn, lane: r.lane } : undefined; },
    /** The lanes at work on a conversation. */
    lanes: key => lanesOf(key).map(r => ({ turn: r.turn, lane: r.lane })),
    /**
     * Records and writes, now, whatever a host changed in a conversation outside a run: every
     * turn and the conversation's own fields are compared with what was last recorded. The
     * comparison reads the whole conversation; update() is the cheaper way to change one turn.
     */
    save: async key => persist(await open(key), true),
    /** Folds a conversation's log into its snapshot now, so that `<name>.json` alone holds all of it. */
    compact: async key => { const conversation = await open(key), log = logs.get(key); if (log.lines || log.pending.length || !log.snapshot) log.compact = true; return persist(conversation, true); },
    /** The position of a conversation's stream now: { cursor, epoch, seq }, or undefined before open(). */
    position: key => { const log = logs.get(key); return log && { cursor: formatCursor(log.epoch, log.seq), epoch: log.epoch, seq: log.seq }; },
    /** How many subscribers a loaded conversation has. */
    subscribers: key => logs.get(key)?.subscribers.size ?? 0,
    /** Resolves when every write so far has reached the disk. */
    flush: async () => { while (inFlight.size) await Promise.allSettled([...inFlight]); },
    /**
     * Aborts everything running, drops what is waiting, and waits for the last write; each conversation's log
     * is folded into its snapshot, so the `.json` files alone hold everything. Afterwards send() is refused
     * with code 'closed'.
     */
    async close() {
      closed = true;
      clearInterval(sweeper); sweeper = null;
      queues.clear();
      // Everything still waiting, in a queue or on its way into one, is removed.
      for (const conversation of conversations.values()) for (const t of conversation.turns) if (t.status === 'queued') { Object.assign(t, { status: 'stopped', message: say('removed', t), finishedAt: now() }); logs.get(conversation.key)?.dirty.add(t); }
      const active = [...running.values()];
      for (const r of active) r.controller.abort();
      const until = Date.now() + 2000;
      while (running.size && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
      for (const conversation of conversations.values()) {
        const log = logs.get(conversation.key);
        if (log && (log.lines || log.pending.length || log.dirty.size)) log.compact = true;
        await persist(conversation, true).catch(onError);
      }
      while (inFlight.size) await Promise.allSettled([...inFlight]);
      for (const key of [...logs.keys()]) endSubscribers(key);
      sealed = true;
    },
  };
}
