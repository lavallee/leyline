#!/usr/bin/env node
// One real session through the conversation store and CodexAppServerProvider against the
// signed-in Codex CLI. Not part of `npm test`: it starts `codex app-server` and makes a
// handful of small model calls on the signed-in account.
//
//   node scripts/codex-real-check.mjs                     (codex from PATH)
//   node scripts/codex-real-check.mjs /path/to/codex      (a path instead)
//   CHECKS=a,d node scripts/codex-real-check.mjs          (some of the checks only)
//
// Four checks, each printed as it happens and summed up at the end:
//   (a) a short reply streams: text deltas arrive through tools.text before the turn ends;
//   (b) a steer sent in the middle of a turn of a few steps takes effect;
//   (c) with an approval policy that asks, a write outside the writable roots becomes an
//       ask on the turn, is answered through store.answer(), and the outcome is shown;
//   (d) the store and the provider are closed and made again, and thread/resume keeps the
//       agent's memory (it recalls a word from the turn before the restart).
// Nothing is claimed that was not observed: a check that did not behave as hoped says so
// and the script exits 1. Everything lives in a temporary folder that is removed at the
// end, except the one file check (c) asks the agent to write outside it, which is removed
// too. The only process started is the app-server child, and it is stopped through the
// provider (by its pid).
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createConversationStore } from '../server/conversations.mjs';
import { CodexAppServerProvider } from '../server/providers/codex-app-server.mjs';

const command = [process.argv[2] || 'codex', 'app-server'];
const only = (process.env.CHECKS || 'a,b,c,d').split(',');
const root = await mkdtemp(path.join(os.tmpdir(), 'codex-real-check-'));
const work = path.join(root, 'work'), chats = path.join(root, 'chats');
// Outside the sandbox's writable roots (which include the system temporary folder): a folder of this script's own under the home folder.
const outside = await mkdtemp(path.join(os.homedir(), '.codex-real-check-'));
await mkdir(work, { recursive: true });
const began = Date.now(), at = () => `${((Date.now() - began) / 1000).toFixed(1).padStart(6)}s`;
const say = (...parts) => console.log(at(), ...parts);
const results = {};
const until = async (test, ms, what) => { const end = Date.now() + ms; while (!(await test())) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 50)); } };
const settled = turn => until(() => ['succeeded', 'failed', 'stopped'].includes(turn.status), 240000, 'the turn to finish');

let pids = [];
function host() {
  const provider = new CodexAppServerProvider({ command, workDir: work, clientInfo: { name: 'real-check', title: 'Real check', version: '0.0.0' }, streamBatch: { ms: 40, chars: 400 } });
  const store = createConversationStore({ dir: chats, coalesce: 50, onAsk: () => undefined, askTimeout: 120000,
    steer: (input, turn, lane) => provider.steer(lane.id, input),
    run: async (turn, lane, signal, tools) => {
      const result = await provider.run({ key: lane.id, input: turn.user, effort: 'low', ...tools.resume, ...(tools.payload || {}), onEvent: tools.activity, onText: tools.text, onAsk: tools.ask, signal, timeout: 200000 });
      return { message: result.message, provenance: result.provenance, usage: result.usage };
    } });
  return { provider, store, async close() { const pid = provider.rpc?.proc?.pid; if (pid) pids.push(pid); provider.close(); await store.close(); } };
}

let now = host();
try {
  await now.provider.start();
  say(`app-server started (pid ${now.provider.rpc.proc.pid}); model: ${now.provider.model}`);

  if (only.includes('a')) {
    say('(a) streaming');
    const deltas = [];
    const stop = now.store.subscribe('stream', {}, event => { if (event.type === 'turn.text') { const piece = event.append?.preview ?? event.set?.preview ?? ''; deltas.push({ at: Date.now(), chars: piece.length }); say(`    turn.text +${piece.length} chars: ${JSON.stringify(piece.slice(0, 60))}`); } });
    await stop.ready;
    const turn = await now.store.send('stream', { user: 'Write four short sentences about tide pools. No preamble.' });
    await settled(turn); stop();
    const finished = Date.parse(turn.finishedAt), early = deltas.filter(d => d.at < finished - 100).length;
    say(`    turn ${turn.status}; message of ${turn.message.length} chars; ${deltas.length} text events, ${early} of them more than 100 ms before the turn finished`);
    results.a = { ok: turn.status === 'succeeded' && deltas.length >= 2 && early >= 1, textEvents: deltas.length, beforeTheEnd: early, charsStreamed: deltas.reduce((n, d) => n + d.chars, 0), messageChars: turn.message.length, status: turn.status, failure: turn.status === 'succeeded' ? undefined : turn.message };
  }

  if (only.includes('b')) {
    say('(b) steering');
    // Along the way: with streamOutput, a command's output is passed on while the command runs.
    const appended = [];
    const watching = now.store.subscribe('steer', {}, event => { for (const item of event.activities || []) if (typeof item.append === 'string') appended.push(item.append); });
    await watching.ready;
    const turn = await now.store.send('steer', { payload: { streamOutput: true }, user: 'Run these three shell commands one at a time, each as its own command, waiting for each to finish before the next: `sleep 3; echo one`, then `sleep 3; echo two`, then `sleep 3; echo three`. When all three are done, reply with exactly the word DONE and nothing else.' });
    await until(() => turn.activities.some(a => a.command) || ['succeeded', 'failed', 'stopped'].includes(turn.status), 120000, 'the first command to start');
    say(`    first command seen: ${JSON.stringify(turn.activities.find(a => a.command)?.command)}; steering now`);
    const steered = await now.store.steer('steer', turn.id, 'Change of plan for your final reply: instead of DONE, reply with exactly the word PELICAN and nothing else. Still finish the commands.').catch(error => ({ steered: false, reason: `error: ${error.code} ${error.message}` }));
    say(`    store.steer answered: steered=${steered.steered}${steered.reason ? ` reason=${steered.reason}` : ''}`);
    await settled(turn);
    say(`    turn ${turn.status}; final message: ${JSON.stringify(turn.message.slice(0, 200))}; commands run: ${turn.activities.filter(a => a.command).length}; steers recorded: ${JSON.stringify((turn.steers || []).map(s => s.text.slice(0, 40)))}`);
    watching();
    const outputs = turn.activities.filter(a => a.command).map(a => a.text);
    say(`    command output passed on as it came: ${appended.length} append events ${JSON.stringify(appended.slice(0, 6))}; the items hold ${JSON.stringify(outputs)}`);
    results.b = { ok: steered.steered === true && /PELICAN/i.test(turn.message) && !/\bDONE\b/.test(turn.message), steered: steered.steered, reason: steered.reason, message: turn.message.slice(0, 200), status: turn.status,
      outputAppendEvents: appended.length, outputReadable: appended.join('').includes('one') };
    // And after the turn has ended: the store says so rather than starting something nobody asked for.
    const late = await now.store.steer('steer', turn.id, 'one more thing');
    say(`    a steer after the turn ended answered: steered=${late.steered} reason=${late.reason}`);
    results.b.afterTheEnd = late.reason;
  }

  if (only.includes('c')) {
    say('(c) approval');
    const target = path.join(outside, 'approval-check.txt');
    const asks = [];
    for (const approvalPolicy of ['on-request', 'untrusted']) {
      const key = `approval-${approvalPolicy}`;
      const turn = await now.store.send(key, { user: `Use a shell command to create the file ${target} containing the single word ok. That path is outside your writable folders, so the sandbox will not allow it by itself: request approval to run the command with escalated permissions rather than giving up. Then reply with one sentence saying whether the file was written.`,
        payload: { approvalPolicy, sandbox: { mode: 'workspace-write', cwd: work, writableRoots: [work] } } });
      say(`    approvalPolicy ${approvalPolicy}: waiting for an ask or the end of the turn`);
      let answered = 0;
      while (!['succeeded', 'failed', 'stopped'].includes(turn.status)) {
        const waiting = (turn.asks || []).find(ask => ask.status === 'pending');
        if (waiting) {
          say(`    ask on the turn: kind=${waiting.kind} method=${waiting.method} title=${JSON.stringify(waiting.title)} detail=${JSON.stringify(waiting.detail).slice(0, 300)} options=${waiting.options.map(o => o.id).join('|')}`);
          asks.push({ approvalPolicy, kind: waiting.kind, method: waiting.method, detail: waiting.detail });
          await now.store.answer(key, turn.id, waiting.id, 'accept');
          say('    answered through store.answer(): accept');
          answered++;
        }
        await new Promise(r => setTimeout(r, 100));
        if (Date.now() - Date.parse(turn.createdAt) > 220000) break;
      }
      const written = existsSync(target) ? (await readFile(target, 'utf8')).trim() : null;
      say(`    turn ${turn.status}; asks answered: ${answered}; file ${written === null ? 'was NOT written' : `was written, containing ${JSON.stringify(written)}`}; message: ${JSON.stringify(turn.message.slice(0, 200))}`);
      say(`    asks as recorded: ${JSON.stringify((turn.asks || []).map(a => [a.kind, a.status, a.answer]))}`);
      results.c ||= { attempts: [] };
      results.c.attempts.push({ approvalPolicy, status: turn.status, asks: (turn.asks || []).map(a => ({ kind: a.kind, method: a.method, status: a.status, answer: a.answer })), fileWritten: written !== null, message: turn.message.slice(0, 200) });
      if (answered && written !== null) { results.c.ok = true; break; }
      await rm(target, { force: true });
    }
    results.c.ok ||= false;
  }

  if (only.includes('d')) {
    say('(d) memory across a restart');
    const first = await now.store.send('memory', { user: 'Remember this word for later: heron. Reply with just: OK' });
    await settled(first);
    say(`    before: turn ${first.status}, message ${JSON.stringify(first.message.slice(0, 80))}, thread ${first.provenance?.threadId}, memory=${first.provenance?.memory}`);
    say(`    conversation.memory on the store: ${JSON.stringify(now.store.get('memory').memory)}`);
    const oldPid = now.provider.rpc.proc.pid;
    await now.close();
    await until(() => { try { process.kill(oldPid, 0); return false; } catch { return true; } }, 15000, 'the old app-server to exit');
    now = host();
    await now.provider.start();
    say(`    restarted: old app-server (pid ${oldPid}) has exited; new app-server pid ${now.provider.rpc.proc.pid}; new store on the same folder`);
    const second = await now.store.send('memory', { user: 'What was the word I asked you to remember? Reply with just the word.' });
    await settled(second);
    say(`    after: turn ${second.status}, message ${JSON.stringify(second.message.slice(0, 80))}, thread ${second.provenance?.threadId}, memory=${second.provenance?.memory}, usage ${JSON.stringify(second.usage)}`);
    results.d = { ok: second.provenance?.memory === 'resumed' && /heron/i.test(second.message) && second.provenance.threadId === first.provenance?.threadId, memory: second.provenance?.memory, sameThread: second.provenance?.threadId === first.provenance?.threadId, message: second.message.slice(0, 80), usage: second.usage };
  }
} catch (error) {
  say(`FAILED: ${error.stack || error}`);
  results.error = String(error.message || error);
} finally {
  await now.close().catch(() => {});
  // Only what this script started, by pid, and only if it is somehow still there.
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const pid of pids) {
    await until(() => !alive(pid), 5000, 'the app-server to exit').catch(() => {});
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); say(`killed leftover app-server pid ${pid}`); } catch { /* gone after all */ } } else say(`app-server pid ${pid} exited when the provider closed`);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(outside, { recursive: true, force: true });
}
console.log('\nSummary');
for (const [name, result] of Object.entries(results)) console.log(`  (${name}) ${result.ok === true ? 'observed' : result.ok === false ? 'NOT observed' : ''} ${JSON.stringify(result)}`);
process.exit(Object.values(results).every(result => result.ok !== false) && !results.error ? 0 : 1);
