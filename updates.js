// Update checker: compares each app's local git checkout with GitHub and can fast-forward + rebuild + restart it.
// Recipes (what to rebuild/restart per app) live in updates.json, which is only read from disk - never editable through the API.
const fs = require('fs'), path = require('path'), http = require('http'), { execFile, spawn } = require('child_process');

const FILE = process.env.HUB_UPDATES_FILE || path.join(__dirname, 'updates.json');
const recipes = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; } };
const ENV = { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`, GIT_TERMINAL_PROMPT: '0' };
const git = (dir, args, t = 30000) => new Promise(ok => execFile('git', ['-C', dir, ...args], { env: ENV, timeout: t, maxBuffer: 1 << 24 },
  (e, out, err) => ok({ ok: !e, out: String(out).trim(), raw: String(out), err: String(err || (e && e.message) || '').trim() })));

const state = new Map(); // id -> last check result
const jobs = new Map();  // id -> { state: running|ok|failed, log: [], started, finished }
let checking = null;

async function checkOne(r) {
  const base = { id: r.id, name: r.name, icon: r.icon, checkedAt: Date.now() };
  if (!fs.existsSync(path.join(r.dir, '.git'))) return { ...base, status: 'error', message: 'Not a git checkout: ' + r.dir };
  const f = await git(r.dir, ['fetch', '-q', 'origin']);
  if (!f.ok) return { ...base, status: 'error', message: 'Could not reach GitHub: ' + (f.err.split('\n').pop() || 'fetch failed') };
  const branch = r.branch || (await git(r.dir, ['symbolic-ref', '--short', 'HEAD'])).out || 'main';
  const remoteRef = 'origin/' + branch;
  const [head, remote, counts, remoteUrl] = await Promise.all([git(r.dir, ['rev-parse', 'HEAD']), git(r.dir, ['rev-parse', remoteRef]),
    git(r.dir, ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`]), git(r.dir, ['remote', 'get-url', 'origin'])]);
  if (!head.ok || !remote.ok || !counts.ok) return { ...base, status: 'error', message: 'Branch ' + branch + ' not found on GitHub' };
  const [ahead, behind] = counts.out.split(/\s+/).map(Number);
  const repo = (remoteUrl.out.match(/github\.com[:/]([^/]+\/[^/.]+)/) || [])[1] || '';
  const res = { ...base, branch, repo, local: head.out.slice(0, 7), remote: remote.out.slice(0, 7), ahead, behind, commits: [], changed: [], blocked: [] };
  if (behind > 0) {
    res.commits = (await git(r.dir, ['log', '--format=%h\x1f%s\x1f%an', '-n', '8', `HEAD..${remoteRef}`])).out.split('\n').filter(Boolean).map(l => { const [h, s, a] = l.split('\x1f'); return { hash: h, subject: s, author: a }; });
    res.changed = (await git(r.dir, ['diff', '--name-only', `HEAD...${remoteRef}`])).out.split('\n').filter(Boolean);
    const dirty = (await git(r.dir, ['status', '--porcelain', '--untracked-files=no'])).raw.split('\n').filter(Boolean).map(l => l.slice(3).replace(/^.* -> /, ''));
    res.blocked = dirty.filter(d => res.changed.includes(d));
  }
  if (behind === 0 && ahead === 0) res.status = 'current';
  else if (behind === 0) { res.status = 'ahead'; res.message = `${ahead} local commit${ahead > 1 ? 's' : ''} not pushed to GitHub yet`; }
  else if (ahead > 0) { res.status = 'diverged'; res.message = 'Local and GitHub both have new commits; merge by hand'; }
  else if (res.blocked.length) { res.status = 'blocked'; res.message = 'Local edits in files the update changes: ' + res.blocked.slice(0, 3).join(', ') + (res.blocked.length > 3 ? '…' : ''); }
  else res.status = 'behind';
  return res;
}

async function checkAll() {
  if (checking) return checking;
  checking = (async () => {
    const rs = recipes();
    await Promise.all(rs.map(async r => { try { state.set(r.id, await checkOne(r)); } catch (e) { state.set(r.id, { id: r.id, name: r.name, status: 'error', message: String(e.message || e), checkedAt: Date.now() }); } }));
    for (const id of [...state.keys()]) if (!rs.some(r => r.id === id)) state.delete(id);
  })().finally(() => { checking = null; });
  return checking;
}
const checkId = async id => { const r = recipes().find(x => x.id === id); if (r) state.set(id, await checkOne(r)); };

const probe = (url, ms = 4000) => new Promise(ok => {
  const q = http.get(url, { timeout: ms }, r => { r.resume(); ok(r.statusCode < 500); });
  q.on('timeout', () => { q.destroy(); ok(false); }); q.on('error', () => ok(false));
});

function sh(job, dir, cmd) {
  return new Promise(ok => {
    const p = spawn('bash', ['-c', cmd], { cwd: dir, env: ENV });
    const feed = d => String(d).split('\n').map(s => s.trimEnd()).filter(Boolean).forEach(s => job.log.push('  ' + s.slice(0, 300)));
    p.stdout.on('data', feed); p.stderr.on('data', feed);
    p.on('error', e => { job.log.push('  ' + e.message); ok(false); });
    p.on('close', c => ok(c === 0));
  });
}
async function runSteps(job, r, changed) {
  for (const s of r.steps || []) {
    if (s.when && !changed.some(f => new RegExp(s.when).test(f))) continue;
    job.log.push('→ ' + s.label); if (!await sh(job, r.dir, s.run)) { job.log.push('✗ failed: ' + s.label); return false; }
  }
  if (r.restart) { job.log.push('→ Restarting'); if (!await sh(job, r.dir, r.restart)) { job.log.push('✗ restart failed'); return false; } }
  if (r.health && !r.self) {
    job.log.push('→ Waiting for it to come back');
    for (let i = 0; i < (r.healthTries || 20); i++) { await new Promise(o => setTimeout(o, 1500)); if (await probe(r.health)) return true; }
    job.log.push('✗ it did not respond after the update'); return false;
  }
  return true;
}

async function run(id) {
  const r = recipes().find(x => x.id === id); if (!r) throw new Error('Unknown app');
  if (jobs.get(id)?.state === 'running') return jobs.get(id);
  const job = { state: 'running', log: [], started: Date.now() }; jobs.set(id, job);
  (async () => {
    try {
      await checkId(id); const c = state.get(id);
      if (c.status !== 'behind') { job.log.push('Nothing to update: ' + (c.message || c.status)); job.state = c.status === 'current' ? 'ok' : 'failed'; return; }
      const old = (await git(r.dir, ['rev-parse', 'HEAD'])).out;
      job.log.push(`Updating ${c.local} → ${c.remote} (${c.behind} commit${c.behind > 1 ? 's' : ''})`);
      const m = await git(r.dir, ['merge', '--ff-only', 'origin/' + c.branch]);
      if (!m.ok) { job.log.push('✗ git refused: ' + m.err.split('\n')[0]); job.state = 'failed'; return; }
      if (await runSteps(job, r, c.changed)) { job.log.push('✓ Updated to ' + c.remote); job.state = 'ok'; }
      else {
        job.log.push('Rolling back to ' + old.slice(0, 7));
        await git(r.dir, ['reset', '--keep', old]); // --keep: never throws away local edits
        job.log.push((await runSteps(job, r, c.changed)) ? '✓ Rolled back; the old version is running again' : '✗ Rollback also had problems - check the app by hand');
        job.state = 'failed';
      }
    } catch (e) { job.log.push('✗ ' + String(e.message || e)); job.state = 'failed'; }
    finally {
      job.finished = Date.now(); await checkId(id).catch(() => {});
      if (r.self && job.state === 'ok') setTimeout(() => process.exit(0), 1500); // systemd (Restart=always) brings the hub back on the new code
    }
  })();
  return job;
}
// Everything that is behind, one after another, the hub itself last.
async function runAll() {
  await checkAll();
  const rs = recipes().filter(r => state.get(r.id)?.status === 'behind').sort((a, b) => !!a.self - !!b.self);
  for (const r of rs) { const j = await run(r.id); while (j.state === 'running') await new Promise(o => setTimeout(o, 500)); }
}

const view = () => recipes().map(r => ({ ...(state.get(r.id) || { id: r.id, name: r.name, icon: r.icon, status: 'unknown' }), self: !!r.self,
  job: jobs.has(r.id) ? { ...jobs.get(r.id), log: jobs.get(r.id).log.slice(-40) } : null }));
const stale = () => !state.size || Date.now() - Math.min(...[...state.values()].map(s => s.checkedAt || 0)) > 30 * 60 * 1000;
const running = () => [...jobs.values()].some(j => j.state === 'running');

module.exports = { checkAll, checkId, run, runAll, view, stale, running, start() { setTimeout(() => checkAll(), 20000).unref(); setInterval(() => { if (!running()) checkAll(); }, 6 * 3600 * 1000).unref(); } };
