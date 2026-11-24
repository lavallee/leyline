// Profiles: named agents a document can be bound to. A profile gives an agent its own
// folder to read, a briefing, starting context and skills, so that the chat beside a
// document is with "Kiefer" and not a general-purpose assistant. Generalised from
// Toucan's server/profiles.mjs.
//
// A profile:
//   { id, name, description?, color?,
//     workdir,        the agent's own folder: its repository, notebook, memory. Absolute.
//     instructions,   who it is and how it works, in its own words
//     context: [{ path, label? } | { text, label }],   read when a conversation starts, within `budget` characters
//     skills: [{ name, description, path }],           SKILL.md files it may open when one applies
//     references: [path | { path, label }],            folders people may read beside the document
//     model?, provider?, budget? }
// Paths are relative to workdir. Context and references must be inside it and not
// hidden. A profile grants no writing: where an agent may write is the host's sandbox
// policy, and a profile, which anyone who can reach the host may bind, must not be a
// way to widen it. Everything a source says is checked, and a missing file is reported
// in `problems` rather than skipped silently.
//
// Profiles come from sources: local JSON files, or anything with `list()` and `get(id)`.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readJson, writeJson } from './files.mjs';

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DEFAULT_BUDGET = 24000, MAX_BUDGET = 80000, MAX_FILE = 4 << 20;
const str = (value, max = 400) => typeof value === 'string' ? value.slice(0, max) : undefined;

export class ProfileError extends Error { constructor(message) { super(message); this.name = 'ProfileError'; this.status = 400; } }

/** Doctrine files a profile made from a folder starts with, the first ones found. */
export const STARTERS = ['AGENTS.md', 'CLAUDE.md', 'CHARTER.md', 'README.md'];

/**
 * A source of profiles kept as `<dir>/<id>.json`. A file that is not a JSON object is left
 * out of list() so that one bad file does not hide the rest; problems() names those files.
 */
export function fileSource(dir, id = 'local') {
  const scan = () => {
    const profiles = [], problems = [];
    for (const f of existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : []) {
      try {
        const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a JSON object');
        profiles.push({ ...raw, id: f.slice(0, -5) });
      } catch (error) { problems.push({ id: f.slice(0, -5), file: path.join(dir, f), error: String(error.message ?? error).slice(0, 200) }); }
    }
    return { profiles, problems };
  };
  return { id, dir,
    list: () => scan().profiles,
    problems: () => scan().problems,
    get(profileId) {
      const file = path.join(dir, `${profileId}.json`);
      if (!existsSync(file)) throw new ProfileError(`No profile ${id}/${profileId}: put one in ${file}.`);
      try { return JSON.parse(readFileSync(file, 'utf8')); } catch (error) { throw new ProfileError(`${file} is not valid JSON: ${error.message}`); }
    } };
}

/**
 * A source that is a program: `COMMAND list` prints {"profiles": [...]} and
 * `COMMAND get ID` prints one profile, as JSON. It is run without a shell, with a time limit.
 * @param {{id: string, command: string[], timeout?: number, env?: object}} options
 */
export function commandSource({ id, command, timeout = 15000, env = process.env }) {
  const ask = args => new Promise((resolve, reject) => execFile(command[0], [...command.slice(1), ...args], { timeout, maxBuffer: 4 << 20, env }, (error, stdout) => {
    if (error) return reject(new ProfileError(`${id} ${args.join(' ')}: ${String(error.message).slice(0, 300)}`));
    try { resolve(JSON.parse(stdout)); } catch { reject(new ProfileError(`${id} ${args.join(' ')}: the answer was not JSON.`)); }
  }));
  return { id, list: async () => (await ask(['list'])).profiles ?? [], get: profileId => ask(['get', profileId]) };
}

/**
 * A profile as a source described it, made safe to use: a folder that exists and is not
 * too broad, files read within the budget, nothing reaching outside the folder.
 */
export function checkProfile(raw, ref, { home = homedir() } = {}) {
  if (!raw || typeof raw !== 'object') throw new ProfileError(`${ref}: a profile is a JSON object.`);
  const problems = [];
  const workdir = typeof raw.workdir === 'string' && path.isAbsolute(raw.workdir) ? raw.workdir : null;
  if (!workdir) throw new ProfileError(`${ref}: workdir must be an absolute path to the agent's folder.`);
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) throw new ProfileError(`${ref}: workdir ${workdir} is not a folder on this machine.`);
  const base = realpathSync(workdir), realHome = existsSync(home) ? realpathSync(home) : home;
  // A whole disk or a home folder is not an agent's folder: its context could be anyone's keys.
  if (base === path.sep || realHome === base || realHome.startsWith(base + path.sep)) throw new ProfileError(`${ref}: workdir ${workdir} is too broad; give the agent's own folder.`);
  const at = p => path.resolve(base, String(p));
  const within = full => {
    const real = existsSync(full) ? realpathSync(full) : full;
    return (real === base || real.startsWith(base + path.sep)) && !path.relative(base, real).split(path.sep).some(part => part.startsWith('.'));
  };
  const budget = Math.min(MAX_BUDGET, Math.max(1000, Number(raw.budget) || DEFAULT_BUDGET));
  let left = budget;
  const context = [];
  for (const c of Array.isArray(raw.context) ? raw.context : []) {
    if (typeof c?.text === 'string') {
      const text = c.text.slice(0, left); left -= text.length;
      context.push({ label: str(c.label, 120) || 'briefing', text, chars: text.length, truncated: text.length < c.text.length });
      continue;
    }
    const file = typeof c === 'string' ? c : c?.path;
    if (typeof file !== 'string') continue;
    const full = at(file), label = str(c?.label, 120) || file;
    if (!within(full)) { problems.push(`context ${file}: outside ${base}, or hidden`); continue; }
    if (!existsSync(full) || !statSync(full).isFile()) { problems.push(`context ${file}: no such file`); context.push({ label, path: full, missing: true, chars: 0 }); continue; }
    if (statSync(full).size > MAX_FILE) { problems.push(`context ${file}: over ${MAX_FILE >> 20} MB, so not read`); continue; }
    const bytes = readFileSync(full), whole = bytes.toString('utf8'), text = whole.slice(0, left);
    left -= text.length;
    context.push({ label, path: full, text, chars: text.length, truncated: text.length < whole.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const skills = [];
  for (const s of Array.isArray(raw.skills) ? raw.skills : []) {
    const given = typeof s === 'string' ? s : s?.path;
    if (typeof given !== 'string') continue;
    const full = at(given);
    if (!within(full)) { problems.push(`skill ${given}: outside ${base}, or hidden`); continue; }
    const file = existsSync(full) && statSync(full).isDirectory() ? path.join(full, 'SKILL.md') : full;
    if (!existsSync(file)) { problems.push(`skill ${given}: no SKILL.md`); continue; }
    // Name and description from the skill's own front matter when the source gave none.
    const fd = openSync(file, 'r'), start = Buffer.alloc(4000);
    let head; try { head = start.toString('utf8', 0, readSync(fd, start, 0, start.length, 0)).slice(0, 2000); } finally { closeSync(fd); }
    const front = key => head.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
    skills.push({ name: str(s?.name, 80) || front('name') || given, description: str(s?.description, 600) || front('description') || '', path: file });
  }
  const references = (Array.isArray(raw.references) ? raw.references : []).flatMap(r => {
    const given = typeof r === 'string' ? r : r?.path;
    if (typeof given !== 'string') return [];
    const full = at(given);
    if (!existsSync(full) || !statSync(full).isDirectory()) { problems.push(`reference ${given}: not a folder`); return []; }
    if (!within(full)) { problems.push(`reference ${given}: outside ${base}, or hidden`); return []; }
    return [{ dir: realpathSync(full), label: str(r?.label, 80) || given }];
  });
  if (Array.isArray(raw.writable) && raw.writable.length) problems.push('writable: a profile cannot grant writing; where the agent may write is the host\'s to decide');
  return { ref, id: raw.id, name: str(raw.name, 60) || raw.id, description: str(raw.description) ?? '', ...(str(raw.color, 20) ? { color: str(raw.color, 20) } : {}),
    workdir: base, instructions: str(raw.instructions, 20000) ?? '', context, skills, references,
    ...(str(raw.model, 80) ? { model: str(raw.model, 80) } : {}), ...(str(raw.provider, 80) ? { provider: str(raw.provider, 80) } : {}), budget, problems };
}

/** What a profile tells its agent, to go after the host's own instructions. */
export function profileInstructions(p, { place = 'this document' } = {}) {
  const parts = [
    `You are ${p.name}, not a general-purpose assistant: the person chose to work with you on ${place}. Speak as ${p.name}, from what ${p.name} knows and believes, and say plainly when something is outside what you know.`,
    `Your own folder is ${p.workdir}. Read from it with absolute paths. It is for reading: write only where the instructions above say you may.`,
  ];
  if (p.instructions) parts.push(`## Who you are\n\n${p.instructions}`);
  if (p.skills.length) parts.push(`## Your skills\n\nOpen a skill's file and follow it when the work calls for it:\n${p.skills.map(s => `- ${s.name}: ${s.description} (${s.path})`).join('\n')}`);
  const read = p.context.filter(c => c.text);
  if (read.length) parts.push(`## What you know at the start\n\nRead before this conversation began; go back to the files for more.\n\n${read.map(c => `### ${c.label}${c.path ? ` (${c.path})` : ''}${c.truncated ? ' (cut short)' : ''}\n\n${c.text}`).join('\n\n')}`);
  const missing = p.context.filter(c => c.missing);
  if (missing.length) parts.push(`These were meant to be in your starting context but were not found: ${missing.map(c => c.label).join(', ')}.`);
  return parts.join('\n\n');
}

/**
 * A provider request for a profile's agent: the host's request with the profile's
 * instructions after the host's own, and the profile's model when it names one.
 * The profile's folder is NOT added to any writable root.
 */
export function requestFor(profile, request = {}, options) {
  if (!profile) return request;
  return { ...request, instructions: [request.instructions, profileInstructions(profile, options)].filter(Boolean).join('\n\n'), ...(profile.model ? { model: profile.model } : {}) };
}

/** The provider a profile asks for by name, from the host's table, or the fallback. */
export const providerFor = (profile, providers, fallback) => (profile?.provider && Object.hasOwn(providers, profile.provider) ? providers[profile.provider] : fallback);

/** A conversation key for a document and the agent bound to it: binding another agent starts another conversation. */
export const conversationKey = (doc, profile) => profile ? `${doc}@${typeof profile === 'string' ? profile : profile.ref}` : doc;

/**
 * Lookups for a host: sources listed together, profiles checked and kept a short while.
 * @param {object} options
 * @param {string} [options.dir] local profiles, one JSON file each; the source is called `local`
 * @param {object[]} [options.sources] further sources: { id, list(), get(id) }
 * @param {number} [options.ttl] milliseconds a checked profile is reused for; default 60000
 */
export function createProfiles({ dir, sources: extra = [], ttl = 60000, home, now = () => Date.now() } = {}) {
  const sources = [...(dir ? [fileSource(dir)] : []), ...extra];
  for (const s of sources) if (!ID.test(String(s?.id)) || typeof s.list !== 'function' || typeof s.get !== 'function') throw new TypeError('A profile source needs an id, list() and get(id).');
  const cache = new Map();
  const summary = (source, p) => ({ ref: `${source.id}/${p.id}`, source: source.id, id: p.id, name: str(p.name, 60) || p.id, description: str(p.description) ?? '', ...(str(p.color, 20) ? { color: str(p.color, 20) } : {}) });

  /** Every profile every source offers. A source that fails is reported, and the others still list. */
  async function list() {
    const out = { profiles: [], errors: [] };
    for (const source of sources) {
      try {
        for (const p of await source.list()) if (p && ID.test(String(p.id))) out.profiles.push(summary(source, p));
        // A source that can say which of its entries it had to leave out: each is reported, and the rest still list.
        for (const problem of typeof source.problems === 'function' ? await source.problems() : []) out.errors.push({ source: source.id, error: `${problem.file ?? problem.id}: ${problem.error}` });
      } catch (error) { out.errors.push({ source: source.id, error: String(error.message ?? error) }); }
    }
    return out;
  }

  /** One profile by `source/id`, checked, with its starting context read. */
  async function get(ref, { fresh = false } = {}) {
    const hit = cache.get(ref);
    if (!fresh && hit && now() - hit.t < ttl) return hit.profile;
    try {
      const [sid, id, ...rest] = String(ref).split('/');
      if (rest.length || !ID.test(sid ?? '') || !ID.test(id ?? '')) throw new ProfileError(`A profile is SOURCE/ID, like local/kiefer: ${ref}`);
      const source = sources.find(s => s.id === sid);
      if (!source) throw new ProfileError(`No profile source ${sid}: sources are ${sources.map(s => s.id).join(', ') || '(none)'}.`);
      const profile = checkProfile({ ...(await source.get(id)), id }, `${sid}/${id}`, { home });
      cache.set(ref, { t: now(), profile });
      return profile;
    } catch (error) {
      // A source that hiccups should not strand a conversation in progress: keep the last good profile a while.
      if (!fresh && hit && now() - hit.t < ttl * 30) return hit.profile;
      throw error;
    }
  }

  /**
   * Makes a local profile from a folder: its name, and as starting context the
   * instruction files the folder already has. Checked like any other before it is kept.
   */
  function add({ id, workdir, name, description, instructions, context, model, provider }) {
    if (!dir) throw new ProfileError('This host keeps no local profiles.');
    if (!ID.test(String(id))) throw new ProfileError(`A profile id is letters, digits, - and _: ${id}`);
    if (typeof workdir !== 'string' || !path.isAbsolute(workdir)) throw new ProfileError("workdir: the agent's folder, as an absolute path.");
    const file = path.join(dir, `${id}.json`);
    if (existsSync(file)) throw new ProfileError(`local/${id} already exists: edit ${file}, or choose another name.`);
    const files = Array.isArray(context) && context.length ? context : STARTERS.filter(f => existsSync(path.join(workdir, f))).slice(0, 2);
    const raw = { name: name || id[0].toUpperCase() + id.slice(1), ...(description ? { description } : {}), workdir, ...(instructions ? { instructions } : {}), context: files, ...(model ? { model } : {}), ...(provider ? { provider } : {}) };
    const checked = checkProfile({ ...raw, id }, `local/${id}`, { home });
    writeJson(file, raw);
    return { ...checked, file };
  }

  return { list, get, add, forget: ref => cache.delete(ref), sources: () => sources.map(s => s.id) };
}

/**
 * Which profile each document is bound to, kept in one private JSON file.
 * A document with no binding has the host's general-purpose agent.
 */
export function createBindings({ file }) {
  if (typeof file !== 'string' || !file) throw new TypeError('Give the bindings a file.');
  // A map with no prototype: a document called `constructor` or `__proto__` is a key like any other.
  const load = () => Object.assign(Object.create(null), readJson(file, {}));
  return {
    bound: doc => { const all = load(); return Object.hasOwn(all, doc) && typeof all[doc] === 'string' ? all[doc] : null; },
    all: () => ({ ...load() }),
    bind(doc, ref) {
      if (typeof ref !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,63}$/i.test(ref)) throw new ProfileError(`A profile is SOURCE/ID, like local/kiefer: ${ref}`);
      const all = load(), was = all[doc] ?? null;
      all[doc] = ref; writeJson(file, all);
      return { was, now: ref, changed: was !== ref };
    },
    unbind(doc) { const all = load(), was = all[doc] ?? null; delete all[doc]; if (was) writeJson(file, all); return { was, now: null, changed: !!was }; },
  };
}
