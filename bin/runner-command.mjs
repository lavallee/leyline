#!/usr/bin/env node
// The reference runner for docs/dispatch.md: each job runs one configured command (a coding
// agent's CLI, say) with the job's brief on stdin, in the job's `where.root`, and is kept in a
// folder of its own under the state directory: what it was given, what it printed, how it
// ended. Both come from the environment the host starts this with, never from a job:
//
//   DISPATCH_RUNNER_COMMAND  the command, as a JSON array: ["codex","exec","--full-auto","-"]
//   DISPATCH_RUNNER_STATE    where jobs are kept (default ~/.local/state/dispatch-runner)
//
// Operations: submit, status, cancel (the contract), and run, which this runner starts for
// itself in the background so that submit can answer at once.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE = process.env.DISPATCH_RUNNER_STATE || path.join(os.homedir(), '.local/state/dispatch-runner');
const operation = process.argv[2];
const fail = message => { process.stderr.write(`${message}\n`); process.exit(1); };
const answer = value => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const folder = id => path.join(STATE, 'jobs', id);
const read = (id, name) => { try { return JSON.parse(readFileSync(path.join(folder(id), name), 'utf8')); } catch { return null; } };
const write = (id, name, value) => { const file = path.join(folder(id), name); writeFileSync(`${file}.tmp`, JSON.stringify(value)); renameSync(`${file}.tmp`, file); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const input = () => { try { return JSON.parse(readFileSync(0, 'utf8')); } catch { fail('Give one JSON object on stdin.'); } };
const idOf = given => typeof given === 'string' && /^[a-f0-9]{24}$/.test(given) ? given : fail('There is no such job.');

function command() {
  let parsed;
  try { parsed = JSON.parse(process.env.DISPATCH_RUNNER_COMMAND || ''); } catch { fail('Set DISPATCH_RUNNER_COMMAND to the command to run, as a JSON array.'); }
  if (!Array.isArray(parsed) || !parsed.length || parsed.some(p => typeof p !== 'string' || !p)) fail('DISPATCH_RUNNER_COMMAND must be a JSON array of strings.');
  return parsed;
}

/** What the job's command is told: the brief, where it came from, and where it may work. */
function prompt(job) {
  const lines = [job.title ? `# ${job.title}` : '', job.brief || ''];
  if (job.from?.quote) lines.push('', `It was sent from ${job.from.document || 'a document'}${job.from.file ? ` (${job.from.file})` : ''}, about this passage:`, '', job.from.quote.split('\n').map(l => `> ${l}`).join('\n'));
  if (job.where?.paths?.length) lines.push('', `Work only in: ${job.where.paths.join(', ')}.`);
  lines.push('', 'When you finish, end with a short account of what you did and anything a person must check.');
  return lines.filter((l, i) => l || i).join('\n');
}

/** Where a job is, from its folder. */
function status(id) {
  const job = read(id, 'job.json');
  if (!job) fail('There is no such job.');
  const ended = read(id, 'exit.json'), run = read(id, 'run.json');
  const base = { id, ...(job.link ? { link: job.link } : {}) };
  if (read(id, 'cancelled.json')) return { ...base, status: 'cancelled', summary: 'Cancelled.' };
  if (ended) {
    let output = '';
    try { output = readFileSync(path.join(folder(id), 'output.log'), 'utf8'); } catch { /* nothing printed */ }
    const tail = output.trim().split(/\n\s*\n/).at(-1)?.trim().slice(-2000) || '';
    return ended.code === 0
      ? { ...base, status: 'done', summary: tail.slice(0, 300) || 'Done.', result: { message: tail || 'The command finished without output.' } }
      : { ...base, status: 'failed', summary: `The command ended with exit ${ended.code}${ended.signal ? ` (${ended.signal})` : ''}.`, result: { message: output.trim().split('\n').slice(-20).join('\n').slice(-2000) } };
  }
  if (run && !alive(run.pid)) return { ...base, status: 'failed', summary: 'The command stopped without saying how it ended.' };
  return { ...base, status: run ? 'running' : 'queued' };
}

if (operation === 'submit') {
  const job = input();
  if (job.v !== 1) fail('This runner speaks version 1 of the contract.');
  if (typeof job.key !== 'string' || !job.key || typeof job.brief !== 'string') fail('A job needs a key and a brief.');
  command();   // refuse at once, not in the background, when the command is not set
  const id = createHash('sha256').update(job.key).digest('hex').slice(0, 24);
  // The same key again is the same job.
  if (!existsSync(path.join(folder(id), 'job.json'))) {
    mkdirSync(folder(id), { recursive: true, mode: 0o700 });
    write(id, 'job.json', { key: job.key, title: job.title, brief: job.brief, from: job.from || {}, where: job.where || {}, by: job.by, at: new Date().toISOString() });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', id], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  }
  answer(status(id));
} else if (operation === 'status') {
  answer(status(idOf(input().id)));
} else if (operation === 'cancel') {
  const id = idOf(input().id), run = read(id, 'run.json');
  if (!read(id, 'job.json')) fail('There is no such job.');
  if (!read(id, 'exit.json')) {
    write(id, 'cancelled.json', { at: new Date().toISOString() });
    if (run && alive(run.pid)) try { process.kill(-run.pid, 'SIGTERM'); } catch { try { process.kill(run.pid, 'SIGTERM'); } catch { /* gone */ } }
  }
  answer(status(id));
} else if (operation === 'run') {
  const id = idOf(process.argv[3]), job = read(id, 'job.json');
  if (!job || read(id, 'run.json')) process.exit(0);
  const [file, ...args] = command();
  const cwd = typeof job.where?.root === 'string' && existsSync(job.where.root) ? job.where.root : folder(id);
  const log = openSync(path.join(folder(id), 'output.log'), 'a', 0o600);
  const child = spawn(file, args, { cwd, stdio: ['pipe', log, log], detached: true, env: process.env });
  write(id, 'run.json', { pid: child.pid, cwd, at: new Date().toISOString() });
  child.stdin.on('error', () => {});
  child.stdin.end(prompt(job));
  child.on('error', error => { write(id, 'exit.json', { code: 127, error: error.message, at: new Date().toISOString() }); });
  child.on('exit', (code, signal) => { if (!existsSync(path.join(folder(id), 'exit.json'))) write(id, 'exit.json', { code: code ?? 1, signal, at: new Date().toISOString() }); });
} else fail(`This runner knows submit, status and cancel, not ${operation || 'nothing'}.`);
