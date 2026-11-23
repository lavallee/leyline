import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, stat, readFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProfiles, createBindings, checkProfile, profileInstructions, requestFor, providerFor, conversationKey, commandSource, fileSource, ProfileError } from '../server/profiles.mjs';
import { tempDir } from './helpers.mjs';

// An agent's own folder, with the kinds of file a profile points at.
async function agentFolder(t) {
  const root = await tempDir(t), work = path.join(root, 'kiefer');
  await mkdir(path.join(work, 'skills/research'), { recursive: true });
  await mkdir(path.join(work, 'notebook')); await mkdir(path.join(work, '.secrets'));
  await writeFile(path.join(work, 'AGENTS.md'), 'I am Kiefer. I keep a research notebook.');
  await writeFile(path.join(work, 'README.md'), 'x'.repeat(3000));
  await writeFile(path.join(work, 'skills/research/SKILL.md'), '---\nname: research\ndescription: How to look things up.\n---\nSteps.');
  await writeFile(path.join(work, '.secrets/token'), 'sk-never-read');
  await writeFile(path.join(root, 'outside.md'), 'not the agent\'s');
  await symlink(path.join(root, 'outside.md'), path.join(work, 'link-out.md'));
  return { root, work };
}

test('a profile is checked: files inside its folder are read within the budget, the rest is refused and reported', async t => {
  const { root, work } = await agentFolder(t);
  const p = checkProfile({ id: 'kiefer', name: 'Kiefer', workdir: work, instructions: 'Be brief.', budget: 1000, model: 'some-model', provider: 'codex',
    context: ['AGENTS.md', { path: 'README.md', label: 'Readme' }, { text: 'Told directly.', label: 'note' }, '../outside.md', 'link-out.md', '.secrets/token', 'missing.md'],
    skills: [{ path: 'skills/research' }, 'skills/none', '../outside.md'], references: ['notebook', { path: 'nope' }, '.secrets'], writable: ['/'] }, 'local/kiefer');
  assert.equal(p.workdir, work); assert.equal(p.model, 'some-model'); assert.equal(p.provider, 'codex'); assert.equal(p.budget, 1000);
  assert.deepEqual(p.context.map(c => [c.label, c.chars, !!c.truncated, !!c.missing]), [['AGENTS.md', 40, false, false], ['Readme', 960, true, false], ['note', 0, true, false], ['missing.md', 0, false, true]]);
  assert.match(p.context[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(p.skills, [{ name: 'research', description: 'How to look things up.', path: path.join(work, 'skills/research/SKILL.md') }]);
  assert.deepEqual(p.references, [{ dir: path.join(work, 'notebook'), label: 'notebook' }]);
  assert.ok(!JSON.stringify(p).includes('sk-never-read') && !JSON.stringify(p).includes("not the agent's"), 'nothing hidden or outside the folder is read');
  for (const expected of ['context ../outside.md: outside', 'context link-out.md: outside', 'context .secrets/token: outside', 'context missing.md: no such file', 'skill skills/none: no SKILL.md', 'skill ../outside.md: outside', 'reference nope: not a folder', 'reference .secrets: outside', 'writable: a profile cannot grant writing'])
    assert.ok(p.problems.some(line => line.startsWith(expected)), `${expected} in ${JSON.stringify(p.problems)}`);
  assert.equal(p.problems.length, 9);
  // Folders that are not an agent's own.
  for (const bad of [{ workdir: 'relative' }, { workdir: path.join(root, 'nowhere') }, { workdir: '/' }, { workdir: os.homedir() }, { workdir: path.dirname(os.homedir()) }])
    assert.throws(() => checkProfile({ id: 'x', ...bad }, 'local/x'), ProfileError, JSON.stringify(bad));
  assert.throws(() => checkProfile(null, 'local/x'), ProfileError);
});

test('profile instructions say who the agent is, and a request carries them after the host’s own', async t => {
  const { work } = await agentFolder(t);
  const p = checkProfile({ id: 'kiefer', name: 'Kiefer', workdir: work, instructions: 'Be brief.', model: 'm-1', context: ['AGENTS.md', 'gone.md'], skills: ['skills/research'] }, 'local/kiefer');
  const said = profileInstructions(p, { place: 'this canvas' });
  assert.match(said, /^You are Kiefer, not a general-purpose assistant: the person chose to work with you on this canvas\./);
  assert.match(said, new RegExp(`Your own folder is ${work}\\. .*write only where the instructions above say you may`));
  assert.match(said, /## Who you are\n\nBe brief\./);
  assert.match(said, /- research: How to look things up\. \(.*SKILL\.md\)/);
  assert.match(said, /### AGENTS\.md \(.*AGENTS\.md\)\n\nI am Kiefer\./);
  assert.match(said, /weren't found|were not found: gone\.md/);
  const request = requestFor(p, { key: 'doc:main', instructions: 'HOST RULES', input: 'hi', sandbox: { mode: 'workspace-write', writableRoots: ['/srv/doc/work'] } });
  assert.ok(request.instructions.startsWith('HOST RULES\n\nYou are Kiefer'));
  assert.equal(request.model, 'm-1');
  assert.deepEqual(request.sandbox.writableRoots, ['/srv/doc/work'], 'a profile never widens where the agent may write');
  assert.deepEqual(requestFor(null, { input: 'hi' }), { input: 'hi' });
  const providers = { codex: 'CODEX', http: 'HTTP' };
  assert.deepEqual([providerFor({ provider: 'http' }, providers, 'CODEX'), providerFor({ provider: 'toString' }, providers, 'CODEX'), providerFor(p, providers, 'CODEX'), providerFor(null, providers, 'CODEX')], ['HTTP', 'CODEX', 'CODEX', 'CODEX']);
  assert.deepEqual([conversationKey('doc', p), conversationKey('doc', 'acme/ada'), conversationKey('doc', null)], ['doc@local/kiefer', 'doc@acme/ada', 'doc']);
});

test('profiles come from local files and other sources; one failing source does not hide the rest', async t => {
  const { root, work } = await agentFolder(t), dir = path.join(root, 'profiles');
  let clock = 0, served = 0;
  const registry = { id: 'acme', list: async () => [{ id: 'ada', name: 'Ada', color: 'green' }, { id: 'bad id!' }], get: async id => { served++; if (id !== 'ada') throw new ProfileError('no such profile'); return { name: 'Ada', workdir: work }; } };
  const broken = { id: 'down', list: async () => { throw new Error('registry unreachable'); }, get: async () => { throw new Error('registry unreachable'); } };
  const profiles = createProfiles({ dir, sources: [registry, broken], ttl: 1000, now: () => clock });
  assert.deepEqual(profiles.sources(), ['local', 'acme', 'down']);
  const added = profiles.add({ id: 'kiefer', workdir: work, description: 'Research agent' });
  assert.deepEqual([added.name, added.context.map(c => c.label), added.file], ['Kiefer', ['AGENTS.md', 'README.md'], path.join(dir, 'kiefer.json')]);
  assert.equal((await stat(added.file)).mode & 0o777, 0o600);
  assert.throws(() => profiles.add({ id: 'kiefer', workdir: work }), /already exists/);
  assert.throws(() => profiles.add({ id: 'no good', workdir: work }), ProfileError);
  assert.throws(() => profiles.add({ id: 'home', workdir: os.homedir() }), /too broad/);
  await writeFile(path.join(dir, 'corrupt.json'), '{ nope');
  const listed = await profiles.list();
  assert.deepEqual(listed.profiles.filter(p => p.source !== 'local'), [{ ref: 'acme/ada', source: 'acme', id: 'ada', name: 'Ada', description: '', color: 'green' }]);
  assert.deepEqual(listed.errors.map(e => e.source), ['local', 'down'], 'a source with a broken file, and one that is down, are reported');
  assert.equal((await profiles.get('local/kiefer')).name, 'Kiefer');
  assert.equal((await profiles.get('acme/ada')).workdir, work);
  await profiles.get('acme/ada'); assert.equal(served, 1, 'kept for a short while');
  clock += 2000; await profiles.get('acme/ada'); assert.equal(served, 2);
  // The source goes down: the last good profile is used for a while, unless a fresh one is asked for.
  registry.get = async () => { throw new Error('timeout'); };
  clock += 2000;
  assert.equal((await profiles.get('acme/ada')).name, 'Ada');
  await assert.rejects(profiles.get('acme/ada', { fresh: true }), /timeout/);
  profiles.forget('acme/ada');
  await assert.rejects(profiles.get('acme/ada'), /timeout/);
  for (const ref of ['kiefer', 'a/b/c', '../x/y', 'nosuch/kiefer', 'local/nobody']) await assert.rejects(profiles.get(ref), ProfileError, ref);
  assert.throws(() => createProfiles({ sources: [{ id: 'x' }] }), TypeError);
  assert.throws(() => createProfiles({}).add({ id: 'a', workdir: work }), /keeps no local profiles/);
  assert.deepEqual(fileSource(path.join(root, 'empty')).list(), []);
});

test('a program can be a source of profiles', async t => {
  const { root, work } = await agentFolder(t), bin = path.join(root, 'registry');
  await writeFile(bin, `#!${process.execPath}
const [verb, id] = process.argv.slice(2);
if (verb === 'list') console.log(JSON.stringify({ profiles: [{ id: 'ada', name: 'Ada' }] }));
else if (verb === 'get' && id === 'ada') console.log(JSON.stringify({ name: 'Ada', workdir: ${JSON.stringify(work)} }));
else if (verb === 'get' && id === 'junk') console.log('not json');
else process.exit(2);
`);
  await chmod(bin, 0o755);
  const profiles = createProfiles({ sources: [commandSource({ id: 'acme', command: [bin] })] });
  assert.deepEqual((await profiles.list()).profiles.map(p => p.ref), ['acme/ada']);
  assert.equal((await profiles.get('acme/ada')).name, 'Ada');
  await assert.rejects(profiles.get('acme/nobody'), ProfileError);
  await assert.rejects(profiles.get('acme/junk'), /not JSON/);
});

test('bindings say which agent a document has', async t => {
  const file = path.join(await tempDir(t), 'state', 'bindings.json');
  const bindings = createBindings({ file });
  assert.equal(bindings.bound('canvas-1'), null);
  assert.deepEqual(bindings.bind('canvas-1', 'local/kiefer'), { was: null, now: 'local/kiefer', changed: true });
  assert.deepEqual(bindings.bind('canvas-1', 'local/kiefer'), { was: 'local/kiefer', now: 'local/kiefer', changed: false });
  assert.deepEqual(bindings.bind('canvas-1', 'acme/ada'), { was: 'local/kiefer', now: 'acme/ada', changed: true });
  bindings.bind('canvas-2', 'local/kiefer');
  assert.deepEqual(bindings.all(), { 'canvas-1': 'acme/ada', 'canvas-2': 'local/kiefer' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), bindings.all());
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(bindings.unbind('canvas-1'), { was: 'acme/ada', now: null, changed: true });
  assert.deepEqual(bindings.unbind('canvas-1'), { was: null, now: null, changed: false });
  assert.throws(() => bindings.bind('canvas-1', 'not a ref'), ProfileError);
  assert.throws(() => createBindings({}), TypeError);
});
