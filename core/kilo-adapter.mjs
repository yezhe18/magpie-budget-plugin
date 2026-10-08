import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDirectory } from './manager.mjs';

const id = 'budget-kilo', modelID = 'kilo-auto/free';
export async function kiloHooks(_input, options = {}) {
  const config = JSON.parse(await fs.readFile(path.join(stateDirectory(options.stateDir), 'config.json'), 'utf8'));
  const settings = config.kilo || {};
  const base = (settings.baseUrl || 'https://api.kilo.ai/api/gateway').replace(/\/+$/, '');
  const u = new URL(base);
  if (!(u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) || u.username || u.password || u.hash || u.search) throw new Error('Invalid Kilo endpoint');
  const model = { id: modelID, name: 'Kilo Auto Free · upstream may train on prompts', api: { id: modelID, url: base, npm: '@ai-sdk/openai-compatible' }, status: 'active',
    limit: { context: 256000, output: 32768 }, cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: { temperature: true, reasoning: true, toolcall: true, attachment: false, input: { text: true, image: false, audio: false, video: false, pdf: false }, output: { text: true, image: false, audio: false, video: false, pdf: false } }, headers: {}, options: {}, variants: {} };
  const anonymous = async (url, init = {}) => {
    const target = new URL(url);
    if (target.origin !== u.origin || !target.pathname.startsWith(u.pathname + '/')) throw new Error('Unexpected Kilo route');
    if (init.body && JSON.parse(init.body).model !== modelID) throw new Error('This adapter only allows kilo-auto/free');
    const headers = new Headers(init.headers); headers.delete('authorization'); headers.delete('x-api-key');
    return fetch(url, { ...init, headers });
  };
  return { config: async cfg => { cfg.provider ??= {}; cfg.provider[id] ??= { name: 'Managed Kilo Free', npm: '@ai-sdk/openai-compatible', api: base, models: {} }; },
    auth: { provider: id, methods: [{ type: 'api', label: 'Anonymous free route (enter budget-local)' }], loader: async () => ({ baseURL: base, apiKey: '', fetch: anonymous }) },
    provider: { id, models: async () => settings.enabled === false ? {} : { [modelID]: model } } };
}
