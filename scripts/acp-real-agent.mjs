#!/usr/bin/env node
// One small real session through AcpProvider against ACP agents installed on this
// machine. Not part of `npm test`: it starts the real program, which makes one small
// model call on the signed-in account.
//
//   node scripts/acp-real-agent.mjs gemini opencode goose
//   node scripts/acp-real-agent.mjs gemini=/opt/bin/gemini       (a path instead of a PATH lookup)
//
// For each agent: initialize, a new session in an empty temporary folder, the prompt
// "Reply with the single word: ready", the normalised events and the final text, close.
// Permission requests are refused (the default policy) and no file or terminal
// capability is offered. Afterwards any process this script started that is still
// alive is ended by its pid.
import { execFileSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AcpProvider } from '../server/providers/acp.mjs';

const MODES = { gemini: ['--acp'], opencode: ['acp'], goose: ['acp'] };
const PROMPT = 'Reply with the single word: ready';

const onPath = name => {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const file = path.join(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch { /* next */ }
  }
  return null;
};
const children = pid => { try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number); } catch { return []; } };
const family = pid => [pid, ...children(pid).flatMap(family)];
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function session(name, file) {
  console.log(`\n=== ${name}: ${file} ${MODES[name].join(' ')}`);
  const dir = await mkdtemp(path.join(os.tmpdir(), `acp-real-${name}-`));
  const stderr = [], noise = [], updates = {};
  const provider = new AcpProvider({ command: [file, ...MODES[name]], workDir: dir, clientInfo: { name: 'acp-real-agent', version: '0.0.0' },
    onStderr: chunk => stderr.push(String(chunk)), onNoise: line => noise.push(line) });
  let pids = [], outcome;
  try {
    const agent = await provider.start();
    pids = family(provider.rpc.proc.pid);
    console.log('initialize:', JSON.stringify({ protocolVersion: 1, agentInfo: agent.info, agentCapabilities: agent.capabilities, authMethods: agent.authMethods.map(m => ({ id: m.id, type: m.type || 'agent' })) }));
    const started = Date.now();
    const result = await provider.run({ key: 'real', input: PROMPT, timeout: 180000,
      onEvent: event => console.log('event:', JSON.stringify(event).slice(0, 400)),
      onText: (piece, at) => console.log('text:', JSON.stringify(piece), `segment ${at.segment}`),
      onDiff: diff => console.log('diff:', JSON.stringify(diff).slice(0, 400)),
      onUpdate: update => { updates[update.sessionUpdate] = (updates[update.sessionUpdate] || 0) + 1; } });
    pids = [...new Set([...pids, ...family(provider.rpc?.proc?.pid ?? pids[0])])];
    console.log('session/update kinds:', JSON.stringify(updates));
    console.log('final text:', JSON.stringify(result.message));
    console.log('provenance:', JSON.stringify(result.provenance));
    console.log('usage:', JSON.stringify(result.usage ?? null), `(${Date.now() - started} ms)`);
    outcome = `ok: replied ${JSON.stringify(result.message.trim().slice(0, 80))}`;
  } catch (error) {
    console.log('session/update kinds:', JSON.stringify(updates));
    outcome = `${error.code || error.name}: ${error.message}`;
  }
  if (noise.length) console.log(`stdout lines that were not protocol messages (${noise.length}):`, JSON.stringify(noise.slice(0, 5)).slice(0, 600));
  const said = stderr.join('').trim();
  if (said) console.log(`stderr (${said.length} characters, the end of it):`, JSON.stringify(said.slice(-600)));
  provider.close();
  for (let waited = 0; waited < 5000 && pids.some(alive); waited += 100) await wait(100);
  const left = pids.filter(alive);
  for (const pid of left) { try { process.kill(pid); } catch { /* gone */ } }
  console.log(left.length ? `closed; ${left.length} process(es) outlived the close and were ended by pid: ${left.join(', ')}` : 'closed; every process this run started has exited');
  await rm(dir, { recursive: true, force: true });
  console.log(`result ${name}: ${outcome}`);
  return outcome;
}

const asked = process.argv.slice(2);
if (!asked.length) { console.error(`Name the agents to run: ${Object.keys(MODES).join(', ')}`); process.exit(2); }
const results = {};
for (const item of asked) {
  const [name, given] = item.split('=');
  if (!MODES[name]) { results[item] = 'unknown agent'; continue; }
  const file = given || onPath(name);
  results[name] = !file || !path.isAbsolute(file) ? 'not installed (not found on PATH)' : await session(name, file);
}
console.log('\n=== summary'); for (const [name, outcome] of Object.entries(results)) console.log(`${name}: ${outcome}`);
