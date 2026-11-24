// JSON-RPC line framing: a fake child emits 100,000 notifications and the time runs from
// spawn to the last one being handed to a listener. The child's own work is in the figure.
import { CodexRpc } from '../server/codex-rpc.mjs';
import { bench, ms, perSec, round } from './lib.mjs';

const count = 100000;
await bench(async ({ row }) => {
  const rpc = new CodexRpc({ command: [process.execPath, new URL('./fixtures/emit-lines.mjs', import.meta.url).pathname, String(count)] });
  let seen = 0, bytes = 0, last = -1;
  const took = await ms(() => new Promise((resolve, reject) => {
    rpc.on('notification', message => { seen++; bytes += message.params.delta.length; if (message.params.n !== last + 1) reject(new Error('out of order')); last = message.params.n; if (seen === count) resolve(); });
    rpc.start().on('exit', () => setTimeout(() => reject(new Error(`child exited after ${seen} lines`)), 500));
  }));
  rpc.close();
  row('rpc: 100,000 notifications through the line reader', round(took), 'ms');
  row('rpc: 100,000 notifications through the line reader', perSec(count, took), 'lines/s');
});
