// A stand-in runner for test/dispatch.test.mjs. Each call is appended to $RUNNER_LOG; what it
// answers comes from $RUNNER_SCRIPT, a JSON file: { submit: {...} | "fail:words" | "garbage", status: …, cancel: … }.
import { appendFileSync, readFileSync } from 'node:fs';
const operation = process.argv.at(-1);
const input = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(process.env.RUNNER_LOG, JSON.stringify({ operation, input }) + '\n');
const script = JSON.parse(readFileSync(process.env.RUNNER_SCRIPT, 'utf8'));
const reply = script[operation];
if (typeof reply === 'string' && reply.startsWith('fail:')) { console.error(reply.slice(5)); process.exit(3); }
if (reply === 'garbage') { console.log('not json'); process.exit(0); }
console.log(JSON.stringify(reply ?? { id: input.id, status: 'running' }));
