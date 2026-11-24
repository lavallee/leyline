// Server-sent-event parsing: 100,000 small events in network-sized chunks, the same in
// very small chunks, and one large event that arrives a kilobyte at a time.
import { sseEvents } from '../server/providers/http-chat.mjs';
import { bench, ms, perSec, round } from './lib.mjs';

const encoder = new TextEncoder();
async function* chunks(bytes, size) { for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size); }
async function drain(bytes, size) { let n = 0, chars = 0; for await (const event of sseEvents(chunks(bytes, size))) { n++; chars += event.data.length; } return { n, chars }; }

await bench(async ({ row }) => {
  const count = 100000;
  let text = '';
  for (let i = 0; i < count; i++) text += `data: ${JSON.stringify({ id: 'chatcmpl-bench', object: 'chat.completion.chunk', model: 'bench', choices: [{ index: 0, delta: { content: ` word${i}` }, finish_reason: null }] })}\r\n\r\n`;
  const small = encoder.encode(text);
  for (const [size, label] of [[16384, '16 KB chunks'], [64, '64-byte chunks']]) {
    let result; const took = await ms(async () => { result = await drain(small, size); });
    if (result.n !== count) throw new Error(`expected ${count} events, got ${result.n}`);
    row(`sse: 100,000 events, ${label}`, round(took), 'ms');
    row(`sse: 100,000 events, ${label}`, perSec(count, took), 'events/s');
  }
  const large = encoder.encode(`data: ${JSON.stringify({ delta: 'x'.repeat(4_000_000) })}\n\n`);
  let result; const took = await ms(async () => { result = await drain(large, 1024); });
  if (result.n !== 1 || result.chars < 4_000_000) throw new Error('the large event was not read whole');
  row('sse: one 4 MB event in 1 KB chunks', round(took), 'ms');
});
