// Small file helpers shared by the stores in this folder. Everything they write is
// private to the user: folders 0700, files 0600, each replaced whole by a rename.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

/** A file-system name for a host key: the key itself when plainly safe, a hash of it otherwise. */
export const safeName = key => {
  if (typeof key !== 'string' || !key || key.includes('\0')) throw new TypeError('A key is a non-empty string.');
  return SAFE.test(key) ? key : createHash('sha256').update(key).digest('hex').slice(0, 32);
};

/**
 * Writes a file whole: to a temporary name beside it, then renamed into place. A reader
 * sees the old file or the new one, never part of either. With `fsync` the bytes are
 * flushed to the disk before the rename and the folder after it, so the file also
 * survives a power cut; without it (the default) it survives the process dying.
 */
export function writePrivate(file, data, { fsync = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      const bytes = typeof data === 'string' ? Buffer.from(data) : data;
      for (let at = 0; at < bytes.length;) at += writeSync(fd, bytes, at, bytes.length - at);
      if (fsync) fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, file);
    if (fsync) try { const dir = openSync(path.dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* not every file system allows it */ }
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Moves a file that could not be used out of the way, under `<file>.<tag>-<time>-<random>`,
 * and returns the new path. Nothing a person wrote is deleted because it would not parse.
 */
export function setAside(file, tag = 'corrupt') {
  const aside = `${file}.${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
  renameSync(file, aside);
  return aside;
}

/** An error for a file that was set aside: `code` is 'corrupt', `file` is where it went. */
export const corruptError = (what, aside) => Object.assign(new Error(`${what} could not be read and was moved aside to ${aside}.`), { code: 'corrupt', file: aside });

/** Reads JSON, or returns `fallback` when the file is missing. An unreadable file throws. */
export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export const writeJson = (file, value, options) => writePrivate(file, JSON.stringify(value, null, 1) + '\n', options);
