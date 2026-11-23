// A stand-in for a one-shot agent command: prompt on stdin, answer on stdout.
// "sleep" in the prompt makes it wait; "exit" makes it fail; "fenced" wraps the JSON.
let input = '';
process.stdin.on('data', d => { input += d; });
process.stdin.on('end', () => {
  if (input.includes('sleep')) return setTimeout(() => {}, 60000);
  if (input.includes('exit')) { process.stderr.write('could not do it'); process.exit(3); }
  const answer = JSON.stringify({ summary: `read ${input.length} characters`, cwd: process.cwd(), env: Object.keys(process.env).sort() });
  process.stdout.write(input.includes('fenced') ? 'Here you go:\n```json\n' + answer + '\n```\n' : answer);
});
