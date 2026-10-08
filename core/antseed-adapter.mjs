const PROVIDER = 'budget-antseed';
const NPM = {
  'anthropic-messages': '@ai-sdk/anthropic',
  'openai-responses': '@ai-sdk/openai',
  'openai-chat-completions': '@ai-sdk/openai-compatible',
};

function proxyBase(value) {
  const url = new URL(value || 'http://127.0.0.1:8377');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('AntSeed baseUrl must be an HTTP(S) proxy root or /v1 URL without embedded credentials.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : path + '/v1';
  return url.href.replace(/\/+$/, '');
}

function protocols(offer) {
  return new Set([offer.protocol, ...(Array.isArray(offer.protocols) ? offer.protocols : [])].filter(p => NPM[p]));
}

function npmFor(offers) {
  for (const protocol of ['anthropic-messages', 'openai-responses', 'openai-chat-completions']) {
    if (offers.length && offers.every(o => protocols(o).has(protocol))) return NPM[protocol];
  }
  // The buyer proxy also adapts Chat to sellers with other native protocols.
  return NPM['openai-chat-completions'];
}

function knownPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function costOf(offers) {
  if (!offers.length || !offers.every(o => knownPrice(o.inputUsdPerMillion) && knownPrice(o.outputUsdPerMillion))) return undefined;
  // An automatic route can retain a previous eligible seller through affinity.
  // Quote a conservative known-offer envelope, rather than pretending the
  // cheapest catalog offer is necessarily the seller that will answer.
  return {
    input: Math.max(...offers.map(o => o.inputUsdPerMillion)),
    output: Math.max(...offers.map(o => o.outputUsdPerMillion)),
    cache: { read: Math.max(...offers.map(o => knownPrice(o.cachedInputUsdPerMillion) ? o.cachedInputUsdPerMillion : o.inputUsdPerMillion)), write: Math.max(...offers.map(o => o.inputUsdPerMillion)) },
  };
}

function modelOf(id, apiId, name, base, offers, capability) {
  const modalities = capability.inputs ?? ['text'];
  const cost = costOf(offers);
  return {
    id: apiId,
    name: `${name}${cost ? (offers.length > 1 ? ' · known-offer price ceiling' : '') : ' · price unknown'}`,
    api: { id: apiId, url: base, npm: npmFor(offers) },
    status: 'active',
    limit: { context: capability.contextWindow ?? 0, output: capability.maxOutputTokens ?? 0 },
    capabilities: {
      temperature: true, reasoning: capability.reasoning === true,
      toolcall: capability.toolUse === true, attachment: modalities.includes('image'),
      input: { text: modalities.includes('text'), image: modalities.includes('image'), audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
    },
    ...(cost ? { cost } : {}),
    headers: {}, options: {}, variants: {},
  };
}

function catalogModels(data, base, options) {
  if (!Array.isArray(data)) throw new Error('AntSeed /v1/models did not return a data array.');
  const allow = Array.isArray(options.models) ? new Set(options.models) : null;
  const models = Object.create(null);
  for (const entry of data) {
    if (entry?.type !== 'text' || typeof entry.id !== 'string' || !entry.id || (allow && !allow.has(entry.id))) continue;
    const offers = Array.isArray(entry.peers) ? entry.peers : [];
    if (!offers.length) continue;
    const capability = {
      contextWindow: entry.context_length, maxOutputTokens: entry.max_output_tokens,
      inputs: entry.architecture?.input_modalities,
      reasoning: entry.capabilities?.reasoning, toolUse: entry.capabilities?.tool_use,
    };
    models[entry.id] = modelOf(entry.id, entry.id, entry.name || entry.id, base, offers, capability);
    if (!options.includePinned) continue;
    for (const offer of offers) {
      if (!/^[0-9a-f]{40}$/i.test(offer.peerId) || typeof offer.serviceId !== 'string' || !offer.serviceId) continue;
      // Native AntSeed route syntax. Reputation/display names are not identity.
      const id = `${offer.peerId.toLowerCase()}@${offer.serviceId}`;
      models[id] = modelOf(id, id, `${entry.name || entry.id} @ ${offer.displayName || offer.peerId.slice(0, 12)}`,
        base, [offer], offer.capabilities || {});
    }
  }
  return models;
}

export async function antseedHooks(_input, options = {}) {
  const fetch = options.fetch || globalThis.fetch;
  const base = proxyBase(options.baseUrl || process.env.ANTSEED_BASE_URL);
  const timeout = Number.isFinite(options.discoveryTimeoutMs) && options.discoveryTimeoutMs > 0 ? options.discoveryTimeoutMs : 4000;
  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= { name: 'AntSeed', npm: NPM['openai-chat-completions'], api: base, models: {} };
    },
    auth: {
      provider: PROVIDER,
      methods: [{ type: 'api', label: 'AntSeed local proxy placeholder (use antseed-local)', placeholder: 'antseed-local' }],
      loader: async getAuth => {
        const auth = await getAuth();
        return {
          baseURL: base,
          apiKey: auth?.key || 'antseed-local',
          // Preserve HTTP statuses (including 402), stream bodies, and aborts.
          fetch: (url, init) => fetch(url, init),
        };
      },
    },
    provider: {
      id: PROVIDER,
      async models(_provider, { auth }) {
        const res = await fetch(`${base}/models?type=text`, {
          headers: auth?.key ? { authorization: `Bearer ${auth.key}` } : {},
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) throw new Error(`AntSeed model discovery returned HTTP ${res.status}. Check the buyer proxy.`);
        return catalogModels((await res.json()).data, base, options);
      },
    },
  };
}

export const _internal = { proxyBase, catalogModels, npmFor, costOf };
