// Starts the whole test stack on throwaway ports: a hub, the REAL TV Manager and REAL Jellyfin Fleet
// (backend + dashboard in docker), and two mock services. Nothing here touches production ports or data.
const { spawn, execSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const HOME = os.homedir();
const P = { hub: 18090, tvm: 18420, fleet: 18080, mockc: 18097, mockp: 18094, plain: 18096, down: 18095 };
const FLEET_DIR = path.join(HOME, 'apps/Jellyfin-Apple-TV/management-server');
const procs = []; let tmp;
const sh = (c, o) => { try { return execSync(c, { stdio: 'pipe', ...o }).toString(); } catch (e) { return ''; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitHttp(url, ms = 30000) {
  const t = Date.now();
  while (Date.now() - t < ms) { try { const r = await fetch(url); if (r.status < 500) return; } catch {} await sleep(250); }
  throw new Error('timeout waiting for ' + url);
}
const run = (cmd, args, opts) => { const p = spawn(cmd, args, { stdio: 'ignore', ...opts }); procs.push(p); return p; };

exports.ID = { tvm: 'tv-manager', fleet: 'jellyfin-fleet', mockc: 'mockc', mockp: 'mockp', plain: 'plain', down: 'down' }; // hub ids: the real services hard-code theirs
exports.P = P; exports.HUBPW = 'hubpass'; exports.CREDS = { tvm: { password: 'tvpass12' }, fleet: { username: 'admin', password: 'fleetpass' }, mockc: { password: 'cookiepw' }, mockp: { password: 'pass-code' } };

exports.start = async function () {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hubtest-'));
  fs.mkdirSync(tmp + '/tvm'); fs.mkdirSync(tmp + '/hub');
  // real TV Manager with a fake adb
  run('python3', ['-m', 'tvmanager', '--port', String(P.tvm), '--data', tmp + '/tvm', '--adb', path.join(HOME, 'tv-adb-manager/tools/fake_adb.py')],
    { cwd: path.join(HOME, 'tv-adb-manager'), env: { ...process.env, TVM_PASSWORD: 'tvpass12', FAKE_ADB_STATE: tmp + '/fleet.json' } });
  // real Fleet: backend + dashboard containers on a private network
  sh('docker rm -f hubtest-admin hubtest-server; docker network rm hubtest-net'); sh('docker network create hubtest-net');
  sh(`docker run -d --name hubtest-server --network hubtest-net --network-alias server -e PORT=4000 -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD=fleetpass -e JWT_SECRET=testsecret -e DB_PATH=/tmp/t.db -e ADMIN_ORIGIN='*' jellyfin-management-server`);
  sh(`docker run -d --name hubtest-admin --network hubtest-net -p ${P.fleet}:80 jellyfin-admin`);
  run('node', [path.join(__dirname, 'mock-service.js'), String(P.mockc), 'cookie']);
  run('node', [path.join(__dirname, 'mock-service.js'), String(P.plain), 'plain']);
  run('node', [path.join(__dirname, 'mock-service.js'), String(P.mockp), 'checklist']);
  await Promise.all([waitHttp(`http://localhost:${P.tvm}/api/session`), waitHttp(`http://localhost:${P.mockc}/api/session`), waitHttp(`http://localhost:${P.mockp}/sso.js`),
    waitHttp(`http://localhost:${P.fleet}/api/v1/admin/auth/me`)]);
  await sleep(500);
  return tmp;
};

const services = () => [
  { id: 'tv-manager', name: 'TV Manager', url: `http://{host}:${P.tvm}`, login: { mode: 'cookie', headers: { 'X-Requested-With': 'tvm' } } },
  { id: 'jellyfin-fleet', name: 'Jellyfin Fleet', url: `http://{host}:${P.fleet}`, login: { mode: 'token', username: 'admin' } },
  { id: 'mockc', name: 'Mock cookie', url: `http://{host}:${P.mockc}`, login: { mode: 'cookie' } },
  { id: 'mockp', name: 'Mock checklist', url: `http://{host}:${P.mockp}`, login: { mode: 'cookie', path: '/api/auth/login', passwordField: 'passcode' } }, // shaped like the Bethel checklist
  { id: 'plain', name: 'Plain', url: `http://{host}:${P.plain}`, login: { mode: 'none' } },
  { id: 'down', name: 'Down', url: `http://{host}:${P.down}`, login: { mode: 'cookie' } },
];
let hub = null;
// (Re)start a pristine hub: no password, no saved logins.
const stopHub = async () => { if (!hub) return; const h = hub; hub = null; const done = new Promise(r => h.once('exit', r)); h.kill(); await done; await sleep(100); };
exports.freshHub = async function () {
  await stopHub();
  fs.rmSync(tmp + '/hub', { recursive: true, force: true }); fs.mkdirSync(tmp + '/hub');
  fs.writeFileSync(tmp + '/hub/services.json', JSON.stringify(services()));
  hub = spawn('node', [path.join(__dirname, '..', 'server.js')], { stdio: 'ignore', env: { ...process.env, PORT: String(P.hub), HUB_DATA_DIR: tmp + '/hub' } });
  procs.push(hub);
  await waitHttp(`http://localhost:${P.hub}/api/auth/status`);
};
exports.restartHub = async function () { await stopHub();
  hub = spawn('node', [path.join(__dirname, '..', 'server.js')], { stdio: 'ignore', env: { ...process.env, PORT: String(P.hub), HUB_DATA_DIR: tmp + '/hub' } });
  procs.push(hub); await waitHttp(`http://localhost:${P.hub}/api/auth/status`); };
exports.hubDir = () => tmp + '/hub';
exports.stopService = k => { const i = { mockc: 0 }; /* only mockc is stoppable */ };
exports.stop = async function () {
  procs.forEach(p => { try { p.kill(); } catch {} });
  sh('docker rm -f hubtest-admin hubtest-server; docker network rm hubtest-net');
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
};
