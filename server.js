// Services Hub: dependency-free link directory with an editable service list.
const http = require('http'), fs = require('fs'), path = require('path'), net = require('net');
const PORT = +process.env.PORT || 8090;
const DATA = path.join(__dirname, 'services.json');
const PUB = path.join(__dirname, 'public');
const load = () => { try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch { return []; } };
const save = s => { fs.writeFileSync(DATA + '.tmp', JSON.stringify(s, null, 2)); fs.renameSync(DATA + '.tmp', DATA); };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const clean = b => ({
  name: String(b.name || '').trim().slice(0, 100),
  description: String(b.description || '').trim().slice(0, 500),
  url: String(b.url || '').trim().slice(0, 500),
  icon: String(b.icon || '').trim().slice(0, 500),
  controlled: !!b.controlled,
  dir: String(b.dir || '').trim().slice(0, 300),
  notes: String(b.notes || '').trim().slice(0, 2000),
});
const valid = c => c.name && /^https?:\/\/\S+$/.test(c.url);

// Is something listening where the URL points? (probed from the server itself)
function probe(url) {
  return new Promise(res => {
    let u; try { u = new URL(url.replace('{host}', 'localhost')); } catch { return res(false); }
    const s = net.connect({ host: u.hostname, port: +u.port || (u.protocol === 'https:' ? 443 : 80), timeout: 1000 });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.on('timeout', () => { s.destroy(); res(false); });
  });
}

const send = (r, code, obj) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, no) => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch (e) { no(e); } }); });

http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/services' && req.method === 'GET') {
      const list = load();
      return send(res, 200, await Promise.all(list.map(async s => ({ ...s, up: await probe(s.url) }))));
    }
    if (p === '/api/services' && req.method === 'POST') {
      const c = clean(await body(req));
      if (!valid(c)) return send(res, 400, { error: 'Name and an http(s) URL are required' });
      const list = load();
      const item = { id: Date.now().toString(36), ...c };
      list.push(item); save(list);
      return send(res, 201, item);
    }
    const m = p.match(/^\/api\/services\/([\w-]+)$/);
    if (m) {
      const list = load(), i = list.findIndex(s => s.id === m[1]);
      if (i < 0) return send(res, 404, { error: 'Not found' });
      if (req.method === 'PUT') {
        const c = clean(await body(req));
        if (!valid(c)) return send(res, 400, { error: 'Name and an http(s) URL are required' });
        list[i] = { id: list[i].id, ...c }; save(list);
        return send(res, 200, list[i]);
      }
      if (req.method === 'DELETE') { list.splice(i, 1); save(list); return send(res, 200, { ok: true }); }
    }
    // pages: / and /apps/<id> both serve the SPA shell
    let file = p === '/' || p.startsWith('/apps') ? 'index.html' : path.normalize(p).replace(/^(\.\.[\/\\])+/, '');
    const full = path.join(PUB, file);
    if (!full.startsWith(PUB) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) { send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, '0.0.0.0', () => console.log('Services Hub on :' + PORT));
