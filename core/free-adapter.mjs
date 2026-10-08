const PROVIDER = 'budget-free';
const UPSTREAM_OWNER = 'freellmapi';
const NPM = '@ai-sdk/openai-compatible';

function proxyBase(value) {
  const url = new URL(value || 'http://127.0.0.1:3001');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('FreeLLMAPI baseUrl must be an HTTP(S) root or /v1 URL without embedded credentials.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : path + '/v1';
  return url.href.replace(/\/+$/, '');
}

const positive = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;

function modelsOf(data, base, options = {}) {
  if (!Array.isArray(data)) throw new Error('FreeLLMAPI /v1/models did not return a data array.');
  const allow = Array.isArray(options.models) ? new Set(options.models) : null;
  // Router aliases have different availability semantics. A catalog model must
  // have a live ready status; merely having an enabled key is insufficient.
  const ready = data.filter(m => m && typeof m.id === 'string' && m.id && m.available === true && m.execution_status === 'ready');
  const poolTools = ready.some(m => Array.isArray(m.supported_parameters) && m.supported_parameters.includes('tools'));
  const models = Object.create(null);
  for (const entry of data) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || (allow && !allow.has(entry.id))) continue;
    const router = entry.owned_by === UPSTREAM_OWNER && !Object.hasOwn(entry, 'execution_status');
    if (router) {
      // Do not expose fusion or synthetic Claude-family aliases by default.
      // A named profile is explicitly opted in because its metadata does not
      // report per-profile live quota or tool/vision capabilities.
      if (!ready.length || entry.available !== true ||
          !(entry.id === 'auto' || (allow && entry.id.startsWith('auto:')))) continue;
    } else if (!ready.includes(entry)) continue;
    const meta = options.modelMetadata?.[entry.id] || {};
    const params = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
    const tools = bool(meta.tools, router ? entry.id === 'auto' && poolTools : params.includes('tools'));
    // The public FreeLLMAPI catalog lacks per-model vision and output limits.
    // Leave unknown capability/limit fields conservative, with optional
    // operator overrides for a known, controlled profile.
    const vision = meta.vision === true;
    models[entry.id] = {
      id: entry.id,
      name: `${entry.name || entry.id} · cost unverified`,
      api: { id: entry.id, url: base, npm: NPM }, status: 'active',
      limit: { context: positive(meta.context ?? entry.context_length ?? entry.context_window), output: positive(meta.output) },
      capabilities: {
        temperature: params.includes('temperature'), reasoning: params.includes('reasoning') || params.includes('reasoning_effort'),
        toolcall: tools, attachment: vision,
        input: { text: true, image: vision, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
      },
      // No cost=0: user-configured custom endpoints can be paid, and this API
      // does not provide a billing guarantee or prices for them.
      headers: {}, options: {}, variants: {},
    };
  }
  return models;
}

export async function freeHooks(_input, options = {}) {
  const fetch = options.fetch || globalThis.fetch;
  const base = proxyBase(options.baseUrl || process.env.FREELLMAPI_BASE_URL);
  const timeout = Number.isFinite(options.discoveryTimeoutMs) && options.discoveryTimeoutMs > 0 ? options.discoveryTimeoutMs : 4000;
  const apiKey = auth => auth?.key || process.env.FREELLMAPI_API_KEY || '';
  return {
    config: async cfg => {
      cfg.provider ??= {};
      cfg.provider[PROVIDER] ??= { name: 'FreeLLMAPI', npm: NPM, api: base, models: {} };
    },
    auth: {
      provider: PROVIDER,
      methods: [{ type: 'api', label: 'Managed core placeholder (enter budget-local)', placeholder: 'budget-local' }],
      loader: async getAuth => ({
        baseURL: base, apiKey: apiKey(await getAuth()),
        // Retain statuses, headers, the original stream, and cancellation.
        fetch: (url, init) => fetch(url, init),
      }),
    },
    provider: {
      id: PROVIDER,
      async models(_provider, { auth }) {
        const key = apiKey(auth);
        // An installed provider can be shown before login; it must not invent
        // models or send an empty/sentinel key to the authenticated endpoint.
        if (!key) return {};
        const res = await fetch(`${base}/models?available=true&execution_status=ready`, {
          headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) throw new Error(`FreeLLMAPI model discovery returned HTTP ${res.status}. Check the unified key and router.`);
        return modelsOf((await res.json()).data, base, options);
      },
    },
  };
}

export const _internal = { proxyBase, modelsOf };
