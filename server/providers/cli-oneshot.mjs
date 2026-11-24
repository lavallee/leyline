// One request, one process, one answer: `codex exec`, `claude -p`, or any command that
// reads a prompt on stdin and prints its answer. Generalised from Copycat's presets
// (src/agent.js), with the same safety flags.
//
// Nothing is remembered between runs: the host sends whatever context the agent should
// see in the prompt. The child gets a short allowlist of environment variables, not the
// host's whole environment.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderError, inputParts } from './contract.mjs';
import { SHORT_NAME } from '../package-info.mjs';
import { track, terminate } from '../children.mjs';

export const ENV_KEYS = ['HOME', 'PATH', 'CODEX_HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'USER', 'SHELL', 'TERM'];
const pick = keys => Object.fromEntries(keys.filter(k => process.env[k]).map(k => [k, process.env[k]]));

/**
 * Runs a command with `input` on stdin and resolves with { code, stdout, stderr }.
 * Rejects with a ProviderError when it cannot start ('unavailable'), runs past `timeout`
 * ('timeout') or `signal` aborts ('stopped'). Output is capped so a runaway child cannot
 * fill memory: past `maxOutput` characters the child is stopped, nothing more is kept, and
 * the result carries `truncated: true` and the child's (non-zero) exit code.
 * Stopping a child means SIGTERM and, if it is still running `killGrace` milliseconds
 * later (default 2000), SIGKILL. Only the child itself is signalled unless `processGroup`
 * is true: the child then leads a process group of its own and the whole group is
 * signalled, so what it started stops with it (and it no longer receives a Ctrl-C typed at
 * the host's terminal).
 */
export function runProcess(command, args, { cwd, input = '', timeout = 300000, signal, env = pick(ENV_KEYS), maxOutput = 4_000_000, killGrace = 2000, processGroup = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('Stopped.', 'stopped'));
    let child;
    try { child = track(spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: !!processGroup }), { group: !!processGroup }); }
    catch (error) { return reject(new ProviderError(`The agent could not start: ${String(error?.message || error).slice(0, 300)}`, 'unavailable')); }
    let stdout = '', stderr = '', settled = false, truncated = false;
    const settle = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const stop = error => { terminate(child, killGrace, { group: !!processGroup }); settle(reject, error); };
    const abort = () => stop(new ProviderError('Stopped.', 'stopped'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new ProviderError('The agent took too long and was stopped.', 'timeout')), Math.min(Math.max(0, Number(timeout) || 0), 2 ** 31 - 1));
    // Decoded as a stream, so a character split between two chunks is not broken.
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      if (settled) return;   // nothing is kept once the outcome is known, however long the child lingers
      if (truncated) return;
      stdout += d;
      if (stdout.length > maxOutput) { truncated = true; terminate(child, killGrace, { group: !!processGroup }); }
    });
    child.stderr.on('data', d => { if (settled) return; stderr += d; if (stderr.length > 1_000_000) stderr = stderr.slice(-200_000); });
    child.stdout.on('error', () => {}); child.stderr.on('error', () => {});
    child.on('error', error => settle(reject, new ProviderError(`The agent could not start: ${error.message}`, 'unavailable')));
    child.on('close', code => settle(resolve, { code, stdout, stderr, ...(truncated ? { truncated: true } : {}) }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

/** Reads a JSON object out of an answer that may be fenced or wrapped in prose. Null if there is none. */
export function parseJsonAnswer(text) {
  if (typeof text !== 'string') return null;
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  for (const candidate of [body, body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)]) {
    try { const value = JSON.parse(candidate); if (value && typeof value === 'object') return value; } catch { /* next */ }
  }
  return null;
}

async function executable(file) {
  if (!file || !path.isAbsolute(file)) return false;
  try { await access(file, constants.X_OK); return true; } catch { return false; }
}

// Each preset takes (config, prompt, run options) and returns the raw answer text.
export const PRESETS = {
  // Codex, non-interactive. Read-only sandbox, no shell, no web, no plugins, the user's
  // config and rules ignored: it sees only the prompt. Runs in an empty temporary folder.
  async codex(config, prompt, { timeout, signal, outputSchema, env, processGroup }) {
    if (!await executable(config.bin)) throw new ProviderError('Configure the absolute path of the signed-in Codex CLI (bin).', 'unavailable');
    const dir = await mkdtemp(path.join(os.tmpdir(), `${SHORT_NAME}-`));
    try {
      const login = await runProcess(config.bin, ['login', 'status'], { cwd: dir, timeout: 15000, signal, env });
      if (login.code !== 0) throw new ProviderError('Codex is not signed in on this host. Refresh its login.', 'auth');
      if (outputSchema) await writeFile(path.join(dir, 'schema.json'), JSON.stringify(outputSchema));
      const result = await runProcess(config.bin, ['-a', 'never', 'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
        '--ephemeral', '--ignore-user-config', '--ignore-rules', '--disable', 'shell_tool', '--disable', 'computer_use',
        '--disable', 'hooks', '--disable', 'plugins', '--disable', 'apps', '--disable', 'multi_agent', '--disable', 'multi_agent_v2',
        '-c', 'web_search="disabled"', ...(config.model ? ['-m', config.model] : []),
        ...(outputSchema ? ['--output-schema', path.join(dir, 'schema.json')] : []), '--output-last-message', path.join(dir, 'answer.txt'), '-'],
        { cwd: dir, input: prompt, timeout, signal, env, processGroup });
      if (result.code !== 0) {
        if (/401|unauthori[sz]ed|sign in|token expired/i.test(result.stderr)) throw new ProviderError('Codex could not authenticate. Refresh its login on the host.', 'auth');
        throw new ProviderError('Codex did not finish. ' + result.stderr.slice(-400), 'failed');
      }
      return await readFile(path.join(dir, 'answer.txt'), 'utf8');
    } finally { await rm(dir, { recursive: true, force: true }); }
  },
  // Claude Code in print mode. Read, Grep and Glob only, in `cwd`; no shell, no edits,
  // no MCP servers, no user settings or hooks, no saved session.
  async claude(config, prompt, { cwd, timeout, signal, env, processGroup }) {
    const result = await runProcess(config.bin || 'claude', ['-p', '--output-format', 'json', '--tools', 'Read,Grep,Glob', '--no-session-persistence',
      '--strict-mcp-config', '--disable-slash-commands', '--setting-sources', '', ...(config.model ? ['--model', config.model] : [])],
      { cwd, input: prompt, timeout, signal, env, processGroup });
    const data = parseJsonAnswer(result.stdout);
    if (result.code !== 0 || !data || typeof data.result !== 'string') throw new ProviderError('Claude did not finish. ' + (result.stderr || result.stdout).slice(-400), 'failed');
    return data.result;
  },
  // A fixed command the host configures: prompt on stdin, answer on stdout. What that
  // command may do is the host's to decide; no flags are added.
  async command(config, prompt, { cwd, timeout, signal, env, processGroup }) {
    if (!Array.isArray(config.command) || !config.command.length || config.command.some(part => typeof part !== 'string' || !part))
      throw new ProviderError('The agent command is not configured.', 'unavailable');
    const result = await runProcess(config.command[0], config.command.slice(1), { cwd, input: prompt, timeout, signal, env, processGroup });
    if (result.code !== 0) throw new ProviderError('The agent command failed. ' + result.stderr.slice(-400), 'failed');
    return result.stdout;
  },
};

export class CliOneshotProvider {
  name = 'cli-oneshot';
  capabilities = { activity: false, textStream: false, sessions: false, cancel: true, shell: false, structuredOutput: true, asks: false, steer: false, resume: false };

  /**
   * @param {object} config
   * @param {'codex'|'claude'|'command'} [config.preset] default 'codex'
   * @param {string} [config.bin] the CLI to run; for codex an absolute path is required
   * @param {string[]} [config.command] for the 'command' preset
   * @param {string} [config.model]
   * @param {number} [config.timeout] milliseconds; default 300000
   * @param {string[]} [config.envKeys] environment variables the child may see; default ENV_KEYS
   * @param {boolean} [config.processGroup] stop the CLI's own children with it; see runProcess. Default false
   */
  constructor(config = {}) {
    this.config = { preset: 'codex', timeout: 300000, ...config };
    if (!Object.hasOwn(PRESETS, this.config.preset)) throw new ProviderError('Unknown agent preset.', 'config');
    this.controllers = new Map();
  }

  /**
   * Extras beyond the common request:
   * @param {string} [request.cwd] where the agent runs (claude and command; codex always uses an empty folder)
   * @param {object} [request.outputSchema] a JSON Schema for the answer (enforced by codex; advisory elsewhere)
   * @param {boolean} [request.json] also parse the answer as JSON and return it as `data`
   * @param {(data: object) => any} [request.validate] with `json`: the host's check of the parsed answer, which is
   *   a model's output and should be treated as data. Return false or a string (the reason), or throw, to fail the
   *   run with code 'failed'; return an object to use it in place of the answer (a repaired or narrowed copy).
   * `instructions`, when given, are put before the input in the prompt.
   */
  async run({ key, input, instructions, cwd, outputSchema, json = false, validate, signal, timeout } = {}) {
    const prompt = [instructions, ...inputParts(input)].filter(Boolean).join('\n\n');
    if (!prompt) throw new ProviderError('Give the run some input.', 'config');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    if (key !== undefined) {
      if (this.controllers.has(key)) throw new ProviderError('That conversation already has a request running.', 'busy');
      this.controllers.set(key, controller);
    }
    try {
      const message = await PRESETS[this.config.preset](this.config, prompt, { cwd, outputSchema, signal: controller.signal,
        timeout: timeout ?? this.config.timeout, env: pick(this.config.envKeys || ENV_KEYS), processGroup: !!this.config.processGroup });
      const result = { message, provenance: { provider: this.name, preset: this.config.preset, model: this.config.model || 'provider default' } };
      if (json) {
        result.data = parseJsonAnswer(message);
        if (!result.data) throw new ProviderError('The agent’s answer was not JSON.', 'failed');
        if (typeof validate === 'function') {
          let verdict;
          try { verdict = validate(result.data); } catch (error) { verdict = String(error?.message || error) || false; }
          if (verdict === false || typeof verdict === 'string') throw new ProviderError(`The agent’s answer did not pass the host’s check${verdict ? `: ${verdict.slice(0, 300)}` : '.'}`, 'failed');
          if (verdict && typeof verdict === 'object') result.data = verdict;
        }
      }
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (key !== undefined && this.controllers.get(key) === controller) this.controllers.delete(key);
    }
  }
  cancel(key) { const controller = this.controllers.get(key); controller?.abort(); return !!controller; }
  reset() { /* nothing is remembered between runs */ }
  close() { for (const controller of this.controllers.values()) controller.abort(); this.controllers.clear(); }
}
