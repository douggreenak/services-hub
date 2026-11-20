// Services Hub: link directory with a single login that signs you in to the other services.
const os = require('os'), http = require('http'), fs = require('fs'), path = require('path'), net = require('net'), crypto = require('crypto');
const PORT = +process.env.PORT || 8090;
const DIR = process.env.HUB_DATA_DIR || __dirname; // where services.json, auth.json and vault.json live
const DATA = path.join(DIR, 'services.json');
const AUTH = path.join(DIR, 'auth.json');     // password verifier (scrypt) - gitignored
const SESS = path.join(DIR, 'sessions.json');   // signed-in browsers (hashed) + the vault key, so logins survive restarts - gitignored
const VAULT = path.join(DIR, 'vault.json');   // service passwords, AES-256-GCM encrypted - gitignored
const PUB = path.join(__dirname, 'public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/manifest+json' };

const updates = require('./updates');

/* ---------- storage ---------- */
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o, mode) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o, null, 2), { mode }); fs.renameSync(f + '.tmp', f); };
const load = () => readJSON(DATA, []);
const save = s => writeJSON(DATA, s, 0o644);

/* ---------- hub password + vault ---------- */
let vaultKey = null; // derived from the hub password; only in memory, set at login
const derive = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, { N: 16384 }, (e, k) => e ? no(e) : ok(k)));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
async function checkPassword(pw) {
  const a = readJSON(AUTH, null); if (!a) return false;
  const d = await derive(pw, Buffer.from(a.salt, 'hex'));
  if (!crypto.timingSafeEqual(Buffer.from(sha(d.subarray(0, 32))), Buffer.from(a.verifier))) return false;
  vaultKey = d.subarray(32); return true;
}
async function setupPassword(pw) {
  const salt = crypto.randomBytes(16), d = await derive(pw, salt);
  writeJSON(AUTH, { salt: salt.toString('hex'), verifier: sha(d.subarray(0, 32)) }, 0o600);
  vaultKey = d.subarray(32);
}
function vaultRead() {
  const v = readJSON(VAULT, null); if (!v || !vaultKey) return {};
  try {
    const dc = crypto.createDecipheriv('aes-256-gcm', vaultKey, Buffer.from(v.iv, 'hex'));
    dc.setAuthTag(Buffer.from(v.tag, 'hex'));
    return JSON.parse(Buffer.concat([dc.update(Buffer.from(v.data, 'hex')), dc.final()]).toString());
  } catch { return {}; }
}
function vaultWrite(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', vaultKey, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  writeJSON(VAULT, { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') }, 0o600);
}

/* ---------- sessions (kept until the user signs out) + login throttle ---------- */
// A signed-in browser stays signed in forever, across restarts and reboots. Only a SHA-256 of each session
// token is stored. So the saved service logins can still be decrypted after a restart, the vault key is kept
// in sessions.json (0600) for as long as at least one browser is signed in; the last sign-out removes it.
const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
const sessions = new Map(Object.entries(readJSON(SESS, { sessions: {} }).sessions)); // sha256(token) -> created
{ const k = readJSON(SESS, {}).key; if (k && sessions.size) vaultKey = Buffer.from(k, 'hex'); }
const persistSessions = () => {
  if (!sessions.size) { try { fs.unlinkSync(SESS); } catch {} return; }
  writeJSON(SESS, { sessions: Object.fromEntries(sessions), key: vaultKey ? vaultKey.toString('hex') : undefined }, 0o600);
};
const newSession = () => { const t = crypto.randomBytes(32).toString('hex'); sessions.set(sha256(t), Date.now()); persistSessions(); return t; };
const dropSession = t => { if (t && sessions.delete(sha256(t))) persistSessions(); };
const cookieOf = (req, name) => { const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)')); return m ? m[1] : null; };
const authed = req => { const t = cookieOf(req, 'hub_session'); return !!t && sessions.has(sha256(t)); };
const SESSION_SECS = 400 * 86400; // browsers cap cookie life at 400 days, so every visit renews it: effectively forever
const sessionCookie = t => `hub_session=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_SECS}`;
const fails = new Map();
const locked = ip => (fails.get(ip)?.until || 0) > Date.now();
const noteFail = ip => { const f = fails.get(ip) || { n: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } fails.set(ip, f); };

/* ---------- services ---------- */
const MODES = ['none', 'cookie', 'token'];
const clean = b => {
  const l = b.login || {}, mode = MODES.includes(l.mode) ? l.mode : 'none';
  return {
    name: String(b.name || '').trim().slice(0, 100),
    description: String(b.description || '').trim().slice(0, 500),
    url: String(b.url || '').trim().slice(0, 500),
    icon: String(b.icon || '').trim().slice(0, 500),
    controlled: !!b.controlled,
    dir: String(b.dir || '').trim().slice(0, 300),
    notes: String(b.notes || '').trim().slice(0, 2000),
    login: { mode, path: String(l.path || '').trim().slice(0, 200), username: String(l.username || '').trim().slice(0, 100),
      ...(l.passwordField ? { passwordField: String(l.passwordField).replace(/[^\w-]/g, '').slice(0, 40) } : {}),
      ...(l.headers && typeof l.headers === 'object' ? { headers: Object.fromEntries(Object.entries(l.headers).slice(0, 10).map(([k, v]) => [String(k).slice(0, 60), String(v).slice(0, 200)])) } : {}) },
  };
};
const valid = c => c.name && /^https?:\/\/\S+$/.test(c.url);
const pub = (s, vault) => ({ ...s, login: { mode: 'none', path: '', username: '', ...s.login, hasPassword: !!vault[s.id] } });
const defPath = m => m === 'token' ? '/api/v1/admin/auth/login' : '/api/login';

function probe(url) {
  return new Promise(res => {
    let u; try { u = new URL(url.replace('{host}', 'localhost')); } catch { return res(false); }
    const s = net.connect({ host: u.hostname, port: +u.port || (u.protocol === 'https:' ? 443 : 80), timeout: 1000 });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.on('timeout', () => { s.destroy(); res(false); });
  });
}

const send = (r, code, obj, extra) => { r.writeHead(code, { 'Content-Type': 'application/json', ...extra }); r.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { no(e); } }); });
const ipOf = req => req.socket.remoteAddress || '';
const hostOf = req => (req.headers.host || 'localhost').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
const page = (res, code, html) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- /go/<id>: sign in to the service for the user, then send them there ---------- */
const htmlPage = (res, code, inner) => page(res, code, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Services Hub</title><style>body{font:16px system-ui,sans-serif;max-width:440px;margin:12vh auto;padding:0 20px;color:#161d1d}input{display:block;width:100%;box-sizing:border-box;margin:6px 0 14px;padding:12px;font:inherit;border:2px solid #6f7979;border-radius:12px}button{font:600 15px system-ui;padding:12px 22px;border:0;border-radius:22px;background:#006a6a;color:#fff;cursor:pointer}.e{color:#ba1a1a}a{color:#006a6a}</style><body>${inner}`);

// Log in to the service from the server side. Returns {cookies} or {token}.
async function serviceLogin(s, username, password) {
  const mode = s.login.mode, origin = new URL(s.url.replace('{host}', 'localhost')).origin;
  const r = await fetch(origin + (s.login.path || defPath(mode)), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(s.login.headers || {}) }, signal: AbortSignal.timeout(6000),
    body: JSON.stringify(mode === 'token' ? { username, password } : { [s.login.passwordField || 'password']: password }),
  });
  if (r.status === 401 || r.status === 403) throw new Error('The service rejected that login.');
  if (!r.ok) throw new Error('The service answered HTTP ' + r.status + '.');
  if (mode === 'token') { const j = await r.json().catch(() => ({})); if (!j.token) throw new Error('The service sent no token.'); return { token: j.token }; }
  const cookies = (r.headers.getSetCookie?.() || []).map(c => c.replace(/;\s*Domain=[^;]*/i, ''));
  if (!cookies.length) throw new Error('The service set no session cookie.');
  return { cookies };
}

function loginForm(s, msg, noSso) {
  const tok = s.login.mode === 'token';
  return `<h2>Sign in to ${esc(s.name)}</h2><p>The hub will remember this login, encrypted, so you only enter it once.</p>${msg ? `<p class=e>${esc(msg)}</p>` : ''}
<form method=post action="/go/${esc(s.id)}/login">${tok ? `<label>Username<input name=username value="${esc(s.login.username || '')}" autocomplete=off></label>` : ''}<label>Password<input type=password name=password autofocus required></label><button>Sign in</button></form>
<p><a href="${esc(noSso)}">Open ${esc(s.name)} without signing in</a> · <a href="/">Back to hub</a></p>`;
}

async function go(req, res, id) {
  const s = load().find(x => x.id === id);
  if (!s) return page(res, 404, 'Unknown service');
  const sso = new URL(req.url, 'http://x').searchParams.has('sso'); // the service itself sent us here because it needs a login
  const target = s.url.replace('{host}', hostOf(req));
  const open = (t, extra) => { res.writeHead(302, { Location: t, ...extra }); res.end(); };
  const noSso = target + (target.includes('?') ? '&' : '?') + 'nosso=1'; // open the service's own login, don't bounce back
  const mode = s.login?.mode || 'none';
  if ((mode !== 'none' || sso) && !authed(req)) return open('/?next=' + encodeURIComponent(req.url));
  if (mode === 'none') return sso ? htmlPage(res, 200, `<h2>${esc(s.name)} needs a login</h2><p>The hub has no auto-login set up for it.</p><p><a href="/?edit=${esc(s.id)}">Set up auto-login</a> · <a href="${esc(noSso)}">Open ${esc(s.name)} anyway</a> · <a href="/">Back to hub</a></p>`) : open(target);
  const pw = vaultRead()[s.id]?.password;
  if (!pw) return htmlPage(res, 200, loginForm(s, '', noSso));
  try {
    const r = await serviceLogin(s, s.login.username, pw);
    if (r.token) return open(target + '#sso=' + encodeURIComponent(r.token));
    return open(target, { 'Set-Cookie': r.cookies });
  } catch (e) { return htmlPage(res, 200, loginForm(s, "The saved login didn't work: " + e.message, noSso)); }
}

// The form on the page above: try the login, and only if it works save it and continue.
async function goLogin(req, res, id) {
  if (!authed(req) || !vaultKey) { res.writeHead(302, { Location: '/?next=' + encodeURIComponent('/go/' + id) }); return res.end(); }
  const s = load().find(x => x.id === id);
  if (!s || (s.login?.mode || 'none') === 'none') return page(res, 404, 'Unknown service');
  let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1e4) break; }
  const f = new URLSearchParams(raw), pw = f.get('password') || '', user = (f.get('username') || s.login.username || '').trim();
  const target = s.url.replace('{host}', hostOf(req)), noSso = target + (target.includes('?') ? '&' : '?') + 'nosso=1';
  try {
    await serviceLogin(s, user, pw);
    const list = load(), i = list.findIndex(x => x.id === id); list[i].login.username = user; save(list);
    const v = vaultRead(); v[id] = { password: pw }; vaultWrite(v);
    res.writeHead(302, { Location: '/go/' + id }); res.end();
  } catch (e) { s.login.username = user; htmlPage(res, 200, loginForm(s, e.message, noSso)); }
}

http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    const ip = ipOf(req);

    if (p === '/api/auth/status') {
      const ok = authed(req); // the page asks this on every load: renew the cookie so an active browser never expires
      return send(res, 200, { setup: !fs.existsSync(AUTH), authed: ok }, ok ? { 'Set-Cookie': sessionCookie(cookieOf(req, 'hub_session')) } : undefined);
    }
    if (p === '/api/auth/setup' && req.method === 'POST') {
      if (fs.existsSync(AUTH)) return send(res, 409, { error: 'A password is already set' });
      const pw = String((await body(req)).password || '');
      if (pw.length < 4) return send(res, 400, { error: 'Use at least 4 characters' });
      await setupPassword(pw);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(newSession()) });
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      if (locked(ip)) return send(res, 429, { error: 'Too many attempts. Wait a minute.' });
      const pw = String((await body(req)).password || '');
      if (!(await checkPassword(pw))) { noteFail(ip); return send(res, 401, { error: 'Wrong password' }); }
      fails.delete(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(newSession()) });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      dropSession(cookieOf(req, 'hub_session'));
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'hub_session=; HttpOnly; Path=/; Max-Age=0' });
    }

    if (p === '/logout') { dropSession(cookieOf(req, 'hub_session')); res.writeHead(302, { Location: '/', 'Set-Cookie': 'hub_session=; HttpOnly; Path=/; Max-Age=0' }); return res.end(); }
    const gl = p.match(/^\/go\/([\w-]+)\/login$/);
    if (gl && req.method === 'POST') return goLogin(req, res, gl[1]);
    const g = p.match(/^\/go\/([\w-]+)$/);
    if (g) return go(req, res, g[1]);

    if (p.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'login required' });
      if (!vaultKey) return send(res, 401, { error: 'login required' }); // e.g. server restarted
      const vault = vaultRead();
      if (p === '/api/info') {
        const ip = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;
        return send(res, 200, { lanUrl: ip ? `http://${ip}:${PORT}/apps` : null });
      }
      if (p === '/api/updates' && req.method === 'GET') { if (updates.stale() && !updates.running()) updates.checkAll(); return send(res, 200, updates.view()); }
      if (p === '/api/updates/check' && req.method === 'POST') { await updates.checkAll(); return send(res, 200, updates.view()); }
      if (p === '/api/updates/run-all' && req.method === 'POST') { updates.runAll(); return send(res, 202, { ok: true }); }
      const um = p.match(/^\/api\/updates\/([\w-]+)\/run$/);
      if (um && req.method === 'POST') { try { await updates.run(um[1]); return send(res, 202, { ok: true }); } catch (e) { return send(res, 404, { error: e.message }); } }
      if (p === '/api/services' && req.method === 'GET') {
        return send(res, 200, await Promise.all(load().map(async s => ({ ...pub(s, vault), up: await probe(s.url) }))));
      }
      if (p === '/api/services' && req.method === 'POST') {
        const b = await body(req), c = clean(b);
        if (!valid(c)) return send(res, 400, { error: 'Name and an http(s) URL are required' });
        const list = load(), item = { id: Date.now().toString(36), ...c };
        list.push(item); save(list);
        if (c.login.mode !== 'none' && b.login?.password) { vault[item.id] = { password: String(b.login.password) }; vaultWrite(vault); }
        return send(res, 201, pub(item, vaultRead()));
      }
      const m = p.match(/^\/api\/services\/([\w-]+)$/);
      if (m) {
        const list = load(), i = list.findIndex(s => s.id === m[1]);
        if (i < 0) return send(res, 404, { error: 'Not found' });
        if (req.method === 'PUT') {
          const b = await body(req), c = clean(b);
          if (!valid(c)) return send(res, 400, { error: 'Name and an http(s) URL are required' });
          const keep = list[i].login?.headers, keepF = list[i].login?.passwordField; list[i] = { id: list[i].id, ...c }; if (keep && !c.login.headers) list[i].login.headers = keep; if (keepF && !c.login.passwordField) list[i].login.passwordField = keepF; save(list); // extra login headers aren't editable in the UI: keep them
          if (c.login.mode === 'none') delete vault[m[1]];
          else if (b.login?.password) vault[m[1]] = { password: String(b.login.password) }; // blank keeps the saved one
          vaultWrite(vault);
          return send(res, 200, pub(list[i], vaultRead()));
        }
        if (req.method === 'DELETE') { list.splice(i, 1); save(list); delete vault[m[1]]; vaultWrite(vault); return send(res, 200, { ok: true }); }
      }
      return send(res, 404, { error: 'Not found' });
    }

    let file = p === '/' || p.startsWith('/apps') ? 'index.html' : path.normalize(p).replace(/^(\.\.[\/\\])+/, '');
    const full = path.join(PUB, file);
    if (!full.startsWith(PUB) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream', ...(file === 'sw.js' ? { 'Cache-Control': 'no-cache' } : {}) });
    fs.createReadStream(full).pipe(res);
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, '0.0.0.0', () => { console.log('Services Hub on :' + PORT); updates.start(); });
