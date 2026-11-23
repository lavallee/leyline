// Proposals: a change an agent offers, or makes, to a document people are also editing.
// Generalised from Copycat (src/chat.js and extension/editor.js) and Skein (src/chat.js);
// Toucan's dashed shapes are the same idea drawn on a canvas.
//
// A proposal is recorded on the turn that produced it (turn.proposals), so it is stored
// and shown with the conversation. It is one of two things:
//   - offered: held for a person to apply or dismiss;
//   - made:    applied at once (`auto`), for the person to review and undo.
// What became of it is its `fate`, kept apart from what the agent believes: 'applied',
// 'stale' (the document had changed, so it did not go in), 'undone' (a person took it
// back) or 'dismissed'. An agent is told once, through feedback(), about edits that did
// not stay, so it neither repeats them nor builds on text that is not there.
//
// What an edit *is* belongs to its kind. One kind is built in: `text`, a find-and-replace
// on a named file. A host adds its own (a shape on a canvas, a post in a thread) by
// passing an object with the same five functions. The document is opaque to everything
// here except the kind.
//
// Nothing in this module stores or saves anything. The host owns the document.

/** An error fit to show an agent or a person. */
export class ProposalError extends Error {
  constructor(message, code = 'invalid') { super(message); this.name = 'ProposalError'; this.code = code; }
}

export const FATES = ['applied', 'stale', 'undone', 'dismissed'];
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const count = (body, needle) => { let n = 0; for (let at = body.indexOf(needle); at >= 0; at = body.indexOf(needle, at + 1)) n++; return n; };

/**
 * The built-in kind: replace `find` with `replace` in `file`. The document is a map of
 * file name -> text. `find` must occur exactly once, so an edit can never land in the
 * wrong place; it is undone by the reverse replace, which must also be unambiguous.
 */
export const textEdit = {
  validate(edit) {
    if (!edit || !text(edit.file, 500) || !text(edit.find, 100000) || !text(edit.replace, 200000)) throw new ProposalError('Each edit needs "file", "find" and "replace" strings.');
    return { file: edit.file, find: edit.find, replace: edit.replace };
  },
  /** Null when the edit can be applied to this document, or why it cannot: { code, problem }. */
  check(edit, doc) {
    const body = doc?.[edit.file];
    if (typeof body !== 'string') return { code: 'unknown-file', problem: `${edit.file} is not part of this document (files: ${Object.keys(doc ?? {}).join(', ')}).` };
    if (edit.find === edit.replace) return { code: 'no-change', problem: 'Nothing changes.' };
    const n = edit.find ? count(body, edit.find) : 0;
    if (n === 0) return { code: 'not-found', problem: 'The text to replace is not in the document.' };
    if (n > 1) return { code: 'ambiguous', problem: 'The text to replace occurs more than once.' };
    return null;
  },
  apply(edit, doc) {
    const body = doc[edit.file], at = body.indexOf(edit.find);
    return { ...doc, [edit.file]: body.slice(0, at) + edit.replace + body.slice(at + edit.find.length) };
  },
  invert: edit => ({ ...edit, find: edit.replace, replace: edit.find }),
  label: edit => edit.replace || `removing “${edit.find}”`,
};

const WORDS = {
  undone: label => `A person undid your edit “${label}”. Do not repeat it; read the document again.`,
  stale: label => `The document had changed, so it did not take your edit “${label}”. Do not repeat it; read the document again.`,
  full: 'Too many edits in one request.',
  unknown: 'That edit is not part of this request.',
  notApplied: 'That edit is not in the document.',
};

/**
 * @param {object} [options]
 * @param {Record<string, object>} [options.kinds] edit kinds by name; default { text: textEdit }
 * @param {string} [options.defaultKind] the kind of an edit that names none; default 'text'
 * @param {number} [options.maxPerTurn] default 200
 * @param {object} [options.wording] replaces the feedback and refusal wording; see WORDS in this file
 * @param {() => number} [options.now]
 */
export function createProposals({ kinds = { text: textEdit }, defaultKind = 'text', maxPerTurn = 200, wording = {}, now = () => Date.now() } = {}) {
  const words = { ...WORDS, ...wording };
  const kindOf = p => { const kind = kinds[p?.kind || defaultKind]; if (!kind) throw new ProposalError(`Unknown kind of edit: ${p?.kind}.`); return kind; };
  const listOf = turn => (turn.proposals ||= []);
  const byKey = (turn, key) => { const p = listOf(turn).find(p => p.key === key); if (!p) throw new ProposalError(words.unknown, 'not-found'); return p; };
  const applied = p => p.fate === 'applied' || (p.auto && !p.fate);

  function record(turn, edit, extra) {
    const list = listOf(turn);
    if (list.length >= maxPerTurn) throw new ProposalError(words.full, 'full');
    const name = edit?.kind || defaultKind, clean = kindOf({ kind: name }).validate(edit);
    const proposal = { key: `e${list.length}`, ...(name === defaultKind ? {} : { kind: name }), ...clean,
      reason: text(edit.reason, 2000) ? edit.reason : '', ...extra, at: new Date(now()).toISOString() };
    list.push(proposal);
    return proposal;
  }

  /**
   * Records an edit for a person to apply or dismiss. With `doc`, the edit is checked
   * against it and a problem recorded (`ok: false`), so a card can say why it cannot be used.
   */
  function offer(turn, edit, { doc } = {}) {
    const proposal = record(turn, edit, { ok: true });
    const trouble = doc === undefined ? null : kindOf(proposal).check(proposal, doc);
    if (trouble) Object.assign(proposal, { ok: false, problem: trouble.problem });
    return proposal;
  }

  /**
   * Makes an edit now: checks it against the document, applies it and records it as an
   * automatic proposal. Nothing is recorded when it cannot be applied.
   * @returns {{ok: true, doc: any, proposal: object} | {ok: false, doc: any, code: string, problem: string}}
   */
  function make(turn, edit, doc) {
    let clean;
    try {
      if (listOf(turn).length >= maxPerTurn) throw new ProposalError(words.full, 'full');
      clean = { kind: edit?.kind || defaultKind, ...kindOf({ kind: edit?.kind }).validate(edit) };
    } catch (error) { if (!(error instanceof ProposalError)) throw error; return { ok: false, doc, code: error.code, problem: error.message }; }
    const trouble = kindOf(clean).check(clean, doc);
    if (trouble) return { ok: false, doc, ...trouble };
    const next = kindOf(clean).apply(clean, doc);
    return { ok: true, doc: next, proposal: record(turn, edit, { ok: true, auto: true }) };
  }

  /**
   * Where a proposal stands against a document: its fate when it has one, otherwise
   * 'applied' (made automatically), 'invalid', 'ready' or 'stale'.
   */
  function state(proposal, doc) {
    if (proposal.fate) return proposal.fate;
    if (proposal.auto) return 'applied';
    if (proposal.ok === false) return 'invalid';
    return kindOf(proposal).check(proposal, doc) ? 'stale' : 'ready';
  }

  /** A person applies an offered proposal. */
  function apply(turn, key, doc) {
    const p = byKey(turn, key);
    if (applied(p)) return { ok: true, doc, proposal: p };
    const trouble = p.ok === false ? { code: 'invalid', problem: p.problem } : kindOf(p).check(p, doc);
    if (trouble) return { ok: false, doc, ...trouble };
    p.fate = 'applied';
    return { ok: true, doc: kindOf(p).apply(p, doc), proposal: p };
  }

  /**
   * A person takes one edit back: the reverse edit is applied, if it still can be.
   * The agent that made it is told once, through feedback().
   */
  function undo(turn, key, doc) {
    const p = byKey(turn, key);
    if (!applied(p)) return { ok: false, doc, code: 'not-applied', problem: words.notApplied };
    const kind = kindOf(p), reverse = kind.invert(p), trouble = kind.check(reverse, doc);
    if (trouble) return { ok: false, doc, ...trouble };
    Object.assign(p, { fate: 'undone', told: false });
    return { ok: true, doc: kind.apply(reverse, doc), proposal: p };
  }

  /**
   * Takes back everything one request changed, newest edit first. Each edit is reversed
   * on its own, so what other people changed meanwhile stays; an edit whose text has
   * since been changed is left in place and listed in `refused`.
   */
  function undoRequest(turn, doc) {
    const undone = [], refused = [];
    for (const p of [...listOf(turn)].reverse()) {
      if (!applied(p)) continue;
      const result = undo(turn, p.key, doc);
      if (result.ok) { doc = result.doc; undone.push(p.key); } else refused.push({ key: p.key, code: result.code, problem: result.problem });
    }
    return { doc, undone, refused };
  }

  /** A person declines an offered proposal. Nothing changes in the document. */
  function dismiss(turn, key) { const p = byKey(turn, key); if (!applied(p)) p.fate = 'dismissed'; return p; }

  /**
   * Takes a reader's account of what became of proposals where the document really
   * lives (a browser, say): `seen` maps `${turn.id}:${proposal.key}` to a fate. Returns
   * how many proposals changed. An edit reported 'stale' or 'undone' is queued for feedback().
   */
  function report(turns, seen) {
    let changed = 0;
    if (!seen || typeof seen !== 'object') return changed;
    for (const turn of turns) for (const p of turn.proposals || []) {
      const fate = seen[`${turn.id}:${p.key}`];
      if (!FATES.includes(fate) || p.fate === fate) continue;
      p.fate = fate; changed++;
      if (fate === 'stale' || fate === 'undone') p.told = false;
    }
    return changed;
  }

  /**
   * A document as an agent should read it: the reader's copy, plus the edits of running
   * turns that no reader has reported on yet. It lets an agent build on its own last edit
   * in the moment before the reader catches up. An edit that no longer fits is skipped.
   */
  function replay(turns, doc, { only = turn => turn.status === 'running' } = {}) {
    for (const turn of turns) if (only(turn)) for (const p of turn.proposals || []) {
      if (!p.auto || p.fate) continue;
      const kind = kindOf(p);
      if (!kind.check(p, doc)) doc = kind.apply(p, doc);
    }
    return doc;
  }

  /** What to tell an agent about its edits that did not stay. Each is told once. */
  function feedback(turns) {
    const lines = [];
    for (const turn of Array.isArray(turns) ? turns : [turns]) for (const p of turn.proposals || []) {
      if (p.told !== false || (p.fate !== 'stale' && p.fate !== 'undone')) continue;
      p.told = true;
      lines.push(words[p.fate](String(p.reason || kindOf(p).label(p)).slice(0, 80), p));
    }
    return lines;
  }

  /** The edits of a turn that are in the document now, as far as is known. */
  const appliedIn = turn => listOf(turn).filter(applied);

  return { offer, make, state, apply, undo, undoRequest, dismiss, report, replay, feedback, appliedIn };
}
