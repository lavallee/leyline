// A check that needs no type checker: every path in `exports` points at a file that is
// in the package, the 0.2.3 paths are still there unchanged, and every server module loads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// Each export as [specifier, expected file], with `*` patterns expanded over the files they match.
async function entries() {
  const out = [];
  for (const [subpath, target] of Object.entries(pkg.exports)) {
    if (!subpath.includes('*')) { out.push([subpath, target]); continue; }
    const [before, after] = target.split('*'), dir = path.join(root, path.dirname(before + 'x'));
    for (const file of await readdir(dir)) if (file.endsWith(after) && path.join(dir, file).startsWith(path.join(root, before)))
      out.push([subpath.replace('*', file.slice(0, file.length - after.length)), before + file]);
  }
  return out;
}

test('every path in exports resolves to a file the package ships', async () => {
  const list = await entries();
  assert.ok(list.length >= 30, `expected the ui/* pattern to expand: ${list.length}`);
  for (const [subpath, target] of list) {
    const specifier = pkg.name + subpath.slice(1);
    const resolved = fileURLToPath(import.meta.resolve(specifier));
    assert.equal(resolved, path.join(root, target), specifier);
    await access(resolved);
    assert.ok(pkg.files.some(entry => target === `./${entry}` || target.startsWith(`./${entry}/`)) || target === './package.json', `${target} is inside "files"`);
  }
});

test('the 0.2.3 export paths are all still present, pointing where they did', () => {
  const before = { '.': './src/index.tsx', './ui/*': './src/ui/*.tsx', './theme.css': './src/theme.css', './dock': './src/dock.tsx', './activity': './src/activity.tsx',
    './server/rpc': './server/codex-rpc.mjs', './server/routines': './server/routine-bank.mjs', './routines': './src/routines.mjs', './routine-menu': './src/routine-menu.tsx' };
  for (const [subpath, target] of Object.entries(before)) assert.equal(pkg.exports[subpath], target, subpath);
});

test('the 0.3.0 export paths are all still present, pointing where they did', () => {
  const before = { './server/providers': './server/providers/index.mjs', './server/providers/codex-app-server': './server/providers/codex-app-server.mjs',
    './server/providers/cli-oneshot': './server/providers/cli-oneshot.mjs', './server/providers/http-chat': './server/providers/http-chat.mjs',
    './server/conversations': './server/conversations.mjs', './server/telemetry': './server/telemetry.mjs', './server/commands': './server/commands.mjs', './package.json': './package.json' };
  for (const [subpath, target] of Object.entries(before)) assert.equal(pkg.exports[subpath], target, subpath);
});

test('0.4.0 adds one entry point per pattern', () => {
  for (const name of ['routine-set', 'history', 'proposals', 'activity', 'threads', 'profiles', 'worklog']) assert.equal(pkg.exports[`./server/${name}`], `./server/${name}.mjs`);
});

test('the ACP provider is its own entry point and is in the providers index', async () => {
  assert.equal(pkg.exports['./server/providers/acp'], './server/providers/acp.mjs');
  const alone = await import(`${pkg.name}/server/providers/acp`), index = await import(`${pkg.name}/server/providers`);
  assert.equal(typeof alone.AcpProvider, 'function');
  assert.equal(typeof alone.diffToEdit, 'function');
  assert.equal(index.AcpProvider, alone.AcpProvider);
  assert.equal(index.diffToEdit, alone.diffToEdit);
});

test('0.7.0 adds the event reducer, the stream helper, the browser client and the MCP server', async () => {
  for (const [subpath, target] of Object.entries({ './server/events': './server/events.mjs', './server/stream': './server/stream.mjs', './stream-client': './src/stream-client.mjs', './server/mcp': './server/mcp.mjs' })) assert.equal(pkg.exports[subpath], target);
  const mcp = await import(`${pkg.name}/server/mcp`);
  for (const name of ['createMcpServer', 'serveMcp', 'serveMcpBridge', 'describeTools']) assert.equal(typeof mcp[name], 'function', name);
  const providers = await import(`${pkg.name}/server/providers`);
  for (const name of ['createBatcher', 'chosenOption']) assert.equal(typeof providers[name], 'function', name);
  assert.equal(typeof (await import(`${pkg.name}/server/events`)).applyEvent, 'function');
  assert.equal(typeof (await import(`${pkg.name}/server/stream`)).streamConversation, 'function');
  assert.equal(typeof (await import(`${pkg.name}/stream-client`)).followConversation, 'function');
  const store = await import(`${pkg.name}/server/conversations`);
  for (const name of ['createConversationStore', 'readConversation', 'fileNameFor', 'logNameFor', 'ConversationError', 'TURN_STATUSES']) assert.ok(store[name], name);
  // The browser client and the reducer it shares with the server use nothing a browser lacks.
  for (const file of ['src/stream-client.mjs', 'server/events.mjs']) assert.ok(!/from\s+['"]node:/.test(await readFile(path.join(root, file), 'utf8')), `${file} imports no Node module`);
});

test('a rename is one step: only package.json, the README, the changelog and docs name the package', async () => {
  const short = pkg.name.replace(/^@[^/]+\//, ''), scope = pkg.name.split('/')[0];
  const walk = async dir => (await Promise.all((await readdir(path.join(root, dir), { withFileTypes: true })).map(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]))).flat();
  for (const file of [...await walk('server'), ...await walk('src'), ...await walk('test')]) {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const word of [pkg.name, short, short.replace(/-/g, '_'), scope]) assert.ok(!source.includes(word), `${file} contains "${word}"`);
  }
  const info = await import('../server/package-info.mjs');
  assert.deepEqual([info.PACKAGE_NAME, info.PACKAGE_VERSION, info.SHORT_NAME], [pkg.name, pkg.version, short]);
  assert.match(info.ATTRIBUTE_PREFIX, /^[a-z0-9_]+$/);
});

test('every .mjs export loads with no dependency installed and exports something', async () => {
  for (const [subpath, target] of await entries()) {
    if (!target.endsWith('.mjs')) continue;
    const module = await import(pkg.name + subpath.slice(1));
    assert.ok(Object.keys(module).length > 0, subpath);
  }
});

test('server modules import only Node built-ins and each other', async () => {
  const files = [...(await readdir(path.join(root, 'server'))).map(f => `server/${f}`), ...(await readdir(path.join(root, 'server/providers'))).map(f => `server/providers/${f}`)].filter(f => f.endsWith('.mjs'));
  assert.ok(files.length >= 10);
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8');
    for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm))
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    assert.ok(!/\bimport\s*\(/.test(source), `${file} has no dynamic import`);
  }
});

test('the package is 0.9.0-dispatch.1, MIT, for Node 22 or later', async () => {
  assert.equal(pkg.version, '0.9.0-dispatch.1'); assert.equal(pkg.license, 'MIT'); assert.equal(pkg.engines.node, '>=22'); assert.equal(pkg.type, 'module');
  assert.match(await readFile(path.join(root, 'LICENSE'), 'utf8'), /MIT License/);
});
