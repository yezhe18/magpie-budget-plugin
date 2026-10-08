import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CoreManager, control, readRunning } from '../core/manager.mjs';
import { freeHooks } from '../core/free-adapter.mjs';
import { temporary, fixture, freeConfiguration, delay } from './helpers.mjs';

test('Managed real FreeLLMAPI supports discovery, inference, tools and SSE; core restarts after crash', { timeout: 25000 }, async () => {
  const dir = await temporary('free-core'), upstream = await fixture();
  const first = new CoreManager({ stateDir: dir }), second = new CoreManager({ stateDir: dir });
  try {
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify(freeConfiguration(upstream)));
    const [a, b] = await Promise.all([first.ensure(), second.ensure()]); assert.equal(a.pid, b.pid);
    assert.equal((await control(a, '/status')).clients, 2);
    assert.equal((await fetch(a.url + '/status')).status, 401);
    const base = a.url + '/free/v1';
    const hooks = await freeHooks({}, { baseUrl: base, fetch: (u, i) => first.fetch('free', u, i) });
    const models = await hooks.provider.models({}, { auth: { key: 'budget-local' } });
    assert.ok(models['fixture-model']); assert.ok(models.auto); assert.equal(models['fixture-model'].cost, undefined);
    const send = body => first.fetch('free', base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'test' }], ...body }) });
    let r = await send({ stream: false }); assert.equal(r.status, 200); assert.equal((await r.json()).choices[0].message.content, 'fixture-ok');
    r = await send({ tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { value: { type: 'number' } } } } }] });
    const toolReply = await r.json(); assert.equal(r.status, 200, JSON.stringify(toolReply));
    assert.equal(toolReply.choices[0].message.tool_calls[0].function.name, 'lookup');
    r = await send({ stream: true }); assert.equal(r.status, 200); const sse = await r.text(); assert.match(sse, /fixture-ok/); assert.match(sse, /\[DONE\]/);
    assert.equal(upstream.calls.find(x => x.url.endsWith('/chat/completions')).headers.authorization, 'Bearer fixture-key');
    process.kill(a.pid, 'SIGKILL'); await delay(150);
    r = await first.fetch('free', base + '/models'); assert.equal(r.status, 200);
    const restarted = await first.ensure(); assert.notEqual(restarted.instance, a.instance);
    assert.equal((await control(restarted, '/status')).version, '0.3.0');
    await second.close(); await first.close();
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline && await readRunning(dir)) await delay(100);
    assert.equal(await readRunning(dir), null);
  } finally { await first.stop().catch(() => {}); await first.close(); await second.close(); await upstream.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('AntSeed paid mode rejects missing price limits before starting network or payments', async () => {
  const { startAntseed } = await import('../dist/antseed.mjs'); const dir = await temporary('paid-guard');
  try { await assert.rejects(startAntseed(dir, {}), /requires router.maxPricing/); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
});
test('Bundled real AntSeed buyer initializes its stores and local proxy without an external daemon', async () => {
  const { startAntseed } = await import('../dist/antseed.mjs'); const dir = await temporary('ant-core'); let ant;
  try {
    ant = await startAntseed(dir, { payments: { enabled: false }, node: { noOfficialBootstrap: true, bootstrapNodes: [], dhtPort: 0, dhtOperationTimeoutMs: 100 } });
    assert.equal(ant.status().state, 'running'); assert.match(ant.status().peerId, /^[a-f0-9]{40}$/);
    const r = await fetch(ant.baseURL + '/v1/models'); assert.equal(r.status, 200); assert.ok(Array.isArray((await r.json()).data));
  } finally { if (ant) await ant.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
