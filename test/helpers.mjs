import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixture = name => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name);
export async function tempDir(t, prefix = 'agent-chat-test-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export const readLines = async file => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
export const until = async (test, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await test())) { if (Date.now() > end) throw new Error('Timed out waiting for a condition.'); await new Promise(r => setTimeout(r, 5)); }
};
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
