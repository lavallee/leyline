// History: the states a document has been in, one whole snapshot at a time, so anyone
// can step back through them and restore any point. Generalised from Toucan's
// server/versions.mjs.
//
// The document is opaque here. The host passes `data` (text or any JSON value) and,
// when it can, `parts`: a map of part name -> comparable text (a shape, a file, a post).
// Parts are used to skip saves that change nothing and to say what each version changed.
// A part whose name starts with ~ counts as a change but is not reported. Without
// `parts`, the whole of `data` is one unnamed part.
//
// Restoring never loses anything: the current state is saved first, and a restore is a
// new version too.
//
// Checkpoints tie a version to a request (an agent's turn), so "undo everything from
// this request" is restore(checkpoint). That puts back the whole document as it was
// when the request began, including undoing what people did meanwhile; when a host can
// reverse the request's individual edits instead, ./proposals.mjs does that and keeps
// other people's work.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { safeName, writePrivate, writeJson, setAside, corruptError } from './files.mjs';

const HOUR = 36e5, DAY = 24 * HOUR;
const KEEP_KEYS = 12;
const digest = text => createHash('sha256').update(text).digest('base64url').slice(0, 22);
const visible = parts => Object.keys(parts).filter(k => !k.startsWith('~'));

/** What changed between two `parts` maps: added, updated and removed names. */
export function diffParts(before, after) {
  const added = [], updated = [], removed = [];
  for (const k of visible(after)) (!Object.hasOwn(before, k) ? added : before[k] !== after[k] ? updated : null)?.push(k);
  for (const k of visible(before)) if (!Object.hasOwn(after, k)) removed.push(k);
  return { added, updated, removed };
}

/**
 * Which versions to drop, oldest decisions first. Automatic versions thin as they age:
 * every one for a day, then the last of each hour for a week, then the last of each day.
 * Named versions, restores, pinned checkpoints and the newest version stay. Over the
 * size cap, the oldest automatic versions go first, whatever their age.
 */
export function prunable(versions, { now = Date.now(), maxBytes = Infinity, pinned = new Set() } = {}) {
  const gone = new Set(), seen = new Set();
  const kept = v => v.named || v.source === 'restore' || pinned.has(v.n);
  for (let i = versions.length - 2; i >= 0; i--) {
    const v = versions[i], at = Date.parse(v.t), age = now - at;
    if (kept(v) || age < DAY) continue;
    const bucket = age < 7 * DAY ? `h${Math.floor(at / HOUR)}` : `d${Math.floor(at / DAY)}`;
    if (seen.has(bucket)) gone.add(v.n); else seen.add(bucket);
  }
  let total = versions.reduce((sum, v) => sum + (gone.has(v.n) ? 0 : v.size ?? 0), 0);
  for (const v of versions.slice(0, -1)) {
    if (total <= maxBytes) break;
    if (gone.has(v.n) || kept(v)) continue;
    gone.add(v.n); total -= v.size ?? 0;
  }
  return versions.filter(v => gone.has(v.n));
}

/**
 * @param {object} options
 * @param {string} options.dir each document's history is kept in `<dir>/<key>/`
 * @param {number} [options.maxBytes] size cap per document, compressed; default 500 MB
 * @param {number} [options.keepCheckpoints] request checkpoints kept per document; default 50
 * @param {boolean} [options.fsync] flush every file to the disk before it replaces the old one; default false
 * @param {(error: Error) => void} [options.onError] told when an index could not be parsed and was moved aside
 *   (`error.code` is 'corrupt', `error.file` where it went). The index is then rebuilt from the version files.
 * @param {() => number} [options.now]
 */
export function createHistory({ dir, maxBytes = 500e6, keepCheckpoints = 50, fsync = false, onError = () => {}, now = () => Date.now() } = {}) {
  if (typeof dir !== 'string' || !dir) throw new TypeError('Give the history a directory.');
  const folder = key => path.join(dir, safeName(key));
  const indexFile = key => path.join(folder(key), 'index.json');
  const versionFile = (key, n) => path.join(folder(key), `${n}.json.gz`);
  // The index of each document is kept in memory for as long as the file on disk is the
  // one it was read from or written as (same inode, size and time), so another process
  // writing the same folder is still seen. Reading and parsing it afresh on every call is
  // what made each operation slower as versions accumulated.
  const cache = new Map();   // key -> { stamp, store }
  const stampOf = file => { try { const s = statSync(file); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch { return null; } };
  const remember = (key, store) => { cache.delete(key); cache.set(key, { stamp: stampOf(indexFile(key)), store }); if (cache.size > 200) cache.delete(cache.keys().next().value); };
  // An index rebuilt from the version files that are there: numbers, sizes and times
  // survive; labels, checkpoints and what each version changed do not.
  function rebuild(key) {
    const versions = [];
    for (const name of existsSync(folder(key)) ? readdirSync(folder(key)) : []) {
      const n = /^(\d+)\.json\.gz$/.exec(name)?.[1]; if (!n) continue;
      const info = statSync(path.join(folder(key), name));
      versions.push({ n: Number(n), t: new Date(info.mtimeMs).toISOString(), source: 'recovered', hash: null, size: info.size, count: 0, added: 0, updated: 0, removed: 0, keys: [] });
    }
    versions.sort((a, b) => a.n - b.n);
    return { next: (versions.at(-1)?.n ?? 0) + 1, versions, digests: {}, checkpoints: [] };
  }
  function load(key) {
    const file = indexFile(key), stamp = stampOf(file), hit = cache.get(key);
    if (hit && stamp && hit.stamp === stamp) return hit.store;
    let store = { next: 1, versions: [], digests: {}, checkpoints: [] };
    if (stamp) {
      let read = null;
      try { read = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (read && typeof read === 'object' && Array.isArray(read.versions) && Number.isInteger(read.next)) store = { ...read, versions: read.versions.filter(v => v && Number.isInteger(v.n)) };
      else {
        const aside = setAside(file);
        store = rebuild(key);
        writeJson(file, store, { fsync });
        try { onError(corruptError('A history index', aside)); } catch { /* a host's handler must not break the history */ }
      }
    }
    remember(key, store);
    return store;
  }
  // Runs a change against the index. If it fails part-way the copy in memory is dropped,
  // so the next call starts from what is really on disk.
  const changing = (key, fn) => { const store = load(key); try { return fn(store); } catch (error) { cache.delete(key); throw error; } };
  const partsOf = state => state.parts && typeof state.parts === 'object' ? state.parts : { '~': typeof state.data === 'string' ? state.data : JSON.stringify(state.data ?? null) };
  const digests = parts => Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, digest(String(v))]));
  const hashOf = d => digest(Object.keys(d).sort().map(k => `${k}\0${d[k]}`).join('\0'));
  const publicView = ({ hash, ...version }) => version;

  function write(key, store, state, { label, source = 'edit', named = false, request, force = false }) {
    const current = digests(partsOf(state)), hash = hashOf(current), last = store.versions.at(-1);
    if (last?.hash === hash && !force) {
      if (!named) return null;
      Object.assign(last, { label: String(label ?? last.label ?? '').slice(0, 200), named: true });
      return last;
    }
    const n = store.next++;
    const bytes = gzipSync(JSON.stringify({ data: state.data }));
    writePrivate(versionFile(key, n), bytes, { fsync });
    const changed = diffParts(store.digests ?? {}, current);
    const version = { n, t: new Date(now()).toISOString(), source, hash, size: bytes.length, count: visible(current).length,
      added: changed.added.length, updated: changed.updated.length, removed: changed.removed.length,
      keys: [...changed.added, ...changed.updated, ...changed.removed].slice(0, KEEP_KEYS),
      ...(label ? { label: String(label).slice(0, 200) } : {}), ...(named ? { named: true } : {}), ...(request ? { request: String(request).slice(0, 120) } : {}) };
    store.digests = current;
    store.versions.push(version);
    return version;
  }
  function commit(key, store) {
    store.checkpoints = (store.checkpoints ?? []).slice(-keepCheckpoints);
    const pinned = new Set(store.checkpoints.map(c => c.n));
    for (const gone of prunable(store.versions, { now: now(), maxBytes, pinned })) {
      rmSync(versionFile(key, gone.n), { force: true });
      store.versions.splice(store.versions.indexOf(gone), 1);
    }
    writeJson(indexFile(key), store, { fsync });
    remember(key, store);
  }

  /**
   * Saves a version. Returns it, or null when nothing changed since the last one. A
   * `named` save of an unchanged document labels the latest version instead of copying it.
   * @param {string} key
   * @param {{data: any, parts?: Record<string, string>, label?: string, source?: string, named?: boolean}} state
   */
  const save = (key, state) => changing(key, store => {
    const version = write(key, store, state, state);
    if (version) commit(key, store);
    return version && publicView(version);
  });

  /** Versions, newest first. */
  const list = key => load(key).versions.map(publicView).reverse();

  /** One version with its data, or null. */
  function read(key, n) {
    const version = load(key).versions.find(v => v.n === Number(n));
    if (!version || !existsSync(versionFile(key, version.n))) return null;
    // A version file that is damaged is the same to a caller as one that is gone.
    try { return { ...publicView(version), data: JSON.parse(gunzipSync(readFileSync(versionFile(key, version.n)))).data }; } catch { return null; }
  }

  /** Is this state the same as the latest version? */
  const isCurrent = (key, state) => load(key).versions.at(-1)?.hash === hashOf(digests(partsOf(state)));

  /**
   * Goes back to version `n`. Pass the document as it is now in `current`: it is saved
   * first if it differs from the latest version. Returns the data to put back and the new
   * version that records the restore; the host applies the data to its document.
   */
  function restore(key, n, { current, label, parts } = {}) {
    const target = read(key, n);
    if (!target) throw new RangeError(`There is no version ${n}.`);
    return changing(key, store => {
      if (current) write(key, store, current, { source: 'before-restore', label: 'Before a restore' });
      const version = write(key, store, { data: target.data, parts }, { source: 'restore', label: label || `Restored version ${target.n}`, force: true });
      // Without parts for the restored state its digests are unknown: the next save compares afresh.
      if (!parts) store.digests = { '~': digest(typeof target.data === 'string' ? target.data : JSON.stringify(target.data ?? null)) };
      commit(key, store);
      return { data: target.data, version: publicView(version), from: publicView(target) };
    });
  }

  /**
   * Marks the document's state as a request begins. Saves a version if the state is not
   * already the latest one, and remembers which version the request started from.
   */
  function checkpoint(key, request, state, { label } = {}) {
    if (typeof request !== 'string' || !request) throw new TypeError('A checkpoint needs the id of its request.');
    return changing(key, store => {
      const version = write(key, store, state, { source: 'checkpoint', label: label || 'Before a request', request }) ?? store.versions.at(-1);
      store.checkpoints = [...(store.checkpoints ?? []).filter(c => c.request !== request), { request, n: version.n, t: new Date(now()).toISOString() }];
      commit(key, store);
      return publicView(version);
    });
  }

  /** The version a request started from, or null. */
  const checkpointOf = (key, request) => { const found = load(key).checkpoints?.find(c => c.request === request); return found ? read(key, found.n) : null; };

  /**
   * Undoes everything since a request began: restores its checkpoint. Refuses, with a
   * RangeError, when there is no checkpoint for it (it has aged out, or was never taken).
   */
  function undoRequest(key, request, { current, parts } = {}) {
    const found = load(key).checkpoints?.find(c => c.request === request);
    if (!found) throw new RangeError('There is no checkpoint for that request.');
    return restore(key, found.n, { current, parts, label: 'Undid a request' });
  }

  /** Forgets a document's whole history. */
  const forget = key => { cache.delete(key); rmSync(folder(key), { recursive: true, force: true }); };

  return { save, list, read, isCurrent, restore, checkpoint, checkpointOf, undoRequest, forget };
}
