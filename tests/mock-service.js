// Tiny stand-in service used by the tests: cookie login (password "cookiepw"), shared sso.js, plus a "plain" mode with no login.
const http = require('http'), fs = require('fs'), path = require('path');
const [, , port, kind] = process.argv; // kind: cookie | plain
const sso = fs.readFileSync(path.join(__dirname, '..', '..', 'tv-adb-manager', 'web', 'sso.js'));
http.createServer((q, r) => {
  let d = ''; q.on('data', c => d += c); q.on('end', () => {
    const inn = /mockc=ok/.test(q.headers.cookie || '');
    const j = (c, o, h) => { r.writeHead(c, { 'Content-Type': 'application/json', ...h }); r.end(JSON.stringify(o)); };
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
