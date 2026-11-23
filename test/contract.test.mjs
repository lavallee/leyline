import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError, foldActivity, settleActivity, assertProvider, CodexAppServerProvider, CliOneshotProvider, HttpChatProvider } from '../server/providers/index.mjs';

test('foldActivity keeps one item per id and applies deltas, text, titles and status', () => {
  const items = [];
  foldActivity(items, { id: 'r1', kind: 'reasoning', append: 'Read', status: 'running' });
  foldActivity(items, { id: 'r1', kind: 'reasoning', append: 'ing', status: 'running' });
  assert.deepEqual(items, [{ id: 'r1', kind: 'reasoning', text: 'Reading', status: 'running' }]);
  foldActivity(items, { id: 'r1', kind: 'reasoning', text: 'Read it.', status: 'done' });
  foldActivity(items, { id: 'c1', kind: 'activity', command: 'ls', status: 'running' });
  foldActivity(items, { id: 'c1', kind: 'activity', command: 'ls', status: 'done', output: 'a\nb' });
  foldActivity(items, { id: 'f1', kind: 'activity', paths: ['/x/a.md'], title: 'Writing a.md', status: 'bogus' });
  assert.deepEqual(items[0], { id: 'r1', kind: 'reasoning', text: 'Read it.', status: 'done' });
  assert.deepEqual(items[1], { id: 'c1', kind: 'activity', text: 'a\nb', command: 'ls', status: 'done' });
  assert.deepEqual(items[2], { id: 'f1', kind: 'activity', text: '', paths: ['/x/a.md'], title: 'Writing a.md' });
});

test('foldActivity caps the list and the text, and lets a host reword an item', () => {
  const items = [];
  for (let i = 0; i < 5; i++) foldActivity(items, { id: `a${i}`, kind: 'activity', text: 'x'.repeat(50) }, { max: 3, maxText: 10 });
  assert.equal(items.length, 3);
  assert.equal(items[0].text.length, 10);
  assert.equal(foldActivity(items, { id: 'late', kind: 'activity' }, { max: 3 }), null);
  const quiet = [];
  foldActivity(quiet, { id: 'c', kind: 'activity', command: 'cat secret', output: 'the contents', status: 'done' },
    { describe: event => event.command ? { title: 'Reading files', quiet: true } : undefined });
  assert.equal(quiet[0].title, 'Reading files');
  assert.equal(quiet[0].text, '', 'a quiet item does not keep command output');
  assert.equal(foldActivity([], { kind: 'activity' }), null, 'an event needs an id');
});

test('settleActivity closes what is still running', () => {
  const done = [{ id: 1, status: 'running' }, { id: 2, status: 'failed' }], stopped = [{ id: 1, status: 'running' }];
  settleActivity(done, true); settleActivity(stopped, false);
  assert.deepEqual(done.map(a => a.status), ['done', 'failed']);
  assert.equal(stopped[0].status, 'stopped');
});

test('ProviderError carries a code and an HTTP status', () => {
  assert.deepEqual([new ProviderError('x', 'stopped').status, new ProviderError('x', 'timeout').status, new ProviderError('x').status, new ProviderError('x', 'auth', 401).status], [499, 504, 502, 401]);
  assert.equal(new ProviderError('x').code, 'failed');
});

test('every adapter has the shape of the contract', () => {
  const providers = [new CodexAppServerProvider({ workDir: '/tmp/unused' }), new CliOneshotProvider({ preset: 'command', command: ['true'] }),
    new HttpChatProvider({ baseUrl: 'http://127.0.0.1:1/v1', model: 'm' })];
  for (const provider of providers) {
    assert.equal(assertProvider(provider), provider);
    assert.deepEqual(Object.keys(provider.capabilities).sort(), ['activity', 'cancel', 'sessions', 'shell', 'structuredOutput', 'textStream']);
  }
  assert.deepEqual(providers.map(p => p.name), ['codex-app-server', 'cli-oneshot', 'http-chat']);
  assert.throws(() => assertProvider({ run() {} }), /cancel\(\)/);
});
