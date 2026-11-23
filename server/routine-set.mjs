// Routines: chores written once and run again, from a menu, a slash command or a CLI.
// ./routine-bank.mjs is the storage; this is everything the three hosts built around it:
// a shipped set merged with what people and agents banked, kinds for grouping, `when`
// and `args` notes that tell an agent when to reach for one, slash-name resolution,
// turning a routine into a request, validated save, and remove with an archive.
//
// What a routine's `code` is belongs to the host: a prompt for an agent (Copycat, Skein)
// or a program run on a canvas (Toucan). This module never runs it.
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createRoutineBank } from './routine-bank.mjs';

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SLASH = /^\/([a-z0-9][a-z0-9_-]{0,63})$/i;
const HEADER_FIELDS = ['routine', 'description', 'engines', 'kind', 'when', 'args'];
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const oneLine = value => String(value).replace(/\s+/g, ' ').trim();

/** An error fit to show a person. `code`: 'invalid' | 'not-found'. */
export class RoutineError extends Error {
  constructor(message, code = 'invalid') { super(message); this.name = 'RoutineError'; this.code = code; this.status = code === 'not-found' ? 404 : 400; }
}

/** The JSON file format Copycat and Skein use: { title, description, code, engines, kind?, when?, args? }. */
export const jsonFormat = {
  extension: '.json',
  parse: (name, body) => ({ name, ...JSON.parse(body) }),
  compose: parts => JSON.stringify(parts, null, 2),
};

/**
 * The comment-header format Toucan uses, for routines that are code:
 *
 *   // routine: Tidy arrows
 *   // description: Re-route arrows so fewer cross.
 *   // engines: tldraw
 *   // kind: arrows
 *   // when: Arrows run through boxes.
 *   // args: maxBend (px)
 *
 * Every field is optional. The code keeps its own header except for the fields passed to compose.
 */
export function headerFormat({ extension = '.js', comment = '//' } = {}) {
  const mark = comment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const HEADER = new RegExp(`^${mark} (${HEADER_FIELDS.join('|')}):[ \\t]*(.*)$`);
  const head = source => {
    const lines = source.split('\n'), meta = {};
    let start = 0;
    while (start < lines.length && (lines[start].startsWith(comment) || !lines[start].trim())) {
      const m = HEADER.exec(lines[start]); if (m) meta[m[1]] = m[2].trim();
      start++;
    }
    return { lines, start, meta };
  };
  return {
    extension,
    parse(name, source) {
      const { meta } = head(source);
      return { name, title: meta.routine || name, description: meta.description ?? '', kind: meta.kind, when: meta.when ?? '', args: meta.args ?? '',
        ...(meta.engines ? { engines: meta.engines.split(/[,\s]+/).filter(Boolean) } : {}), code: source };
    },
    compose({ title, description, engines, kind, when, args, code }) {
      const { lines, start, meta } = head(code);
      const fields = { routine: title ?? meta.routine, description: description ?? meta.description, engines: engines?.join(', ') ?? meta.engines, kind: kind ?? meta.kind, when: when ?? meta.when, args: args ?? meta.args };
      const top = HEADER_FIELDS.filter(k => fields[k]).map(k => `${comment} ${k}: ${oneLine(fields[k])}`);
      const body = [...lines.slice(0, start).filter(l => !HEADER.test(l)), ...lines.slice(start)].join('\n').replace(/^\n+/, '');
      return `${top.join('\n')}${top.length ? '\n\n' : ''}${body}`;
    },
  };
}

/**
 * @param {object} options
 * @param {object[]} [options.shipped] routines the host ships, as objects: { name, title, description, code, engines?, kind?, when?, args? }
 * @param {string} [options.shippedDir] or as files in a folder, in `format`
 * @param {string} options.bankedDir where people's and agents' own routines are kept
 * @param {object} [options.format] jsonFormat (default) or headerFormat()
 * @param {string[]} [options.engines] the engines this host has, such as ['page'] or ['tldraw', 'excalidraw'].
 *   A routine that names none runs on all of them; unknown names are dropped.
 * @param {{id: string, label: string, about?: string}[]} [options.kinds] groups, in menu order. A routine with no kind, or an unknown one, gets the last.
 * @param {{title?: number, description?: number, code?: number, note?: number}} [options.limits]
 */
export function createRoutineSet({ shipped = [], shippedDir, bankedDir, format = jsonFormat, engines = [], kinds = [], limits = {} } = {}) {
  if (typeof bankedDir !== 'string' || !bankedDir) throw new TypeError('Give the routine set a folder for banked routines.');
  const max = { title: 100, description: 500, code: 12000, note: 500, ...limits };
  const kindIds = kinds.map(k => k.id), fallbackKind = kindIds.at(-1);
  const bank = createRoutineBank({ shipped: shippedDir, banked: bankedDir, extension: format.extension, parse: format.parse, compose: format.compose });
  const shape = (r, source) => {
    const named = Array.isArray(r.engines) ? r.engines.filter(e => !engines.length || engines.includes(e)) : [];
    return { ...r, title: r.title || r.name, description: r.description ?? '', when: r.when ?? '', args: r.args ?? '',
      engines: named.length ? named : [...engines], ...(kinds.length ? { kind: kindIds.includes(r.kind) ? r.kind : fallbackKind } : {}), source: r.source || source };
  };

  /** Every routine, banked over shipped of the same name, sorted by title. Filter with { engine, kind }. */
  function list({ engine, kind } = {}) {
    const all = new Map(shipped.map(r => [r.name, shape(r, 'shipped')]));
    for (const r of bank.list()) all.set(r.name, shape(r, r.source));
    return [...all.values()].filter(r => (!engine || r.engines.includes(engine)) && (!kind || r.kind === kind)).sort((a, b) => a.title.localeCompare(b.title));
  }
  const get = name => list().find(r => r.name === name) ?? null;

  /**
   * Reads a message as a slash command. Returns null when it is not one (`/name` alone on
   * the line), the routine when it names one, and throws RoutineError('not-found') otherwise.
   */
  function resolve(message, { engine } = {}) {
    const slash = SLASH.exec(String(message ?? '').trim());
    if (!slash) return null;
    const routine = list({ engine }).find(r => r.name === slash[1].toLowerCase());
    if (!routine) throw new RoutineError('That routine is not in the bank.', 'not-found');
    return routine;
  }

  /**
   * A message as the request to run: a routine's title is what the person sees and its
   * code is what the agent is given; anything else is passed through.
   * @returns {{user: string, prompt: string, routine?: string}}
   */
  function turnFor(message, options) {
    const routine = resolve(message, options), plain = String(message ?? '').trim();
    return routine ? { user: routine.title, prompt: routine.code, routine: routine.name } : { user: plain, prompt: plain };
  }

  /** Banks a routine. Banking under a shipped routine's name replaces it for this host. */
  function save(name, { title, description, code, prompt, engines: named, kind, when, args } = {}) {
    const body = code ?? prompt;
    if (!NAME.test(name || '')) throw new RoutineError('A routine name is lower-case letters, digits, - and _.');
    if (!text(title, max.title) || !title.trim() || !text(body, max.code) || !body.trim() || !text(description ?? '', max.description) || !text(when ?? '', max.note) || !text(args ?? '', max.note))
      throw new RoutineError('Enter a valid routine name, title and prompt.');
    if (named !== undefined && (!Array.isArray(named) || named.some(e => engines.length && !engines.includes(e)))) throw new RoutineError(`Engines are: ${engines.join(', ')}.`);
    if (kind !== undefined && kinds.length && !kindIds.includes(kind)) throw new RoutineError(`Kinds are: ${kindIds.join(', ')}.`);
    // Only what was passed is written: a format that keeps metadata in the code itself
    // (headerFormat) then keeps the code's own values for the rest.
    const parts = { title: title.trim(), description, code: body, engines: named?.length ? named : undefined, kind, when: when || undefined, args: args || undefined };
    return shape(bank.save(name, parts), 'banked');
  }

  /**
   * Takes a banked routine out of the menu. Its file moves to `archive/` rather than being
   * deleted. Removing one that replaced a shipped routine brings the shipped one back.
   * @returns {{removed: boolean, restored: object|null}}
   */
  function remove(name) {
    if (!NAME.test(name || '')) throw new RoutineError('Invalid routine name.');
    const file = path.join(bankedDir, name + format.extension);
    if (!existsSync(file)) return { removed: false, restored: null };
    const archive = path.join(bankedDir, 'archive'); mkdirSync(archive, { recursive: true, mode: 0o700 });
    renameSync(file, path.join(archive, `${name}-${randomUUID().slice(0, 8)}${format.extension}`));
    return { removed: true, restored: get(name) };
  }

  /** Routines grouped by kind, in the order the kinds were given, leaving out empty groups. */
  const byKind = options => kinds.map(k => ({ ...k, routines: list({ ...options, kind: k.id }) })).filter(g => g.routines.length);

  return { list, get, resolve, turnFor, save, remove, byKind, kinds, engines };
}
