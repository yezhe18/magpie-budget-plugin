import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from '../dist/sqlite.mjs';
import { _internal as free } from '../core/free-adapter.mjs';
import { _internal as ant } from '../core/antseed-adapter.mjs';
import { kiloHooks } from '../core/kilo-adapter.mjs';
import { Kilo } from '../index.js';
import { temporary, fixture } from './helpers.mjs';

test('SQLite preserves named bindings, nested rollback and synchronous transactions', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE quota(k TEXT UNIQUE,n INTEGER)');
    const add = db.prepare('INSERT INTO quota VALUES(@k,@n)');
    db.transaction(() => {
      add.run({ k: 'outer', n: 1 });
      assert.throws(() => db.transaction(() => { add.run({ k: 'inner', n: 2 }); throw new Error('rollback'); })(), /rollback/);
      assert.equal(db.inTransaction, true);
    }).immediate();
    assert.deepEqual(db.prepare('SELECT k,n FROM quota').all().map(x => ({ ...x })), [{ k: 'outer', n: 1 }]);
    assert.throws(() => db.transaction(() => { add.run({ k: 'async', n: 3 }); return Promise.resolve(); })(), /synchronous/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM quota').get().n, 1);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally { db.close(); }
});
test('Free catalog exposes ready models and auto only when an executable pool exists', () => {
  const data = [{ id: 'auto', owned_by: 'freellmapi', available: true }, { id: 'unready', owned_by: 'custom', available: true, execution_status: 'needsKey' },
    { id: 'ready', owned_by: 'custom', available: true, execution_status: 'ready', supported_parameters: ['tools'] }];
  const models = free.modelsOf(data, 'http://127.0.0.1:1/v1');
  assert.deepEqual(Object.keys(models), ['auto', 'ready']); assert.equal(models.ready.cost, undefined); assert.equal(models.auto.capabilities.toolcall, true);
  assert.deepEqual(Object.keys(free.modelsOf(data.slice(0, 2), 'http://127.0.0.1:1/v1')), []);
});
test('AntSeed prices use the eligible offer ceiling and unknown costs remain unknown', () => {
  const offers = [{ inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 }, { inputUsdPerMillion: 0.3, outputUsdPerMillion: 0.4 }];
  assert.equal(ant.costOf(offers).output, 0.4); assert.equal(ant.costOf([...offers, {}]), undefined);
  assert.equal(ant.npmFor([{ protocol: 'anthropic-messages' }]), '@ai-sdk/anthropic');
  assert.equal(ant.npmFor([{ protocol: 'anthropic-messages' }, { protocol: 'openai-chat-completions' }]), '@ai-sdk/openai-compatible');
});
test('Kilo only sends the free model and removes local credentials', async () => {
  const dir = await temporary('kilo'), upstream = await fixture();
  try {
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ kilo: { baseUrl: upstream.base } }));
    const hooks = await kiloHooks({}, { stateDir: dir });
    const loader = await hooks.auth.loader();
    const response = await loader.fetch(upstream.base + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer local-secret', 'x-api-key': 'local-secret', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'kilo-auto/free', messages: [{ role: 'user', content: 'test' }] }) });
    assert.equal(response.status, 200); assert.equal(upstream.calls[0].headers.authorization, undefined); assert.equal(upstream.calls[0].headers['x-api-key'], undefined);
    await assert.rejects(loader.fetch(upstream.base + '/chat/completions', { body: JSON.stringify({ model: 'paid-model' }) }), /only allows/);
    await assert.rejects(loader.fetch('http://127.0.0.1:1/chat/completions'), /Unexpected/);
  } finally { await upstream.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('Plugin creates its local account once and preserves existing provider accounts', async () => {
  const dir = await temporary('account'); const saved = [];
  try {
    const input = { directory: dir, client: { auth: { set: async x => saved.push(x) } } };
    await Kilo.server(input, { stateDir: dir }); assert.equal(saved[0].path.id, 'budget-kilo');
    await fs.writeFile(path.join(dir, 'plugin-auth.json'), JSON.stringify({ 'budget-kilo': { type: 'api', key: 'existing' }, mine: { key: 'mine' } }));
    await Kilo.server(input, { stateDir: dir }); assert.equal(saved.length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
