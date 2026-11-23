// Activity: what happens to a document while an agent works on it, so the agent can be
// told. Generalised from Toucan's server/activity.mjs.
//
// People edit, comment and point at things while an agent is at work. The host sees all
// of it and feeds it here; this module keeps one feed per document, in order, and lets
// each reader (a chat conversation, a terminal agent, a comment thread's agent) keep its
// own place in it. `pending` gives a reader what is new, leaving out its own doings;
// `ack` moves its place on once it has been told.
//
// Who did it: an agent's run says which parts it touched (`claim`), and those claims are
// matched against the next change to each part. A change nobody claimed is a person's.
//
// What a "part" is, how two states of a document differ, and how a change reads in a
// sentence are the host's: it passes `snapshot`, `diff` and wording. Nothing is kept on
// disk. The feed is about work in progress, and a restart starts afresh.

const SAME = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * @param {object} [options]
 * @param {(doc: string) => any} [options.snapshot] the document's state now, or null when the host does not have it open
 * @param {(before: any, after: any) => {id: string, change: 'added'|'updated'|'removed', before?: any, after?: any, what?: string[], parts?: string[]}[]} [options.diff]
 *   what differs between two snapshots. `parts` are further ids a claim on which also covers this change.
 * @param {(doc: string) => boolean} [options.busy] an agent run is in flight there: wait for its claim before deciding who changed what
 * @param {number} [options.quietMs] how long changes must pause before the document is compared; default 400
 * @param {number} [options.maxWaitMs] but never wait longer than this while they do not; default 3000
 * @param {number} [options.claimMs] how long a claim waits for its change to arrive; default 30000
 * @param {number} [options.keep] events kept per document; default 1000
 * @param {() => number} [options.now]
 */
export function createActivityFeed({ snapshot, diff, busy = () => false, quietMs = 400, maxWaitMs = 3000, claimMs = 30000, keep = 1000, now = () => Date.now() } = {}) {
  const docs = new Map();      // doc -> { base, timer, since, events, claims, selections }
  const readers = new Map();   // reader key -> { doc, seq, seen: Map(user -> selection last told) }
  let seq = 0;

  const stateOf = doc => {
    if (!docs.has(doc)) docs.set(doc, { base: null, timer: null, since: 0, events: [], claims: new Map(), selections: new Map() });
    return docs.get(doc);
  };
  function push(doc, event) {
    const st = stateOf(doc), entry = { seq: ++seq, t: now(), ...event };
    st.events.push(entry);
    if (st.events.length > keep) st.events.splice(0, st.events.length - keep);
    return entry;
  }
  // Whoever claimed a part recently did this; otherwise a person did.
  function who(st, ids, as) {
    if (as) return as;
    for (const id of ids) { const c = st.claims.get(id); if (c) { st.claims.delete(id); return c.actor; } }
    return { kind: 'person' };
  }
  const expire = st => { const t = now(); for (const [id, c] of st.claims) if (t - c.t > claimMs) st.claims.delete(id); };

  /** The host has the document open: its state now is the starting point. */
  function open(doc) { const st = stateOf(doc); if (!st.base && snapshot) st.base = snapshot(doc); }

  /** The host is letting go of the document: what changed last is settled first. */
  function close(doc) {
    const st = docs.get(doc); if (!st) return;
    settle(doc); clearTimeout(st.timer); st.timer = null; st.base = null;
  }

  /** The document changed: compare once changes pause, or every few seconds while they do not. */
  function touched(doc) {
    const st = stateOf(doc);
    if (!st.since) st.since = now();
    clearTimeout(st.timer);
    st.timer = setTimeout(() => {
      st.timer = null;
      // A run is in flight: its claim says which of these changes are its own. Give it a while.
      if (busy(doc) && now() - st.since < claimMs / 3) return touched(doc);
      settle(doc);
    }, now() - st.since > maxWaitMs ? 0 : quietMs);
    st.timer.unref?.();
  }

  /**
   * An agent, or the host itself, says which parts it just changed.
   * @param {{kind: 'agent'|'system'|'person', name?: string}} actor `system` is the host
   *   tending the document itself; readers are never told about those changes.
   */
  function claim(doc, actor, ids) {
    const st = stateOf(doc), t = now();
    for (const id of ids ?? []) if (id !== undefined && id !== null) st.claims.set(id, { actor, t });
  }

  /** Compares the document with how it was last seen; each difference becomes an event, by whoever made it. */
  function settle(doc, { actor } = {}) {
    const st = stateOf(doc);
    st.since = 0;
    if (!snapshot || !diff) return [];
    const next = snapshot(doc);
    if (next === null || next === undefined) return [];
    if (!st.base) { st.base = next; return []; }
    const prev = st.base; st.base = next;
    return changed(doc, diff(prev, next), { actor });
  }

  /** For a host that already knows what changed: records each change, attributed by claims. */
  function changed(doc, changes, { actor } = {}) {
    const st = stateOf(doc); expire(st);
    return (changes ?? []).map(({ parts, ...c }) => push(doc, { type: 'change', ...c, actor: who(st, [c.id, ...(parts ?? [])], actor) }));
  }

  /** Something said about the document: a comment, a version restored. `text` reads after the actor's name. */
  const note = (doc, event) => push(doc, { type: 'note', ...event });

  /** A person's view says what they have selected, or are pointing at. Only a change is news. */
  function selected(doc, view, user, keys) {
    const st = stateOf(doc), next = [...new Set(keys ?? [])].slice(0, 50), was = st.selections.get(view);
    if (was && was.user === user && SAME(was.keys, next)) return null;
    st.selections.set(view, { user, keys: next, t: now() });
    return push(doc, { type: 'select', actor: { kind: 'person', name: user || undefined }, view, keys: next });
  }
  /** A view went away, and its selection with it. */
  const left = (doc, view) => void docs.get(doc)?.selections.delete(view);
  /** Who has what selected, the most recent report first. */
  const selections = doc => [...(docs.get(doc)?.selections.values() ?? [])].sort((a, b) => b.t - a.t);

  // A new reader starts at the present: it has the document as it is now.
  function reader(key, doc) {
    let r = readers.get(key);
    if (r && r.doc === doc) return { reader: r, fresh: false };
    r = { doc, seq, seen: new Map() };
    for (const s of selections(doc)) r.seen.set(s.user ?? '', s.keys.join('\n'));
    readers.set(key, r);
    return { reader: r, fresh: true };
  }

  /**
   * What is new for a reader: events after its place, less the host's own (`system`),
   * its own (`mine(actor)`) and whatever else it should not be told (`skip(event)`).
   * Settles the document first, so a change from a moment ago is in. Pass `upto` to ack().
   */
  function pending(key, doc, { mine = () => false, skip = () => false } = {}) {
    const { reader: r, fresh } = reader(key, doc);
    if (fresh) return { events: [], upto: r.seq, fresh: true, seen: r.seen };
    const st = docs.get(doc);
    if (st?.base) { clearTimeout(st.timer); st.timer = null; settle(doc); }
    const events = (st?.events ?? []).filter(e => e.seq > r.seq && e.actor?.kind !== 'system' && !mine(e.actor) && !skip(e));
    return { events, upto: seq, fresh: false, seen: r.seen };
  }

  /** The reader has been told everything up to `upto`. Pass the events it was told, so repeated selections are not news. */
  function ack(key, upto, events = []) {
    const r = readers.get(key); if (!r) return;
    r.seq = Math.max(r.seq, upto);
    for (const e of events) if (e.type === 'select') r.seen.set(e.actor?.name ?? '', e.keys.join('\n'));
  }

  /** Forgets a reader, and every reader whose key starts with it and a `#`, `:` or `@`. */
  function forget(prefix) { for (const k of [...readers.keys()]) if (k === prefix || ['#', ':', '@'].some(sep => k.startsWith(prefix + sep))) readers.delete(k); }

  return { open, close, touched, claim, settle, changed, note, selected, left, selections, pending, ack, forget, get seq() { return seq; } };
}

/**
 * Several changes to one part by one hand, read as one: where it started and where it
 * ended up. Returns, in order, `{ change: { actor, id, before, after, what } }` with
 * `before` null for something added and `after` null for something removed (a part
 * added and removed again is left out), `{ select: { user, keys } }` for each person's
 * latest selection, and `{ note }`.
 */
export function mergeEvents(events, { seen = new Map() } = {}) {
  const merged = new Map(), selection = new Map(), order = [];
  for (const e of events) {
    if (e.type === 'change') {
      const k = `${e.actor?.kind}:${e.actor?.name ?? ''}:${e.id}`;
      if (!merged.has(k)) { merged.set(k, { first: e, last: e, what: new Set(e.what ?? []) }); order.push({ k }); }
      else { const m = merged.get(k); m.last = e; for (const w of e.what ?? []) m.what.add(w); }
    } else if (e.type === 'select') {
      const user = e.actor?.name ?? '';
      if (!selection.has(user)) order.push({ select: user });
      selection.set(user, e.keys);
    } else if (e.type === 'note') order.push({ note: e });
  }
  const out = [];
  for (const item of order) {
    if (item.k) {
      const { first, last, what } = merged.get(item.k);
      const before = first.change === 'added' ? null : first.before ?? null, after = last.change === 'removed' ? null : last.after ?? null;
      if (first.change === 'added' && last.change === 'removed') continue;
      out.push({ change: { actor: first.actor, id: first.id, before, after, what: [...what] } });
    } else if (item.select !== undefined) {
      const keys = selection.get(item.select);
      if ((seen.get(item.select) ?? '') !== keys.join('\n')) out.push({ select: { user: item.select, keys } });
    } else out.push({ note: item.note });
  }
  return out;
}

/** A name for whoever did something: "Ada", "Scout (agent)", or `person` when the event does not say. */
export const actorName = (actor, person = 'someone') => actor?.kind === 'agent' ? `${actor.name || 'an agent'} (agent)` : actor?.name || person;

/**
 * Events as lines an agent can act on, oldest first. The host words a change with
 * `change({ actor, id, before, after, what }, who)`; return nothing to leave one out.
 * Selections and notes have default wording.
 */
export function describeEvents(events, { change, person, seen, max = 25, more = n => `… and ${n} more changes.` } = {}) {
  const lines = [];
  for (const item of mergeEvents(events, { seen })) {
    if (item.change) { const line = change?.(item.change, actorName(item.change.actor, person)); if (line) lines.push(line); }
    else if (item.select) {
      const { user, keys } = item.select, who = user || person || 'someone';
      lines.push(keys.length ? `${who} selected ${keys.slice(0, 20).join(', ')}${keys.length > 20 ? ` and ${keys.length - 20} more` : ''}` : `${who} cleared their selection`);
    } else lines.push(item.note.actor ? `${actorName(item.note.actor, person)} ${item.note.text}` : item.note.text);
  }
  return lines.length > max ? [...lines.slice(0, max), more(lines.length - max)] : lines;
}

/** The block an agent reads, or null when there is nothing to tell. */
export function formatActivity(lines, { tag = 'activity', intro = 'While you were working, people changed the document (oldest first). Keep what they did: build on it rather than undo it, and do not redo what they removed. It needs no reply unless it changes what you are doing.' } = {}) {
  if (!lines?.length) return null;
  return [`<${tag}>${intro}`, ...lines.map(line => `- ${line}`), `</${tag}>`].join('\n');
}
