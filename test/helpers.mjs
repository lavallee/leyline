import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixture = name => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name);
// Things to shut down before a test's temporary folders are removed (a store still
// writing would otherwise race the cleanup).
const closers = new WeakMap();
let latest = null;   // the test that last asked for a folder: tests in a file run one at a time
export function beforeCleanup(fn) { closers.get(latest)?.push(fn); }
export async function tempDir(t, prefix = 'kit-test-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  if (!closers.has(t)) closers.set(t, []);
  latest = t;
  t.after(async () => {
    for (const fn of closers.get(t).splice(0)) await Promise.resolve().then(fn).catch(() => {});
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  });
  return dir;
}
export const readLines = async file => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
export const until = async (test, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await test())) { if (Date.now() > end) throw new Error('Timed out waiting for a condition.'); await new Promise(r => setTimeout(r, 5)); }
};
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
