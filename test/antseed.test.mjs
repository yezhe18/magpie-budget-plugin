import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AntseedNode, LocalRouter, NatTraversal, CONNECTION_CAPABILITY_TCP_ENC_V1 } from '../dist/antseed.mjs';
import { temporary } from './helpers.mjs';

test('Real bundled AntSeed buyer and seller exchange inference over encrypted TCP', { timeout: 18000 }, async () => {
  const dir = await temporary('ant-p2p'); const original = NatTraversal.prototype.mapPorts;
  // Fixture discovery and NAT stay local. Transport, identities, stores,
  // request mux and inference all use the bundled upstream SDK.
  NatTraversal.prototype.mapPorts = async () => ({ success: false, externalIp: null, mappings: [] });
  const common = { payments: { enabled: false }, noOfficialBootstrap: true, bootstrapNodes: [], dhtPort: 0, signalingPort: 0,
    allowPrivateIPs: true, dhtOperationTimeoutMs: 100, requestTimeoutMs: 5000 };
  const seller = new AntseedNode({ ...common, role: 'seller', dataDir: path.join(dir, 'seller') });
  const buyer = new AntseedNode({ ...common, role: 'buyer', dataDir: path.join(dir, 'buyer') });
  seller.registerProvider({ name: 'fixture', services: ['fixture-model'], pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    maxConcurrency: 4, getCapacity: () => ({ current: 0, max: 4 }), serviceApiProtocols: { 'fixture-model': ['openai-chat-completions'] },
    async handleRequest(req) {
      const body = JSON.parse(Buffer.from(req.body).toString()); assert.equal(body.model, 'fixture-model');
      return { requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ id: 'ant-fixture', object: 'chat.completion', model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ant-fixture-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })) };
    } });
  buyer.setRouter(new LocalRouter());
  try {
    await seller.start(); await buyer.start();
    const peer = { peerId: seller.peerId, lastSeen: Date.now(), providers: ['fixture'], capabilities: [CONNECTION_CAPABILITY_TCP_ENC_V1],
      defaultInputUsdPerMillion: 0, defaultOutputUsdPerMillion: 0,
      providerPricing: { fixture: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, services: { 'fixture-model': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } } } };
    const req = { requestId: randomUUID(), method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'test' }] })) };
    const response = await buyer.sendRequest(peer, req);
    assert.equal(response.statusCode, 200); assert.equal(JSON.parse(Buffer.from(response.body).toString()).choices[0].message.content, 'ant-fixture-ok');
    assert.equal(buyer.getPeerConnectionState(seller.peerId), 'open');
  } finally { await buyer.stop(); await seller.stop(); NatTraversal.prototype.mapPorts = original; await fs.rm(dir, { recursive: true, force: true }); }
});
