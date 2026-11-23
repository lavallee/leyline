// Two logs of what agents actually did, generalised from Toucan's server/worklog.mjs
// and server/trail.mjs.
//
// The work log (one per host): every run that changed something, failed, or was a
// routine. From it a host learns which routines are used and by whom (`routineStats`),
// and which chores agents keep doing by hand and should be banked as routines
// (`suggestRoutines`).
//
// The trail (one per document): what agents changed while no person was watching, for a
// "while you were away" notice.
//
// Both are append-only JSON lines in private files. Neither records prompts or replies.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { safeName } from './files.mjs';

const count = list => Array.isArray(list) ? list.length : Number.isFinite(list) ? list : 0;
function append(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fresh = !existsSync(file);
  appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  if (fresh) chmodSync(file, 0o600);
}
function lines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').flatMap(line => { if (!line) return []; try { return [JSON.parse(line)]; } catch { return []; } });
}

/** A time to read from: ISO, epoch milliseconds, or a span back from now such as 30d, 12h, 45m, 2w. Nothing means the beginning. */
export function sinceMs(since, now = Date.now()) {
  if (since === undefined || since === null || since === '') return 0;
  const span = /^(\d+)\s*(m|h|d|w)$/.exec(String(since));
  if (span) return now - Number(span[1]) * { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[span[2]];
  const at = /^\d+$/.test(String(since)) ? Number(since) : Date.parse(since);
  if (Number.isNaN(at)) throw new RangeError('since: an ISO time, epoch milliseconds, or a span like 30d.');
  return at;
}

/**
 * @param {object} options
 * @param {string} options.file the log; one rotation is kept beside it as `<name>.1<ext>`
 * @param {number} [options.maxBytes] size at which the log rotates; default 8 MB
 * @param {number} [options.maxCode] characters of code kept per run; default 20000
 */
export function createWorkLog({ file, maxBytes = 8 << 20, maxCode = 20000, now = () => Date.now() } = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('Give the work log a file.');
  const { dir, name, ext } = path.parse(file), rotated = path.join(dir, `${name}.1${ext}`);

  /**
   * Records a run, if it is worth learning from: one that changed something, failed, or
   * was a routine. Returns the entry or null.
   * @param {object} run
   * @param {string} run.doc which document
   * @param {string} [run.engine] which kind of document, where a host has several
   * @param {string} [run.agent] who: an agent's name, or the host's own name for a person using its menu
   * @param {'exec'|'routine'|string} [run.kind] default 'exec': work written by hand
   * @param {string} [run.routine] the routine's name, when it was one
   * @param {string} [run.label]
   * @param {string} [run.code] what was run. Not kept for routines: the bank has it.
   * @param {{added?: any[]|number, updated?: any[]|number, removed?: any[]|number}} [run.changes]
   */
  function record({ doc, engine, agent, kind, routine, label, code, changes, ok = true, error, ms, id, source } = {}) {
    const what = kind || (routine ? 'routine' : 'exec');
    const changed = { added: count(changes?.added), updated: count(changes?.updated), removed: count(changes?.removed) };
    if (ok && !(changed.added + changed.updated + changed.removed) && what !== 'routine') return null;
    const entry = { ...(id ? { id: String(id).slice(0, 120) } : {}), t: new Date(now()).toISOString(), doc, ...(engine ? { engine } : {}), agent: String(agent || 'agent').slice(0, 40), kind: what,
      ...(routine ? { routine: String(routine).slice(0, 64) } : {}), ...(label ? { label: String(label).slice(0, 200) } : {}),
      ...(what !== 'routine' && code !== undefined ? { code: String(code).slice(0, maxCode) } : {}), changed, ok: !!ok,
      ...(!ok ? { error: String(error ?? '').slice(0, 300) } : {}), ...(ms ? { ms } : {}), ...(source ? { source: String(source).slice(0, 20) } : {}) };
    if (existsSync(file) && statSync(file).size > maxBytes) renameSync(file, rotated);
    append(file, entry);
    return entry;
  }

  /** Entries since a time (see sinceMs), oldest first, from the log and its rotation. */
  function read(since) {
    const after = sinceMs(since, now());
    return [...lines(rotated), ...lines(file)].filter(e => Date.parse(e.t) >= after);
  }

  /** Past work brought in from elsewhere (an agent's own session logs), each entry once by its id. Returns how many were new. */
  function importEntries(entries, { accept = () => true } = {}) {
    const known = new Set(read().map(e => e.id).filter(Boolean));
    let added = 0;
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!e || typeof e.id !== 'string' || known.has(e.id) || typeof e.code !== 'string' || typeof e.doc !== 'string' || !accept(e)) continue;
      known.add(e.id);
      const at = Date.parse(e.t);
      append(file, { id: e.id.slice(0, 120), t: new Date(Number.isNaN(at) ? 0 : at).toISOString(), doc: e.doc, ...(e.engine ? { engine: e.engine } : {}), agent: String(e.agent || 'agent').slice(0, 40), kind: 'exec',
        ...(e.label ? { label: String(e.label).slice(0, 200) } : {}), code: e.code.slice(0, maxCode), changed: { added: 0, updated: 0, removed: 0 }, ok: true, source: String(e.source || 'import').slice(0, 20) });
      added++;
    }
    return added;
  }

  return { record, read, importEntries, file };
}

/** How each routine is used: runs, by people or agents, failures, on how many documents, and when last. */
export function routineStats(entries, routines = [], { person = 'person' } = {}) {
  const blank = r => ({ name: r.name, title: r.title ?? r.name, kind: r.kind ?? 'unknown', runs: 0, byPeople: 0, byAgents: 0, failed: 0, docs: new Set(), last: null, errors: [] });
  const by = new Map(routines.map(r => [r.name, blank(r)]));
  let handWritten = 0;
  for (const e of entries) {
    if (e.kind !== 'routine') { if (e.kind === 'exec') handWritten++; continue; }
    if (!by.has(e.routine)) by.set(e.routine, blank({ name: e.routine }));
    const s = by.get(e.routine);
    s.runs++; e.agent === person ? s.byPeople++ : s.byAgents++;
    if (!e.ok) { s.failed++; if (s.errors.length < 3) s.errors.push(e.error); }
    s.docs.add(e.doc); s.last = e.t;
  }
  return { routines: [...by.values()].map(s => ({ ...s, docs: s.docs.size })).sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)), handWritten };
}

/**
 * Code reduced to what it does: comments, the text in strings, numbers and whitespace
 * go, so two runs that differ only in which thing, which colour or how far still match.
 * Written for JavaScript-like code; a host with another language passes its own `shapeOf`
 * to suggestRoutines.
 */
export function shapeOf(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '`T`')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, 'S')
    // A regular expression where a value can start (after ( , = : > and the like): its pattern is names too.
    .replace(/([(,=:>[!&|?{;]\s*|\breturn\s+)\/(?![*/])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n\\])+\/[dgimsuy]*/g, '$1R')
    .replace(/\b\d+(\.\d+)?\b/g, '0')
    .replace(/\s+/g, ' ')
    .trim();
}
const tokens = shape => new Set(shape.match(/[A-Za-z_$][\w$]*|[^\s\w]/g) ?? []);
const jaccard = (a, b) => { let n = 0; for (const t of a) if (b.has(t)) n++; return n / (a.size + b.size - n || 1); };

/**
 * Chores worth banking: hand-written runs that repeat, grouped by what they do. `min` is
 * how many runs make a habit; work done on several documents counts for more than the
 * same document over and over. Each suggestion carries an example to start from, and
 * `coveredBy`: routines that already do it (a missed routine, not a new one).
 * @param {object[]} entries from a work log
 * @param {object} [options]
 * @param {object[]} [options.routines] the routines there are: { name, code }
 * @param {(code: string, shape: string) => string[]} [options.covers] the host's own knowledge of which routines do what some code does
 */
export function suggestRoutines(entries, { routines = [], min = 3, limit = 20, similar = 0.85, minLength = 40, shape: reduce = shapeOf, covers = () => [] } = {}) {
  const banked = routines.map(r => ({ name: r.name, shape: reduce(r.code ?? '') }));
  const groups = [];
  for (const e of entries) {
    if (e.kind !== 'exec' || !e.ok || !e.code) continue;
    const shape = reduce(e.code);
    if (shape.length < minLength) continue;   // a one-liner is not a chore
    const toks = tokens(shape), g = groups.find(x => x.shape === shape || jaccard(x.tokens, toks) >= similar);
    if (g) g.runs.push(e); else groups.push({ shape, tokens: toks, runs: [e] });
  }
  return groups.map(g => {
    const docs = [...new Set(g.runs.map(r => r.doc))], latest = g.runs.at(-1);
    const coveredBy = [...new Set([...covers(latest.code, g.shape), ...banked.filter(r => r.shape === g.shape || jaccard(tokens(r.shape), g.tokens) > 0.9).map(r => r.name)])];
    return { id: createHash('sha256').update(g.shape).digest('hex').slice(0, 10), runs: g.runs.length, docs, agents: [...new Set(g.runs.map(r => r.agent))],
      labels: [...new Set(g.runs.map(r => r.label).filter(Boolean))].slice(0, 5), first: g.runs[0].t, last: latest.t, coveredBy, example: latest.code, score: g.runs.length + 2 * (docs.length - 1) };
  }).filter(s => s.runs >= min || s.docs.length >= 2)
    .sort((a, b) => b.score - a.score || Date.parse(b.last) - Date.parse(a.last)).slice(0, limit).map(({ score, ...s }) => s);
}

/**
 * The trail: what agents changed on a document while nobody had it open.
 * @param {{dir: string}} options each document's trail is `<dir>/<key>.trail.jsonl`
 */
export function createTrail({ dir, now = () => Date.now() } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('Give the trail a directory.');
  const file = doc => path.join(dir, `${safeName(doc)}.trail.jsonl`);
  const keys = list => Array.isArray(list) ? list.map(r => typeof r === 'string' ? r : r?.key ?? r?.id).filter(k => typeof k === 'string').slice(0, 500) : [];
  return {
    /** Appends an entry when the run changed something; returns it, or null. `what` is one line saying what ran. */
    record(doc, { source, what, changes, ok = true, error } = {}) {
      const entry = { t: new Date(now()).toISOString(), source, what: String(what ?? '').replace(/\s+/g, ' ').trim().slice(0, 200), added: keys(changes?.added), updated: keys(changes?.updated), removed: keys(changes?.removed) };
      if (!ok) entry.error = String(error ?? '').slice(0, 200);
      if (!entry.added.length && !entry.updated.length && !entry.removed.length) return null;
      append(file(doc), entry);
      return entry;
    },
    /** Entries after `since` (see sinceMs), oldest first. */
    read(doc, since) { const after = sinceMs(since, now()); return lines(file(doc)).filter(e => Date.parse(e.t) > after); },
  };
}
