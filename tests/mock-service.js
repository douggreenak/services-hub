// Tiny stand-in service used by the tests: cookie login (password "cookiepw"), shared sso.js, plus a "plain" mode with no login.
const http = require('http'), fs = require('fs'), path = require('path');
const [, , port, kind] = process.argv; // kind: cookie | plain
const sso = fs.readFileSync(path.join(__dirname, '..', '..', 'tv-adb-manager', 'web', 'sso.js'));
http.createServer((q, r) => {
  let d = ''; q.on('data', c => d += c); q.on('end', () => {
    const inn = /mockc=ok/.test(q.headers.cookie || '');
    const j = (c, o, h) => { r.writeHead(c, { 'Content-Type': 'application/json', ...h }); r.end(JSON.stringify(o)); };
    if (kind === 'checklist') {
      const chk = /chk=ok/.test(q.headers.cookie || '');
      const path = q.url.split('?')[0];
      if (path === '/sso.js') { r.writeHead(200, { 'Content-Type': 'text/javascript' }); return r.end(sso); }
      if (q.method === 'POST' && path === '/api/auth/login') {
        let pc; try { pc = JSON.parse(d).passcode; } catch {}
        return pc === 'pass-code' ? j(200, { success: true }, { 'Set-Cookie': 'chk=ok; HttpOnly; SameSite=Lax; Path=/; Max-Age=315360000' }) : j(401, { error: 'Incorrect passcode' });
      }
      if (q.method === 'POST' && path === '/api/auth/logout') return j(200, { ok: true }, { 'Set-Cookie': 'chk=; Path=/; Max-Age=0' });
      if (path.startsWith('/api/')) return chk ? j(200, { ok: true }) : j(401, { error: 'Unauthorized' });
      if (path === '/login') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end(`<script src="/sso.js" data-service="mockp" data-check="path:/login"></script><h1 id="state">LOGIN</h1><input type="password" id="pw">`); }
      if (!chk) { r.writeHead(302, { Location: '/login' }); return r.end(); }
      r.writeHead(200, { 'Content-Type': 'text/html' });
      return r.end(`<script src="/sso.js" data-service="mockp" data-check="path:/login"></script><h1 id="state">LOGGED-IN</h1><button id="out" onclick="fetch('/api/auth/logout',{method:'POST'}).then(()=>{location.href=(window.__HUB_ORIGIN__||'http://'+location.hostname+':8090')+'/logout'})">Log out</button>`);
    }
    if (kind === 'plain') { r.writeHead(200, { 'Content-Type': 'text/html' }); return r.end('<h1 id="state">PLAIN</h1>'); }
    if (q.url === '/sso.js') { r.writeHead(200, { 'Content-Type': 'text/javascript' }); return r.end(sso); }
    if (q.url === '/api/session') return j(200, { authenticated: inn });
    if (q.method === 'POST' && q.url === '/api/login') {
      let pw; try { pw = JSON.parse(d).password; } catch {}
      return pw === 'cookiepw' ? j(200, { ok: true }, { 'Set-Cookie': 'mockc=ok; Domain=example.com; HttpOnly; SameSite=Strict; Path=/' }) : j(401, { error: 'bad' });
    }
    if (q.method === 'POST' && q.url === '/api/logout') return j(200, { ok: true }, { 'Set-Cookie': 'mockc=; Path=/; Max-Age=0' });
    r.writeHead(200, { 'Content-Type': 'text/html' });
    r.end(`<script src="/sso.js" data-service="mockc" data-check="session:/api/session" data-logout="POST /api/logout"></script>
<h1 id="state">${inn ? 'LOGGED-IN' : 'LOGIN'}</h1>${inn ? '' : '<input type="password" id="pw">'}<button id="out" onclick="fetch('/api/logout',{method:'POST'})">Sign out</button>`);
  });
}).listen(+port, '0.0.0.0');
