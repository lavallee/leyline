// A child for transport tests. Its behaviour is chosen by the first argument:
//   replay FILE     write FILE's bytes to stdout in the chunk sizes listed in FILE.chunks (JSON), then stay up
//   stderr-flood    write 1 MB to stderr, then answer every request
//   stubborn        ignore SIGTERM and print "ready"
//   idle            print "ready" and stay up without reading stdin
//   echo            answer every request with its params
import { readFileSync, writeFileSync } from 'node:fs';
import readline from 'node:readline';

const [mode, file] = process.argv.slice(2);
const answer = () => readline.createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id !== undefined && m.method) process.stdout.write(JSON.stringify({ id: m.id, result: m.params ?? null }) + '\n');
});
if (process.env.PID_FILE) writeFileSync(process.env.PID_FILE, String(process.pid));
if (mode === 'replay') {
  const bytes = readFileSync(file), sizes = JSON.parse(readFileSync(`${file}.chunks`, 'utf8'));
  let at = 0, i = 0;
  (function next() {
    if (at >= bytes.length) return;
    const size = sizes[i++ % sizes.length];
    process.stdout.write(bytes.subarray(at, at + size), () => (i % 7 ? next() : setImmediate(next)));
    at += size;
  })();
  process.stdin.resume();
} else if (mode === 'stderr-flood') {
  process.stderr.write('e'.repeat(1 << 20), answer);
} else if (mode === 'stubborn' || mode === 'idle') {
  if (mode === 'stubborn') process.on('SIGTERM', () => {});
  process.stdout.write(JSON.stringify({ method: 'ready', params: {} }) + '\n');
  setInterval(() => {}, 1000);
} else answer();
