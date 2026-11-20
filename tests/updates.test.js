// Update checker: runs against throwaway git repos (a bare "GitHub" + a checkout), never the real apps.
// Run: node --test --test-concurrency=1 --test-reporter=spec tests/updates.test.js
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), { execSync, spawn } = require('child_process');
const { chromium } = require(process.env.PW_CORE || '/home/jellyfin/pwtest/node_modules/playwright-core');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'hubupd-')), PORT = 18091, B = `http://localhost:${PORT}`;
const sh = (c, cwd) => execSync(c, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
// Each app: bare origin, a "server" clone that pushes new commits, and the checkout the hub manages.
function mkRepo(k) {
  const o = `${T}/${k}.git`, up = `${T}/${k}-up`, w = `${T}/${k}`;
  sh(`git init -q --bare -b main ${o}`); sh(`git clone -q ${o} ${up}`); sh(`echo v1 > file.txt && git add . && git commit -qm "first" && git push -q origin HEAD:main`, up);
  sh(`git clone -q ${o} ${w}`); return { o, up, w };
}
const push = (r, msg, file = 'file.txt') => { sh(`echo "${msg}" >> ${file} && git add . && git commit -qm "${msg}" && git push -q origin HEAD:main`, r.up); };
const R = Object.fromEntries(['ok', 'new', 'dirty', 'ahead', 'bad', 'step'].map(k => [k, mkRepo(k)]));
fs.writeFileSync(`${T}/health`, 'x'); // health = the file-based "is it up" signal for the fixture apps
const recipe = (id, extra = {}) => ({ id, name: id, dir: R[id].w, steps: [], ...extra });
let hub, ck, browser, ctx;
const api = async (m, u, b) => { const r = await ctx.request.fetch(B + u, { method: m, data: b }); return { s: r.status(), j: await r.json().catch(() => null) }; };
const settle = async id => { for (let i = 0; i < 60; i++) { const u = (await api('GET', '/api/updates')).j.find(x => x.id === id); if (u.job && u.job.state !== 'running') return u; await new Promise(o => setTimeout(o, 200)); } throw new Error('job never finished'); };
const get = async id => (await api('POST', '/api/updates/check')).j.find(x => x.id === id);

test.before(async () => {
  push(R.new, 'second'); push(R.new, 'third', 'other.txt');
  fs.appendFileSync(`${R.dirty.w}/file.txt`, 'my local edit\n'); push(R.dirty, 'upstream edit');       // local edit to a file the update changes
  sh(`echo mine > mine.txt && git add . && git commit -qm local`, R.ahead.w);                           // unpushed local commit
  push(R.bad, 'breaks');                                                                                 // health check will fail -> rollback
  push(R.step, 'needs-step');                                                                            // a build step will fail -> rollback
  fs.writeFileSync(`${T}/updates.json`, JSON.stringify([
    recipe('ok'),
    recipe('new', { steps: [{ label: 'touch built', when: '^other\\.txt$', run: 'echo built > built.txt' }, { label: 'never', when: '^nomatch$', run: 'echo no > no.txt' }] }),
    recipe('dirty'), recipe('ahead'),
    recipe('bad', { health: 'http://localhost:1/', healthTries: 2 }),
    recipe('step', { steps: [{ label: 'explode', run: 'echo kaboom >&2; exit 3' }] }),
  ]));
  fs.mkdirSync(`${T}/hub`); fs.writeFileSync(`${T}/hub/services.json`, '[]');
  hub = spawn('node', [path.join(__dirname, '..', 'server.js')], { stdio: 'ignore', env: { ...process.env, PORT: String(PORT), HUB_DATA_DIR: `${T}/hub`, HUB_UPDATES_FILE: `${T}/updates.json` } });
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/api/auth/status'); break; } catch { await new Promise(o => setTimeout(o, 200)); } }
  browser = await chromium.launch(); ctx = await browser.newContext();
  assert.equal((await api('POST', '/api/auth/setup', { password: 'hubpass' })).s, 200);
});
test.after(async () => { await browser?.close(); hub?.kill(); fs.rmSync(T, { recursive: true, force: true }); });

test('needs a signed-in session', async () => {
  const c = await browser.newContext(); const r = await c.request.get(B + '/api/updates'); assert.equal(r.status(), 401);
  assert.equal((await c.request.post(B + '/api/updates/new/run')).status(), 401); await c.close();
});
test('classifies each app against GitHub', async () => {
  const all = (await api('POST', '/api/updates/check')).j, by = Object.fromEntries(all.map(u => [u.id, u]));
  assert.equal(by.ok.status, 'current'); assert.equal(by.new.status, 'behind'); assert.equal(by.new.behind, 2);
  assert.deepEqual(by.new.commits.map(c => c.subject), ['third', 'second']);
  assert.equal(by.dirty.status, 'blocked'); assert.match(by.dirty.message, /file\.txt/);
  assert.equal(by.ahead.status, 'ahead'); assert.equal(by.bad.status, 'behind');
});
test('unreachable remote is reported, not fatal', async () => {
  fs.renameSync(R.ok.o, R.ok.o + '.gone'); const u = await get('ok'); fs.renameSync(R.ok.o + '.gone', R.ok.o);
  assert.equal(u.status, 'error'); assert.match(u.message, /GitHub/);
});
test('update fast-forwards, runs only the steps whose files changed', async () => {
  assert.equal((await api('POST', '/api/updates/new/run')).s, 202);
  const u = await settle('new'); assert.equal(u.job.state, 'ok', u.job.log.join('\n'));
  assert.equal(sh('git rev-parse HEAD', R.new.w), sh('git rev-parse origin/main', R.new.w));
  assert.ok(fs.existsSync(`${R.new.w}/built.txt`), 'matching step ran'); assert.ok(!fs.existsSync(`${R.new.w}/no.txt`), 'non-matching step skipped');
  assert.equal(u.status, 'current');
});
test('refuses to touch a checkout with local edits in the way, and keeps them', async () => {
  await api('POST', '/api/updates/dirty/run'); const u = await settle('dirty');
  assert.equal(u.job.state, 'failed'); assert.match(fs.readFileSync(`${R.dirty.w}/file.txt`, 'utf8'), /my local edit/);
});
test('refuses when there are unpushed local commits', async () => {
  await api('POST', '/api/updates/ahead/run'); assert.equal((await settle('ahead')).job.state, 'failed');
});
test('failed health check rolls back to the old version', async () => {
  const before = sh('git rev-parse HEAD', R.bad.w); await api('POST', '/api/updates/bad/run'); const u = await settle('bad');
  assert.equal(u.job.state, 'failed'); assert.equal(sh('git rev-parse HEAD', R.bad.w), before); assert.ok(u.job.log.some(l => /Rolling back/.test(l)));
});
test('failed build step rolls back and shows the error', async () => {
  const before = sh('git rev-parse HEAD', R.step.w); await api('POST', '/api/updates/step/run'); const u = await settle('step');
  assert.equal(u.job.state, 'failed'); assert.equal(sh('git rev-parse HEAD', R.step.w), before); assert.ok(u.job.log.some(l => /kaboom/.test(l)));
});
test('unknown app id is a 404', async () => { assert.equal((await api('POST', '/api/updates/nope/run')).s, 404); });
test('recipes are not editable through the API', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8'); assert.ok(!/updates\.json/.test(src.replace(/\/\/.*$/gm, '')), 'server never writes updates.json');
});
test('Updates panel: button, badge dot, list, update button', async () => {
  push(R.ok, 'ui-visible'); await get('ok');
  const page = await ctx.newPage(); await page.goto(B + '/'); await page.waitForSelector('#updbtn:not([hidden])');
  await page.waitForFunction(() => !document.querySelector('#upddot').hidden, null, { timeout: 15000 });
  await page.click('#updbtn'); await page.waitForSelector('#upddlg[open] .urow');
  assert.match(await page.locator('#updsub').innerText(), /update.* available/);
  const row = page.locator('.urow', { hasText: /^ok/ }); assert.match(await row.innerText(), /1 new/); assert.match(await row.innerText(), /ui-visible/);
  await row.locator('[data-upd]').click(); await page.waitForFunction(() => /Up to date/.test(document.querySelector('#updlist').innerText) && !document.querySelector('[data-upd="ok"]'), null, { timeout: 15000 });
  assert.equal(sh('git rev-parse HEAD', R.ok.w), sh('git rev-parse origin/main', R.ok.w));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal scroll');
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT }); await page.close();
});
