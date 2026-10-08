import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { CoreManager, control, initialize, packageRoot, readRunning, stateDirectory } from '../core/manager.mjs';

const [command = 'status', ...args] = process.argv.slice(2);
function flag(name, fallback) { const i = args.indexOf('--' + name); return i < 0 ? fallback : args[i + 1]; }
const directory = stateDirectory(flag('state'));
const manager = new CoreManager({ stateDir: directory });
const executable = flag('magpie', process.platform === 'win32' ? 'magpie.exe' : 'magpie');
const own = (flag('own', '') || '').split(',').filter(Boolean);
const groupName = 'Magpie Budget';
const groupID = 'magpie-budget';
const recordFile = path.join(directory, 'installation.json');
async function configurationDirectory() {
  if (flag('config-dir')) return path.resolve(flag('config-dir'));
  const resolved = path.isAbsolute(executable) || executable.includes(path.sep) ? executable : await findExecutable(executable);
  const real = await fs.realpath(resolved);
  const beside = path.dirname(real);
  const portable = await fs.stat(path.join(beside, 'data')).then(x => x.isDirectory()).catch(e => { if (e.code === 'ENOENT') return false; throw e; });
  const marker = await fs.stat(path.join(beside, '.portable')).then(() => true).catch(e => { if (e.code === 'ENOENT') return false; throw e; });
  if (portable || marker) return path.join(beside, 'data');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'magpie');
}
async function findExecutable(name) {
  for (const folder of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(folder, name);
    if (await fs.stat(candidate).then(s => s.isFile()).catch(() => false)) return candidate;
  }
  throw new Error('Existing Magpie was not found. Pass --magpie followed by its executable path.');
}
async function cli(arguments_, input = '') {
  const env = { ...process.env, MAGPIE_BUDGET_STATE_DIR: directory, MAGPIE_NO_STATS: '1', DO_NOT_TRACK: '1' };
  const child = spawn(executable, arguments_, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x); child.stdin.end(input);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) throw new Error(`Magpie ${arguments_.slice(0, 2).join(' ')} failed (${code}): ${stderr || stdout}`);
  return stdout;
}
async function groups() {
  try { const data = JSON.parse(await fs.readFile(path.join(await configurationDirectory(), 'providers.json'), 'utf8')); return data.groups || []; }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
async function install() {
  await initialize(directory);
  if (command === 'upgrade') await manager.stop();
  const record = await fs.readFile(recordFile, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const existing = (await groups()).find(x => x.id === groupID);
  if (existing && !record) throw new Error('A user-owned magpie-budget group exists. Rename it before installation.');
  await cli(['plugin', 'add', packageRoot]);
  await cli(['plugin', 'options', packageRoot, JSON.stringify({ stateDir: directory })]);
  const listed = JSON.parse(await cli(['plugin', 'list', '--json']));
  for (const id of ['budget-free', 'budget-kilo', 'budget-antseed']) {
    const provider = listed.providers.find(x => x.id === id);
    if (!provider) throw new Error(`Plugin did not register ${id}`);
    if (!provider.signedIn) await cli(['plugin', 'login', id, '1'], 'budget-local\n');
  }
  const catalog = JSON.parse(await cli(['plugin', 'list', '--json']));
  const selectedOwn = own.length ? own : record?.addedOwnModels || [];
  const members = [];
  if (catalog.providers.find(x => x.id === 'budget-free')?.models.some(x => x.id === 'auto')) members.push('budget-free/auto');
  if (catalog.providers.find(x => x.id === 'budget-kilo')?.models.some(x => x.id === 'kilo-auto/free')) members.push('budget-kilo/kilo-auto/free');
  for (const model of catalog.providers.find(x => x.id === 'budget-antseed')?.models || []) members.push('budget-antseed/' + model.id);
  members.push(...selectedOwn);
  // No phantom routes: create defaults from the actual ready catalog. Upgrade
  // refreshes only our untouched group; routing edits made by the user win.
  const mayRefresh = !existing || JSON.stringify(existing) === JSON.stringify(record?.group);
  if (mayRefresh && members.length) await cli(['group', 'add', groupName, 'models=' + members.join(','), 'routing=order', 'stays=off']);
  const group = (await groups()).find(x => x.id === groupID);
  await fs.writeFile(recordFile, JSON.stringify({ version: '0.3.0', package: packageRoot, configurationDirectory: await configurationDirectory(), group: mayRefresh ? group : record?.group, addedOwnModels: selectedOwn }, null, 2) + '\n', { mode: 0o600 });
  console.log('Installed. Route: group/magpie-budget');
  console.log('Configuration: ' + path.join(directory, 'config.json'));
}
async function uninstall() {
  const record = JSON.parse(await fs.readFile(recordFile, 'utf8'));
  const group = (await groups()).find(x => x.id === groupID);
  if (group && JSON.stringify(group) === JSON.stringify(record.group)) await cli(['group', 'rm', groupID]);
  else if (group) console.log('Kept the routing group because you edited it.');
  await cli(['plugin', 'rm', record.package]);
  await manager.stop();
  await fs.unlink(recordFile);
  console.log('Uninstalled. Database, keys and identity are retained in ' + directory);
}
try {
  if (command === 'install' || command === 'upgrade') await install();
  else if (command === 'uninstall') await uninstall();
  else if (command === 'stop' || command === 'restart') { await manager.stop(); if (command === 'restart') await manager.ensure(); console.log(command + ' completed'); }
  else if (command === 'status') { const d = await readRunning(directory); console.log(JSON.stringify(d ? await control(d, '/status') : { state: 'stopped', directory }, null, 2)); }
  else if (command === 'start') { const d = await manager.ensure(); console.log(JSON.stringify(await control(d, '/status'), null, 2)); console.log('Core stays running while a Magpie host holds a lease.'); }
  else throw new Error('Usage: install|upgrade|status|stop|restart|uninstall [--state path] [--own provider/model,group/id] [--magpie executable] [--config-dir path]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await manager.close(); }
