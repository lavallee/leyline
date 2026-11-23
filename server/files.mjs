// Small file helpers shared by the stores in this folder. Everything they write is
// private to the user: folders 0700, files 0600, each replaced whole by a rename.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

/** A file-system name for a host key: the key itself when plainly safe, a hash of it otherwise. */
export const safeName = key => {
  if (typeof key !== 'string' || !key || key.includes('\0')) throw new TypeError('A key is a non-empty string.');
  return SAFE.test(key) ? key : createHash('sha256').update(key).digest('hex').slice(0, 32);
};

/** Writes a file whole: to a temporary name beside it, then renamed into place. */
export function writePrivate(file, data) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try { writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

/** Reads JSON, or returns `fallback` when the file is missing. An unreadable file throws. */
export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export const writeJson = (file, value) => writePrivate(file, JSON.stringify(value, null, 1) + '\n');
