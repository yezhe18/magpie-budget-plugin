import fs from 'node:fs/promises';
import { openSync, closeSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { restrictDirToOwner, restrictToOwner } from '../dist/permissions.mjs';

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export const defaultConfig = { version: 1, free: { enabled: true }, antseed: { enabled: false } };
export function stateDirectory(value) {
  return path.resolve(value || process.env.MAGPIE_BUDGET_STATE_DIR || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'MagpieBudget')
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'magpie-budget')));
}
export async function initialize(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!restrictDirToOwner(directory)) throw new Error('Cannot protect the plugin state directory: ' + directory);
  try { await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(defaultConfig, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  if (!restrictToOwner(path.join(directory, 'config.json'))) throw new Error('Cannot protect plugin configuration');
}
export function runtimePath() {
  // Magpie already runs this plugin on Bun. Reuse it for the owned worker.
  // Node is supported for development tests, never shipped in the plugin.
  const executable = process.execPath;
  if (path.isAbsolute(executable)) return executable;
  if (executable.includes('/') || executable.includes('\\')) return path.resolve(executable);
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(folder, executable);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Cannot locate the existing plugin runtime: ' + executable);
}
export async function control(descriptor, route, body) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.url) || !/^[a-f0-9]{64}$/.test(descriptor.secret)) throw new Error('Invalid local core descriptor');
  const response = await fetch(descriptor.url + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${descriptor.secret}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`Local core ${route} returned ${response.status}`);
  const data = await response.json();
  if (data.instance && data.instance !== descriptor.instance) throw new Error('Core instance mismatch');
  return data;
}
export async function readRunning(directory) {
  try { const descriptor = JSON.parse(await fs.readFile(path.join(directory, 'run.json'), 'utf8')); const state = await control(descriptor, '/status'); return state.state === 'stopping' ? null : descriptor; }
  catch (error) { if (error.code === 'ENOENT' || error.name === 'TimeoutError' || error.name === 'TypeError') return null; throw error; }
}
export class CoreManager {
  constructor(options = {}) { this.directory = stateDirectory(options.stateDir); this.id = randomUUID(); this.closed = false; this.descriptor = null; this.pending = null; this.timer = null; }
  async ensure() {
    if (this.closed) throw new Error('Core manager has been closed');
    if (this.descriptor) { try { await control(this.descriptor, '/lease', { id: this.id, pid: process.pid }); return this.descriptor; } catch { this.descriptor = null; } }
    if (!this.pending) this.pending = this.connect().finally(() => { this.pending = null; });
    return this.pending;
  }
  async connect() {
    await initialize(this.directory);
    let descriptor = await readRunning(this.directory);
    if (!descriptor) {
      const executable = runtimePath();
      await fs.access(executable);
      const fd = openSync(path.join(this.directory, 'core.log'), 'a', 0o600);
      let child;
      const argv = [...(process.versions.bun ? ['--no-install'] : []), path.join(packageRoot, 'core/service.mjs'), this.directory];
      try { child = spawn(executable, argv, { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, NODE_ENV: 'production', BUN_CONFIG_NO_INSTALL: '1' } }); }
      finally { closeSync(fd); }
      let failure;
      child.once('error', e => { failure = e; }); child.unref();
      for (let i = 0; i < 160; i++) { if (failure) throw failure; await wait(50); descriptor = await readRunning(this.directory); if (descriptor) break; }
      if (!descriptor) throw new Error(`Core did not start. See ${path.join(this.directory, 'core.log')}`);
    }
    await control(descriptor, '/lease', { id: this.id, pid: process.pid }); this.descriptor = descriptor;
    if (!this.timer) { this.timer = setInterval(() => { if (this.descriptor) control(this.descriptor, '/lease', { id: this.id, pid: process.pid }).catch(() => { this.descriptor = null; }); }, 2000); this.timer.unref(); }
    return descriptor;
  }
  async close() { this.closed = true; clearInterval(this.timer); if (this.descriptor) await control(this.descriptor, '/release', { id: this.id }).catch(() => {}); this.descriptor = null; }
  async stop() {
    this.descriptor = null;
    const ownerFile = path.join(this.directory, 'owner.lock', 'owner.json');
    const owner = await fs.readFile(ownerFile, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    const descriptor = await readRunning(this.directory);
    if (descriptor) await control(descriptor, '/stop', {});
    if (!owner) return;
    const deadline = Date.now() + 13000;
    while (Date.now() < deadline) {
      const current = await fs.readFile(ownerFile, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (!current || current.instance !== owner.instance) return;
      if (!Number.isSafeInteger(current.pid) || current.pid <= 0) throw new Error('Invalid core lock owner');
      try { process.kill(current.pid, 0); } catch (e) { if (e.code !== 'EPERM') return; }
      await wait(50);
    }
    throw new Error('Core did not finish stopping; see ' + path.join(this.directory, 'core.log'));
  }
  async fetch(name, url, init = {}) {
    const descriptor = await this.ensure();
    const target = new URL(url);
    // Replace stale ports after a core crash/restart while keeping the model
    // route stable in Magpie's cached provider configuration.
    const prefix = '/' + name;
    if (!target.pathname.startsWith(prefix + '/v1/')) throw new Error('Unexpected component URL');
    const headers = new Headers(init.headers); headers.set('authorization', `Bearer ${descriptor.secret}`);
    return fetch(descriptor.url + target.pathname + target.search, { ...init, headers });
  }
}
const managers = new Map();
export function sharedManager(options = {}) {
  const directory = stateDirectory(options.stateDir);
  if (!managers.has(directory)) managers.set(directory, new CoreManager({ stateDir: directory }));
  return managers.get(directory);
}
