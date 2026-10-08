import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function temporary(label) {
  const base = process.env.BUDGET_TEST_TMP || path.join(root, '.test-work');
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, label + '-'));
}
export async function fixture() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString(); const body = text ? JSON.parse(text) : {};
    calls.push({ url: req.url, headers: req.headers, body });
    if (req.url.endsWith('/models')) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); }
    if (body.model !== 'kilo-auto/free' && body.messages?.some(m => m.content === 'rate-limit')) { res.writeHead(429, { 'retry-after': '2', 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'fixture quota', type: 'rate_limit_error' } })); }
    const message = body.tools?.length
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"value":7}' } }] }
      : { role: 'assistant', content: 'fixture-ok' };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture-ok' }, finish_reason: null }] }) + '\n\n');
      return setTimeout(() => res.end('data: ' + JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + '\n\ndata: [DONE]\n\n'), 20);
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion', created: 1, model: body.model || 'fixture-model', choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}/v1`, calls, close: () => new Promise(resolve => { server.closeIdleConnections(); server.close(resolve); }) };
}
export const freeConfiguration = upstream => ({ version: 1, free: { enabled: true, background: false, probeOnStart: true,
  config: { customProviders: [{ baseUrl: upstream.base, apiKey: 'fixture-key', models: [{ model: 'fixture-model', supportsTools: true }] }] } }, antseed: { enabled: false } });
