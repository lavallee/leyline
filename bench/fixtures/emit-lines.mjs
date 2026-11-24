// A child that prints N JSON-RPC notifications of about 220 bytes, as fast as the pipe takes them.
const count = Number(process.argv[2] || 100000);
const line = i => JSON.stringify({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 't1', itemId: `r${i % 50}`, summaryIndex: 0, delta: 'Reading the next paragraph of the draft and deciding what to change in it. '.repeat(2), n: i } }) + '\n';
let i = 0;
(function pump() {
  let block = '';
  for (; i < count && block.length < 65536; i++) block += line(i);
  if (!block) return;
  process.stdout.write(block, pump);
})();
process.stdin.resume();
