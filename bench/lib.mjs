// Shared by the benchmark scripts. Each script is run in a process of its own by run.mjs
// and prints one JSON line: { rows: [{ name, value, unit }], rssMb }.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const ms = async fn => { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
export const scratch = () => mkdtemp(path.join(os.tmpdir(), 'leyline-bench-'));
export const round = (value, digits = 2) => Number(value.toPrecision(digits + 2));
export const perSec = (count, millis) => Math.round(count / (millis / 1000));

/** Runs `main(rows)` with a scratch folder that is removed afterwards, then prints the result. */
export async function bench(main) {
  const dir = await scratch(), rows = [];
  try { await main({ dir, row: (name, value, unit) => rows.push({ name, value, unit }) }); }
  finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  process.stdout.write(JSON.stringify({ rows, rssMb: Math.round(process.resourceUsage().maxRSS / 1024) }) + '\n');
}

// Text of a realistic size, the same on every run.
const WORDS = 'the draft opens with a claim about tides and then walks through three examples before it turns to what the reader should do next'.split(' ');
export function prose(chars, seed = 1) {
  let out = '', n = seed;
  while (out.length < chars) { n = (n * 1103515245 + 12345) & 0x7fffffff; out += WORDS[n % WORDS.length] + ' '; }
  return out.slice(0, chars);
}

/** A finished turn as a host like Copycat stores one: about 6 KB. */
export function turnOfRealisticSize(i) {
  const at = new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
  return { id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, user: prose(200, i + 1), status: 'succeeded', createdAt: at, startedAt: at, message: prose(1500, i + 7), live: true, mode: 'fast',
    lane: 'main', activities: Array.from({ length: 12 }, (_, a) => a % 3 === 0
      ? { id: `r${a}`, kind: 'reasoning', text: prose(300, i * 31 + a), status: 'done' }
      : { id: `c${a}`, kind: 'activity', text: prose(250, i * 17 + a), command: `sed -n '1,80p' notes/${a}.md`, status: 'done' }),
    proposals: Array.from({ length: 3 }, (_, p) => ({ key: `e${p}`, file: 'draft.md', find: prose(80, i + p), replace: prose(90, i + p + 3), reason: prose(60, p + 5), ok: true, auto: true, at })),
    provenance: { provider: 'codex-app-server', model: 'bench', threadId: 't1' }, finishedAt: at };
}
