// The events of a conversation, and how they change it. This file is plain JavaScript
// with no imports, so the same reducer runs in the store (replaying a log after a
// restart) and in a browser (keeping a copy up to date from a stream).
//
// Every event is one JSON object with a sequence number:
//   { seq, at, type, ... }
//
//   turn.created      { turn }                 a request was accepted; `turn` is the whole turn
//   turn.removed      { turnId }               a request that could not be written was taken out again
//   turn.status       { turnId, set }          queued -> running (set.status, set.startedAt, set.lane)
//   turn.activity     { turnId, activities }   one or more activity items changed
//   turn.text         { turnId, append|set }   the reply so far (`preview`) grew, or began again
//   turn.ask          { turnId, set }          a question for a person was asked, answered or expired (set.asks)
//   turn.steer        { turnId, set }          a message was sent into the running turn (set.steers)
//   turn.proposals    { turnId, set }          a proposal was recorded, or the fate of one changed (set.proposals)
//   turn.finished     { turnId, set, ... }     the result: set.status is 'succeeded', 'failed' or 'stopped'
//   turn.patch        { turnId, ... }          any other change to a turn
//   conversation.patch { set?, unset? }        a field of the conversation itself (not a turn) changed
//   reset             {}                       the conversation was started afresh: no turns
//
// Every `turn.*` event except the first two has the same body, and one rule applies it:
//   set         { field: value }    assign these fields of the turn
//   unset       [field]             delete these fields
//   append      { field: text }     add text to the end of these string fields
//   activities  [{ id, fields?, text?, append? }]
//               the item with that id (added at the end when new): `fields` replaces
//               everything but its text; `text` replaces its text; `append` adds to it
// so a consumer that does not care about the kinds can ignore `type` altogether.

export const EVENT_TYPES = ['turn.created', 'turn.removed', 'turn.status', 'turn.activity', 'turn.text', 'turn.ask', 'turn.steer',
  'turn.proposals', 'turn.finished', 'turn.patch', 'conversation.patch', 'reset'];

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
// The turn an event names. Looked for from the end: the turns that change are the newest.
const turnOf = (conversation, id) => { const turns = conversation.turns; for (let i = turns.length - 1; i >= 0; i--) if (turns[i]?.id === id) return turns[i]; return null; };

/**
 * Applies one event to a conversation ({ key, turns, ...fields }), changing it in place.
 * Returns true when the event was applied, false when it does not fit the conversation
 * (it names a turn that is not there, or is not an event): the caller's copy is then out
 * of step and should be loaded again.
 */
export function applyEvent(conversation, event) {
  if (!isObject(conversation) || !Array.isArray(conversation.turns) || !isObject(event)) return false;
  switch (event.type) {
    case 'turn.created':
      if (!isObject(event.turn)) return false;
      conversation.turns.push(event.turn);
      return true;
    case 'turn.removed': {
      const at = conversation.turns.findIndex(turn => turn?.id === event.turnId);
      if (at < 0) return false;
      conversation.turns.splice(at, 1);
      return true;
    }
    case 'reset':
      conversation.turns = [];
      return true;
    case 'conversation.patch':
      return patch(conversation, event, name => name !== 'turns' && name !== 'key');
    default: {
      if (typeof event.type !== 'string' || !event.type.startsWith('turn.')) return false;
      const turn = turnOf(conversation, event.turnId);
      if (!turn) return false;
      return patch(turn, event, name => name !== 'id');
    }
  }
}

function patch(target, event, allowed) {
  const ok = name => typeof name === 'string' && !FORBIDDEN.has(name) && allowed(name);
  if (isObject(event.set)) for (const [name, value] of Object.entries(event.set)) if (ok(name)) target[name] = value;
  if (Array.isArray(event.unset)) for (const name of event.unset) if (ok(name)) delete target[name];
  if (isObject(event.append)) for (const [name, text] of Object.entries(event.append)) if (ok(name) && typeof text === 'string') target[name] = (typeof target[name] === 'string' ? target[name] : '') + text;
  if (Array.isArray(event.activities)) {
    if (!Array.isArray(target.activities)) target.activities = [];
    for (const delta of event.activities) {
      if (!isObject(delta)) continue;
      let item = target.activities.find(a => a?.id === delta.id);
      if (!item) { item = { id: delta.id }; target.activities.push(item); }
      if (isObject(delta.fields)) {
        const text = item.text;
        for (const name of Object.keys(item)) delete item[name];
        for (const [name, value] of Object.entries(delta.fields)) if (!FORBIDDEN.has(name)) item[name] = value;
        item.id = delta.id;
        if (text !== undefined) item.text = text;
      }
      if (typeof delta.text === 'string') item.text = delta.text;
      else if (delta.text === null) delete item.text;
      if (typeof delta.append === 'string') item.text = (typeof item.text === 'string' ? item.text : '') + delta.append;
    }
  }
  return true;
}

/** A place in a conversation's stream, as text: the store's epoch and a sequence number. */
export const formatCursor = (epoch, seq) => `${epoch}:${seq}`;

/** Reads a cursor. Returns { epoch, seq }, or null for anything that is not one. A bare number has no epoch. */
export function parseCursor(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? { epoch: null, seq: value } : null;
  if (typeof value !== 'string' || value.length > 64) return null;
  const match = /^(?:([A-Za-z0-9]{1,32}):)?(\d{1,15})$/.exec(value);
  return match ? { epoch: match[1] ?? null, seq: Number(match[2]) } : null;
}
