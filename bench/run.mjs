#!/usr/bin/env node
// npm run bench: runs each benchmark in a process of its own (so peak memory is that
// benchmark's alone), three times, and prints a table of the best time of the three.
//   node bench/run.mjs                    print the table
//   node bench/run.mjs --json FILE        also keep the figures
//   node bench/run.mjs --against FILE     add a column comparing with figures kept earlier
//   node bench/run.mjs --only store       run the scripts whose name contains this
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const RUNS = Number(option('--runs') || 3);
const SCRIPTS = [['store-activity', '1'], ['store-activity', '100'], ['store-activity', '1000'], ['store-activity', '10000'], ['store-load'], ['store-large'],
  ['rpc-framing'], ['sse'], ['proposals'], ['history'], ['activity-feed']].filter(([name]) => !option('--only') || name.includes(option('--only')));
// For these units a larger figure is better; for the rest a smaller one is.
const HIGHER = /\/s$/;
const NOT_TIMED = ['KB', 'versions'];

const results = new Map();   // "name|unit" -> { name, unit, value, rssMb }
for (const [script, ...rest] of SCRIPTS) {
  for (let run = 0; run < RUNS; run++) {
    const out = execFileSync(process.execPath, [fileURLToPath(new URL(`./${script}.mjs`, import.meta.url)), ...rest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 24 });
    const { rows, rssMb } = JSON.parse(out.trim().split('\n').at(-1));
    for (const row of rows) {
      const id = `${row.name}|${row.unit}`, was = results.get(id);
      const better = !was || (HIGHER.test(row.unit) ? row.value > was.value : row.value < was.value);
      results.set(id, { ...row, value: better ? row.value : was.value, rssMb: Math.max(rssMb, was?.rssMb ?? 0) });
    }
  }
  process.stderr.write(`${script} ${rest.join(' ')} done\n`);
}

const before = option('--against') ? new Map(JSON.parse(readFileSync(option('--against'), 'utf8')).results.map(r => [`${r.name}|${r.unit}`, r])) : null;
const show = value => value >= 100 ? Math.round(value).toLocaleString('en') : String(value);
const lines = [before ? '| Benchmark | Before | After | Unit | Change | Peak RSS before | Peak RSS after |' : '| Benchmark | Result | Unit | Peak RSS |',
  before ? '|---|---:|---:|---|---:|---:|---:|' : '|---|---:|---|---:|'];
for (const r of results.values()) {
  if (!before) { lines.push(`| ${r.name} | ${show(r.value)} | ${r.unit} | ${r.rssMb} MB |`); continue; }
  const was = before.get(`${r.name}|${r.unit}`);
  const ratio = !was || NOT_TIMED.includes(r.unit) || !was.value || !r.value ? null : HIGHER.test(r.unit) ? r.value / was.value : was.value / r.value;
  const change = !was ? 'new' : NOT_TIMED.includes(r.unit) ? (r.value === was.value ? 'same' : `${show(was.value)} → ${show(r.value)}`) : ratio === null ? '' : ratio >= 1.1 ? `${ratio.toFixed(ratio >= 10 ? 0 : 1)}× faster` : ratio <= 0.9 ? `${(1 / ratio).toFixed(1)}× slower` : 'same (within 10%)';
  lines.push(`| ${r.name} | ${was ? show(was.value) : ''} | ${show(r.value)} | ${r.unit} | ${change} | ${was ? `${was.rssMb} MB` : ''} | ${r.rssMb} MB |`);
}
const machine = { node: process.version, cpus: os.availableParallelism(), os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model, memoryGb: Math.round(os.totalmem() / 2 ** 30) };
console.log(`Node ${machine.node}, ${machine.cpus} CPUs (${machine.cpu}), ${machine.os}, ${machine.memoryGb} GB. Best of ${RUNS} runs; each script in its own process.\n`);
console.log(lines.join('\n'));
if (option('--json')) writeFileSync(option('--json'), JSON.stringify({ machine, runs: RUNS, results: [...results.values()] }, null, 1) + '\n');
