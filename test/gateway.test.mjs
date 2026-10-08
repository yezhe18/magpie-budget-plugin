import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { CoreManager, readRunning } from '../core/manager.mjs';
import { temporary, fixture, freeConfiguration, root, delay } from './helpers.mjs';

const executable = process.env.BUDGET_TEST_MAGPIE;
test('Unmodified Magpie installs plugin, routes real Free/Kilo, preserves own groups, upgrades and uninstalls', { skip: !executable, timeout: 65000 }, async () => {
  const dir = await temporary('magpie'), upstream = await fixture(), kilo = await fixture();
  const state = path.join(dir, 'state'); await fs.mkdir(state);
  await fs.writeFile(path.join(state, 'config.json'), JSON.stringify({ ...freeConfiguration(upstream), kilo: { baseUrl: kilo.base } }));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_CACHE_HOME: path.join(dir, 'cache'),
    MAGPIE_BUDGET_STATE_DIR: state, MAGPIE_ADDR: `127.0.0.1:${port}`, MAGPIE_NO_STATS: '1', DO_NOT_TRACK: '1' };
  const core = new CoreManager({ stateDir: state }); let gateway;
  async function run(binary, args) {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
    const deadline = setTimeout(() => child.kill(), 22000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); clearTimeout(deadline);
    assert.equal(code, 0, stdout + '\n' + stderr); return stdout;
  }
  const cli = (...args) => run(executable, args);
  const helper = (...args) => run(process.env.MAGPIE_BUN || process.execPath, [path.join(root, 'bin/cli.mjs'), ...args, '--state', state, '--magpie', executable, '--config-dir', path.join(env.XDG_CONFIG_HOME, 'magpie')]);
  try {
    await cli('plugin', 'add', root);
    const catalog = JSON.parse(await cli('plugin', 'list', '--json'));
    assert.equal(catalog.providers.length, 3); assert.ok(catalog.providers.find(x => x.id === 'budget-free').signedIn);
    assert.ok(catalog.providers.find(x => x.id === 'budget-free').models.some(x => x.id === 'fixture-model'));
    await cli('group', 'add', 'User Pool', 'models=budget-kilo/kilo-auto/free', 'routing=order');
    const providersFile = path.join(env.XDG_CONFIG_HOME, 'magpie/providers.json');
    const own = JSON.parse(await fs.readFile(providersFile, 'utf8')).groups.find(x => x.id === 'user-pool');
    await helper('install', '--own', 'group/user-pool');
    let groups = JSON.parse(await fs.readFile(providersFile, 'utf8')).groups;
    assert.deepEqual(groups.find(x => x.id === 'user-pool'), own);
    assert.ok(groups.find(x => x.id === 'magpie-budget').members.includes('group/user-pool'));
    gateway = spawn(executable, ['serve'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let log = ''; gateway.stdout.on('data', b => log += b); gateway.stderr.on('data', b => log += b);
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 12000; let ready = false;
    while (Date.now() < deadline) { try { const r = await fetch(base + '/v1/models', { signal: AbortSignal.timeout(600) }); if (r.ok) { ready = true; break; } } catch {} await delay(100); }
    assert.ok(ready, log);
    const send = (model, body = {}) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'test' }], ...body }), signal: AbortSignal.timeout(15000) });
    let r = await send('budget-free/fixture-model'); let reply = await r.json(); assert.equal(r.status, 200, JSON.stringify(reply)); assert.equal(reply.choices[0].message.content, 'fixture-ok');
    r = await send('budget-free/fixture-model', { stream: true }); assert.equal(r.status, 200); const sse = await r.text(); assert.match(sse, /fixture-ok/); assert.match(sse, /\[DONE\]/);
    r = await send('budget-kilo/kilo-auto/free'); reply = await r.json(); assert.equal(r.status, 200, JSON.stringify(reply)); assert.equal(kilo.calls.at(-1).headers.authorization, undefined);
    r = await send('group/magpie-budget'); reply = await r.json(); assert.equal(r.status, 200, JSON.stringify(reply));
    r = await send('group/magpie-budget', { messages: [{ role: 'user', content: 'rate-limit' }] }); reply = await r.json(); assert.equal(r.status, 200, JSON.stringify(reply));
    assert.ok(kilo.calls.some(x => x.body.messages?.some(m => m.content === 'rate-limit')));
    gateway.kill('SIGTERM'); await new Promise(resolve => gateway.once('close', resolve)); gateway = null;
    await helper('upgrade');
    groups = JSON.parse(await fs.readFile(providersFile, 'utf8')).groups; assert.deepEqual(groups.find(x => x.id === 'user-pool'), own);
    await helper('uninstall');
    const installed = JSON.parse(await fs.readFile(path.join(env.XDG_CONFIG_HOME, 'magpie/plugins.json'), 'utf8'));
    assert.ok(!installed.plugins.some(x => x.spec === root));
    groups = JSON.parse(await fs.readFile(providersFile, 'utf8')).groups;
    assert.deepEqual(groups.find(x => x.id === 'user-pool'), own); assert.ok(!groups.some(x => x.id === 'magpie-budget'));
    assert.equal(await readRunning(state), null);
    assert.ok((await fs.stat(path.join(state, 'free/freeapi.db'))).size > 0);
  } finally { if (gateway) { gateway.kill('SIGTERM'); await new Promise(resolve => gateway.once('close', resolve)); } await core.stop().catch(() => {}); await upstream.close(); await kilo.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
