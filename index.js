import fs from 'node:fs/promises';
import path from 'node:path';
import { sharedManager, initialize, stateDirectory } from './core/manager.mjs';
import { freeHooks } from './core/free-adapter.mjs';
import { antseedHooks } from './core/antseed-adapter.mjs';
import { kiloHooks } from './core/kilo-adapter.mjs';

async function localAccount(input, id) {
  if (!input?.directory || typeof input?.client?.auth?.set !== 'function') return;
  let auth;
  try { auth = JSON.parse(await fs.readFile(path.join(input.directory, 'plugin-auth.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; auth = {}; }
  // Leave all existing accounts and credentials intact. Only our local
  // providers receive a sentinel; it never reaches the remote gateway.
  if (Object.keys(auth).some(key => key === id || key.startsWith(id + '#'))) return;
  await input.client.auth.set({ path: { id }, body: { type: 'api', key: 'budget-local' } });
}

async function managed(input, options, name, factory) {
  const directory = stateDirectory(options.stateDir);
  await initialize(directory);
  const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
  const manager = sharedManager(options);
  const disabled = config[name]?.enabled === false || (name === 'antseed' && config.antseed?.enabled !== true);
  const d = disabled ? null : await manager.ensure();
  const base = (d?.url || 'http://127.0.0.1:1') + '/' + name + '/v1';
  const hooks = await factory(input, { ...options, ...config[name], baseUrl: base, fetch: (url, init) => manager.fetch(name, url, init) });
  if (disabled) hooks.provider.models = async () => ({});
  else await localAccount(input, hooks.provider.id);
  return hooks;
}
export const FreeLLMAPI = { server: (input, options = {}) => managed(input, options, 'free', freeHooks) };
export const AntSeed = { server: (input, options = {}) => managed(input, options, 'antseed', antseedHooks) };
export const Kilo = { server: async (input, options = {}) => { await initialize(stateDirectory(options.stateDir)); const hooks = await kiloHooks(input, options); await localAccount(input, hooks.provider.id); return hooks; } };
