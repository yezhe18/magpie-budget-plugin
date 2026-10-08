import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream';
import { restrictDirToOwner, restrictToOwner } from '../dist/permissions.mjs';

process.umask(0o077);
process.env.NODE_ENV = 'production';
delete process.env.ANTSEED_IDENTITY_HEX;
const directory = path.resolve(process.argv[2]);
const lock = path.join(directory, 'owner.lock');
const instance = randomUUID();
const secret = randomBytes(32).toString('hex');
const leases = new Map();
const components = new Map();
const jobs = new Map();
let stopping = false, lastUse = Date.now();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
if (!restrictDirToOwner(directory)) throw new Error('Cannot protect core state directory');

async function own() {
  for (let i = 0; i < 3; i++) {
    try { await fs.mkdir(lock, { mode: 0o700 }); await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, instance }), { mode: 0o600 }); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); if (alive(owner.pid)) return false; }
      catch { const st = await fs.stat(lock).catch(() => null); if (st && Date.now() - st.mtimeMs < 15000) return false; }
      const stale = lock + '.stale-' + instance;
      try { await fs.rename(lock, stale); await fs.rm(stale, { recursive: true, force: true }); }
      catch (e) { if (!['ENOENT', 'EEXIST'].includes(e.code)) throw e; }
    }
  }
  return false;
}
if (!await own()) process.exit(0);
const config = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
if (config.version !== 1) throw new Error('Unsupported config version. Expected version 1.');
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

async function component(name) {
  if (stopping) throw new Error('Core is stopping');
  if (config[name]?.enabled === false || (name === 'antseed' && config.antseed?.enabled !== true)) {
    const error = new Error(`${name} is disabled; edit config.json then run restart`); error.status = 503; throw error;
  }
  if (components.has(name)) return components.get(name);
  if (!jobs.has(name)) jobs.set(name, (async () => {
    const api = await import(`../dist/${name}.mjs`);
    const running = await (name === 'free' ? api.startFree : api.startAntseed)(path.join(directory, name), config[name]);
    components.set(name, running); return running;
  })().finally(() => jobs.delete(name)));
  return jobs.get(name);
}
const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
function proxy(req, res, target, apiKey, prefix) {
  const u = new URL(req.url.slice(prefix.length), target + '/');
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !hop.has(k) && k !== 'authorization'));
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const outbound = http.request(u, { method: req.method, headers }, incoming => {
    res.writeHead(incoming.statusCode, Object.fromEntries(Object.entries(incoming.headers).filter(([k]) => !hop.has(k))));
    pipeline(incoming, res, () => outbound.destroy());
  });
  req.on('aborted', () => outbound.destroy());
  res.on('close', () => { if (!res.writableEnded) outbound.destroy(); });
  outbound.on('error', error => { if (!res.headersSent) json(res, 502, { error: { message: error.message, type: 'core_upstream_error' } }); else res.destroy(error); });
  req.pipe(outbound);
}
async function readJSON(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new Error('Control request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${secret}`) return json(res, 401, { error: { message: 'Local core authorization required' } });
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/status') return json(res, 200, { instance, pid: process.pid, version: '0.3.0', state: stopping ? 'stopping' : 'running', clients: leases.size, components: Object.fromEntries(['free', 'antseed'].map(name => [name, components.get(name)?.status() || { state: config[name]?.enabled === false || (name === 'antseed' && config.antseed?.enabled !== true) ? 'disabled' : 'idle' }])) });
    if (req.method === 'POST' && pathname === '/lease') {
      if (stopping) return json(res, 503, { error: { message: 'Core is stopping' } });
      const body = await readJSON(req);
      if (!Number.isSafeInteger(body.pid) || body.pid <= 0 || typeof body.id !== 'string') return json(res, 400, { error: { message: 'Invalid lease' } });
      leases.set(body.id, { pid: body.pid, touched: Date.now() }); lastUse = Date.now(); return json(res, 200, { instance });
    }
    if (req.method === 'POST' && pathname === '/release') { const body = await readJSON(req); leases.delete(body.id); return json(res, 200, { ok: true }); }
    if (req.method === 'POST' && pathname === '/stop') { json(res, 200, { ok: true }); setImmediate(() => shutdown()); return; }
    for (const name of ['free', 'antseed']) {
      const prefix = '/' + name;
      if (pathname.startsWith(prefix + '/v1/')) { lastUse = Date.now(); const running = await component(name); return proxy(req, res, running.baseURL, running.apiKey, prefix); }
    }
    json(res, 404, { error: { message: 'Unknown core route' } });
  } catch (error) { json(res, error.status || 500, { error: { message: error.message, type: 'managed_core_error' } }); }
});
server.requestTimeout = 0;
server.headersTimeout = 76000;
server.keepAliveTimeout = 75000;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const descriptor = { pid: process.pid, instance, secret, url: `http://127.0.0.1:${server.address().port}`, version: '0.3.0' };
const descriptorPath = path.join(directory, 'run.json');
await fs.writeFile(descriptorPath + '.' + instance, JSON.stringify(descriptor), { mode: 0o600 });
await fs.rename(descriptorPath + '.' + instance, descriptorPath);
if (!restrictToOwner(descriptorPath)) throw new Error('Cannot protect core descriptor');
console.log('[budget core] ready, pid=' + process.pid);
const timer = setInterval(() => {
  for (const [id, lease] of leases) if (!alive(lease.pid) || Date.now() - lease.touched > 10000) leases.delete(id);
  if (!leases.size && Date.now() - lastUse > 5000) shutdown();
}, 1000);
async function shutdown() {
  if (stopping) return; stopping = true; clearInterval(timer);
  const deadline = setTimeout(() => process.exit(1), 12000); deadline.unref();
  server.closeIdleConnections();
  const closed = new Promise(resolve => server.close(resolve));
  await Promise.allSettled([...jobs.values()]); await closed;
  const results = await Promise.allSettled([...components.values()].map(x => x.close()));
  try {
    const d = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
    if (d.instance === instance) await fs.unlink(descriptorPath);
    const owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
    if (owner.instance === instance) await fs.rm(lock, { recursive: true, force: true });
  } catch (e) { if (e.code !== 'ENOENT') console.error('[budget core] cleanup:', e.message); }
  console.log('[budget core] closed'); process.exit(results.some(x => x.status === 'rejected') ? 1 : 0);
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
process.on('uncaughtException', e => { console.error('[budget core] fatal:', e.message); shutdown(); });
process.on('unhandledRejection', e => { console.error('[budget core] rejected:', e?.message || String(e)); shutdown(); });
