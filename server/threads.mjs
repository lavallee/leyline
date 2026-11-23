// Threads: conversations attached to part of a document. People and agents go back and
// forth in them and close them out. Generalised from Toucan's server/threads.mjs, with
// the hand-off to an agent that Toucan (askThread) and Copycat (comments handed to the
// live agent, which replies on the comment) each built.
//
// A thread's anchor says what it is attached to. It is opaque here: shapes and a region
// on a canvas, a character range at a file revision, a post. The host checks anchors
// (`cleanAnchor`), finds them again when the document changes, and says in words where
// one sits (`where`) when a thread is handed to an agent.
//
// Threads are kept beside the document, not in it, so they survive undo and restores.
// By default that is one private JSON file per document in `dir`; a host that keeps
// comments somewhere of its own (in the source repository, say) passes `storage`.
import path from 'node:path';
import { safeName, readJson, writeJson } from './files.mjs';

/** Errors fit to show a person. `status` is an HTTP status a host may answer with. */
export class ThreadError extends Error {
  constructor(message, code = 'invalid') { super(message); this.name = 'ThreadError'; this.code = code; this.status = code === 'not-found' ? 404 : 400; }
}

/** The whole conversation, for handing a thread to someone new. */
export const transcript = thread => thread.messages.map(m => `${m.author.name}: ${m.text}`).join('\n');

/** The messages a thread's own agent has not been told yet. */
export const unseen = thread => thread.messages.slice(thread.seen ?? 0);

/**
 * What a thread's agent is given: where the thread sits and everything its conversation
 * has not been told. That is tracked, not inferred, because others (the main chat, a
 * terminal agent, people) also speak in a thread.
 */
export function promptFor(thread, { where, label = 'Comment thread' } = {}) {
  const fresh = unseen(thread).map(m => `${m.author.name}: ${m.text}`).join('\n');
  const place = typeof where === 'function' ? where(thread) : where;
  return `${label} #${thread.id}${place ? `, ${place}` : ''}.\n${fresh || 'Nothing new has been said: take this thread from where it stands.'}`;
}

/**
 * @param {object} options
 * @param {string} [options.dir] threads for a document are kept in `<dir>/<key>.threads.json`
 * @param {{load: (key: string) => object|null, save: (key: string, data: object) => void}} [options.storage] instead of `dir`
 * @param {(anchor: any) => any} [options.cleanAnchor] checks an anchor and returns it, or throws a ThreadError
 * @param {{text?: number, name?: number, messages?: number}} [options.limits]
 * @param {() => number} [options.now]
 */
export function createThreadStore({ dir, storage, cleanAnchor = anchor => anchor, limits = {}, now = () => Date.now() } = {}) {
  if (!storage && (typeof dir !== 'string' || !dir)) throw new TypeError('Give the thread store a directory or a storage object.');
  const max = { text: 20000, name: 60, messages: 500, ...limits };
  const file = key => path.join(dir, `${safeName(key)}.threads.json`);
  const store = storage ?? { load: key => readJson(file(key), null), save: (key, data) => writeJson(file(key), data) };
  const load = key => { const data = store.load(key); return data && Array.isArray(data.threads) ? data : { next: 1, threads: [] }; };
  const stamp = () => new Date(now()).toISOString();

  const author = who => ({ kind: who?.kind === 'agent' ? 'agent' : 'person', name: String(who?.name || (who?.kind === 'agent' ? 'Agent' : 'Someone')).slice(0, max.name) });
  function message(who, text) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new ThreadError('Say something: the text is empty.');
    return { author: author(who), text: clean.slice(0, max.text), t: stamp() };
  }
  function change(key, id, fn) {
    const data = load(key), thread = data.threads.find(t => String(t.id) === String(id));
    if (!thread) throw new ThreadError(`There is no thread ${id}.`, 'not-found');
    const result = fn(thread, data);
    if (thread.messages.length > max.messages) throw new ThreadError('This thread is full. Close it and start another.');
    store.save(key, data);
    return result ?? thread;
  }

  /** Threads of a document, oldest first. `{ status: 'open' }` filters. */
  const list = (key, { status } = {}) => load(key).threads.filter(t => !status || t.status === status);
  function get(key, id) {
    const thread = load(key).threads.find(t => String(t.id) === String(id));
    if (!thread) throw new ThreadError(`There is no thread ${id}.`, 'not-found');
    return thread;
  }

  /** Starts a thread. `source` is the host's note of where it came from (an imported comment, say). */
  function create(key, { anchor, author: who, text, source } = {}) {
    const data = load(key);
    const thread = { id: data.next++, anchor: cleanAnchor(anchor), status: 'open', created: stamp(), messages: [message(who, text)], ...(source ? { source } : {}) };
    data.threads.push(thread);
    store.save(key, data);
    return thread;
  }

  /** Adds to a thread. Saying something in a closed thread opens it again. */
  const reply = (key, id, { author: who, text } = {}) => change(key, id, t => {
    t.messages.push(message(who, text));
    if (t.status === 'closed') { t.status = 'open'; delete t.closed; }
  });

  /**
   * The thread's own agent finishing its turn. The thread may have been closed meanwhile,
   * and this does not reopen it. Its own words count as seen by its conversation, if it
   * had seen everything before them.
   */
  const agentAnswered = (key, id, text, name) => change(key, id, t => {
    const upToDate = (t.seen ?? 0) === t.messages.length;
    t.messages.push(message({ kind: 'agent', name }, text));
    if (upToDate) t.seen = t.messages.length;
  });

  /** The thread's own agent has now been told everything said so far (or up to `count` messages). */
  const markSeen = (key, id, count) => change(key, id, t => void (t.seen = Math.min(t.messages.length, count ?? t.messages.length)));

  /** Closes a thread, optionally with a last word. */
  const close = (key, id, { by, reply: last } = {}) => change(key, id, t => {
    if (last) t.messages.push(message(by, last));
    t.status = 'closed';
    t.closed = { by: author(by), t: stamp() };
  });

  const reopen = (key, id) => change(key, id, t => { t.status = 'open'; delete t.closed; });

  /** Moves a thread: the host found its anchor again after the document changed. */
  const reanchor = (key, id, anchor) => change(key, id, t => void (t.anchor = cleanAnchor(anchor)));

  /** Deletes a thread. Returns it. */
  const remove = (key, id) => change(key, id, (t, data) => { data.threads.splice(data.threads.indexOf(t), 1); return t; });

  /**
   * Hands a thread to an agent and posts its final message as the reply.
   * `run({ prompt, thread })` is the host's: it sends the prompt to whichever agent
   * answers this thread (usually a conversation of its own, keyed by the thread) and
   * resolves with `{ message }`, or with nothing when the agent replied some other way.
   * What the agent was told is marked seen as it is handed over; if `run` fails, that
   * mark is put back so the next hand-off tells it again.
   * @returns {Promise<{thread: object, prompt: string, result: any}>}
   */
  async function handOff(key, id, run, { where, label, agent } = {}) {
    const before = get(key, id), prompt = promptFor(before, { where, label }), was = before.seen ?? 0;
    markSeen(key, id, before.messages.length);
    let result;
    try { result = await run({ prompt, thread: before }); }
    catch (error) { change(key, id, t => void (t.seen = Math.min(t.seen ?? 0, was))); throw error; }
    const said = typeof result === 'string' ? result : result?.message;
    const thread = said && String(said).trim() ? agentAnswered(key, id, said, agent ?? result?.agent) : get(key, id);
    return { thread, prompt, result };
  }

  return { list, get, create, reply, agentAnswered, markSeen, close, reopen, reanchor, remove, handOff };
}
