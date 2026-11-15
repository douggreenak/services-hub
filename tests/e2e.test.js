// End-to-end matrix: every combination of host name x service x hub state x saved login x entry path.
// Run:  node --test tests/        (needs docker, python3, and playwright-core; see tests/README.md)
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PW_CORE || '/home/jellyfin/pwtest/node_modules/playwright-core');
const stack = require('./stack'); const { P, HUBPW, CREDS, ID } = stack;
const HOSTS = ['localhost', '127.0.0.1'];            // cookies are per-host: both must work
const SVCS = ['tvm', 'fleet', 'mockc', 'mockp'];     // real TV Manager (cookie), real Fleet (token), mock cookie app, mock checklist-shaped app (own login page, 'passcode' field)
let browser;

const hubO = h => `http://${h}:${P.hub}`;
const svcO = (h, s) => `http://${h}:${P[s]}`;
async function newCtx(h) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(`window.__HUB_ORIGIN__ = ${JSON.stringify(hubO(h))}; window.__HUB_GUARD_MS__ = 1500;`);
  // Flash detector: remember if a login field was ever visible while the loading wheel was not covering the page.
  await ctx.addInitScript(`(function(){function t(){try{var p=document.querySelector('input[type=password]');if(p&&p.getClientRects().length&&!document.getElementById('hub-sso-overlay'))sessionStorage.setItem('flash','1')}catch(e){}requestAnimationFrame(t)}requestAnimationFrame(t)})();`);
  return ctx;
}
const noFlash = async page => assert.equal(await page.evaluate(() => sessionStorage.getItem('flash')), null, 'the service login screen flashed before the redirect');
async function api(ctx, h, method, p, body) {
  const r = await ctx.request.fetch(hubO(h) + p, { method, data: body, headers: { 'Content-Type': 'application/json' } });
  return { status: r.status(), body: await r.json().catch(() => null) };
}
async function hubSignIn(ctx, h) {
  const st = (await api(ctx, h, 'GET', '/api/auth/status')).body;
  const r = await api(ctx, h, 'POST', st.setup ? '/api/auth/setup' : '/api/auth/login', { password: HUBPW });
  assert.equal(r.status, 200);
}
async function saveCreds(ctx, h, key, creds) {
  const id = ID[key] ?? key;
  const list = (await api(ctx, h, 'GET', '/api/services')).body, d = list.find(x => x.id === id);
  const r = await api(ctx, h, 'PUT', '/api/services/' + id, { ...d, login: { mode: d.login.mode, username: creds.username ?? d.login.username, path: d.login.path || '', password: creds.password } });
  assert.equal(r.status, 200);
}
// What is this page showing?
async function classify(page, s) {
  const url = page.url(), here = url.startsWith(`http://${new URL(url).hostname}:${P.hub}`);
  try {
    if (here) {
      if (await page.locator('#authform').count()) return 'hub-login';
      if (await page.locator('form[action$="/login"]').count()) return 'hub-form';
      if (await page.locator('.card').count()) return 'hub-home';
      return 'hub-other';
    }
    if (s === 'tvm') { if (await page.locator('#pw').count()) return 'svc-login'; if (await page.locator('nav[aria-label="Main"]').count()) return 'svc-in'; }
    if (s === 'fleet') { if (await page.getByText('Sign in to manage your Apple TVs').count()) return 'svc-login'; if (await page.locator('[aria-label="Account menu"]').count()) return 'svc-in'; }
    if ((s === 'mockc' || s === 'mockp') && await page.locator('#state').count()) { const t = await page.locator('#state').textContent({ timeout: 1000 }); return t === 'LOGGED-IN' ? 'svc-in' : 'svc-login'; }
    if (s === 'plain') return 'svc-in';
  } catch (e) { classify.err = e.message.split('\n')[0]; }
  return 'loading';
}
async function settle(page, s, want, ms = 15000) {
  const t = Date.now(); let last;
  while (Date.now() - t < ms) { last = await classify(page, s); if (last === want) return; await page.waitForTimeout(250); }
  assert.fail(`expected "${want}" but the page is "${last}" at ${page.url()} ${classify.err || ''}`);
}
const fillHubLogin = async page => { await page.fill('#a-pw', HUBPW); await page.click('#authform button'); };
const fillForm = async (page, creds) => {
  if (creds.username !== undefined && await page.locator('input[name=username]').count()) await page.fill('input[name=username]', creds.username);
  await page.fill('input[name=password]', creds.password); await page.click('form[action$="/login"] button');
};
async function fresh(h) { await stack.freshHub(); const ctx = await newCtx(h); return ctx; }

test.before(async () => { await stack.start(); browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); await stack.stop(); });

for (const h of HOSTS) for (const s of SVCS) test.describe(`${h} · ${s}`, () => {
  const url = () => svcO(h, s) + '/';
  const wrongOk = !(s === 'tvm' && h !== 'localhost'); // real TV Manager locks an IP after 8 bad passwords: keep those few
  const run = (name, fn, opt = {}) => test(name, { timeout: 60000, skip: opt.skip }, async () => {
    const ctx = await fresh(h), page = await ctx.newPage();
    try { await fn(ctx, page); } finally { await ctx.close(); }
  });

  run('direct visit, signed out of everything, login saved -> hub login -> lands signed in', async (ctx, page) => {
    await hubSignIn(ctx, h); await saveCreds(ctx, h, s, CREDS[s]);
    await api(ctx, h, 'POST', '/api/auth/logout');                      // hub signed out, service creds stay saved
    await page.goto(url()); await settle(page, s, 'hub-login');
    await fillHubLogin(page); await settle(page, s, 'svc-in'); await noFlash(page);
    assert.ok(page.url().startsWith(svcO(h, s)), 'returned to the service');
    assert.ok(!page.url().includes('#sso='), 'token stripped from the URL');
  });
  run('direct visit, hub signed in, login saved -> signed in with no hub UI', async (ctx, page) => {
    await hubSignIn(ctx, h); await saveCreds(ctx, h, s, CREDS[s]);
    await page.goto(url()); await settle(page, s, 'svc-in'); await page.waitForTimeout(500); await noFlash(page);
  });
  run('direct visit, hub signed in, nothing saved -> hub asks once -> signed in, then remembered', async (ctx, page) => {
    await hubSignIn(ctx, h);
    await page.goto(url()); await settle(page, s, 'hub-form');
    await fillForm(page, CREDS[s]); await settle(page, s, 'svc-in');
    const ctx2 = await newCtx(h); const p2 = await ctx2.newPage();    // a different browser: hub login only
    await hubSignIn(ctx2, h); await p2.goto(url()); await settle(p2, s, 'svc-in'); await ctx2.close();
  });
  run('nothing saved: wrong password is rejected with a message, then the right one works', async (ctx, page) => {
    await hubSignIn(ctx, h); await page.goto(url()); await settle(page, s, 'hub-form');
    await fillForm(page, { ...CREDS[s], password: 'nope-nope' });
    await settle(page, s, 'hub-form'); assert.match(await page.locator('.e').textContent(), /rejected|answered/i);
    await fillForm(page, CREDS[s]); await settle(page, s, 'svc-in');
  }, { skip: !wrongOk });
  run('saved login is wrong -> form with error; "open without signing in" shows the real login, no loop', async (ctx, page) => {
    await hubSignIn(ctx, h); await saveCreds(ctx, h, s, { ...CREDS[s], password: 'stale-pass1' }).catch(() => {});
    let hubHits = 0; page.on('framenavigated', f => { if (f === page.mainFrame() && f.url().startsWith(hubO(h))) hubHits++; });
    await page.goto(url()); await settle(page, s, 'hub-form');
    assert.match(await page.locator('.e').textContent(), /saved login/i);
    await page.getByText(/without signing in/).click(); await settle(page, s, 'svc-login');
    await page.waitForTimeout(2500); assert.equal(await classify(page, s), 'svc-login', 'stays on the service login');
    assert.ok(hubHits <= 2, 'no redirect loop (' + hubHits + ' hub navigations)');
  }, { skip: !wrongOk });
  run('already signed in to the service -> direct visit does not bounce through the hub', async (ctx, page) => {
    await hubSignIn(ctx, h); await saveCreds(ctx, h, s, CREDS[s]);
    await page.goto(url()); await settle(page, s, 'svc-in');
    let hubHits = 0; page.on('framenavigated', f => { if (f.url().startsWith(hubO(h))) hubHits++; });
    await page.goto(url()); await page.waitForTimeout(2000); await settle(page, s, 'svc-in'); assert.equal(hubHits, 0);
  });
  run('hub NOT signed in but the service already is -> no bounce either', async (ctx, page) => {
    await hubSignIn(ctx, h); await saveCreds(ctx, h, s, CREDS[s]);
    await page.goto(url()); await settle(page, s, 'svc-in');
    await api(ctx, h, 'POST', '/api/auth/logout');
    await page.goto(url()); await page.waitForTimeout(1500); await settle(page, s, 'svc-in');
  });
  run('stale/expired service session -> recovers automatically', async (ctx, page) => {
    await hubSignIn(ctx, h); await saveCreds(ctx, h, s, CREDS[s]);
    await page.goto(url()); await settle(page, s, 'svc-in');
    if (s === 'fleet') await page.evaluate(() => localStorage.setItem('kc.admin.jwt', 'garbage.token.value'));
    else await ctx.addCookies([{ name: s === 'tvm' ? 'tvm_session' : s === 'mockp' ? 'chk' : 'mockc', value: 'garbage', url: svcO(h, s) }]);
    await page.waitForTimeout(1800);                                  // loop guard window (shortened in tests)
    await page.goto(url()); await settle(page, s, 'svc-in', 25000);
  });
  run('sign out in the service -> hub login; revisiting needs the hub password; then signed in again', async (ctx, page) => {
    await hubSignIn(ctx, h); await saveCreds(ctx, h, s, CREDS[s]);
    await page.goto(url()); await settle(page, s, 'svc-in');
    if (s === 'tvm') await page.locator('[aria-label="Sign out"]:visible, button:visible:has-text("Sign out"), a:visible:has-text("Sign out")').first().click();
    else if (s === 'fleet') { await page.locator('[aria-label="Account menu"]').click(); await page.getByText('Sign out').click(); }
    else await page.click('#out');
    await settle(page, s, 'hub-login');
    await page.waitForTimeout(1800); await page.goto(url()); await settle(page, s, 'hub-login');
    await fillHubLogin(page); await settle(page, s, 'svc-in');
  });
  run('hub card "Open" signs in', async (ctx, page) => {
    await hubSignIn(ctx, h); await saveCreds(ctx, h, s, CREDS[s]);
    await page.goto(hubO(h) + '/'); await settle(page, s, 'hub-home');
    await page.locator('.card', { hasText: { tvm: 'TV Manager', fleet: 'Jellyfin Fleet', mockc: 'Mock cookie', mockp: 'Mock checklist' }[s] }).getByText('Open', { exact: true }).click();
    await settle(page, s, 'svc-in'); assert.equal(ctx.pages().length, 1, 'opened in the same tab');
  });
});

test.describe('plain service (no login) and unreachable service', () => {
  for (const h of HOSTS) {
    test(`${h}: a site that is not one of our apps opens in a new tab; direct visit untouched`, { timeout: 40000 }, async () => {
      const ctx = await fresh(h), page = await ctx.newPage();
      await hubSignIn(ctx, h); await page.goto(svcO(h, 'plain') + '/'); await settle(page, 'plain', 'svc-in');
      await page.goto(hubO(h) + '/'); await settle(page, 'plain', 'hub-home');
      // not one of our apps (no View button): opens in a NEW tab and leaves the hub where it is
      const [pop] = await Promise.all([ctx.waitForEvent('page'), page.locator('.card', { hasText: 'Plain' }).getByText('Open', { exact: true }).click()]);
      await pop.waitForLoadState(); assert.equal(await pop.locator('#state').textContent(), 'PLAIN');
      assert.equal(ctx.pages().length, 2, 'opened in a new tab'); assert.ok(page.url().startsWith(hubO(h)), 'hub tab stays on the hub'); await ctx.close();
    });
    test(`${h}: service is down -> clear message with a way out`, { timeout: 40000 }, async () => {
      const ctx = await fresh(h), page = await ctx.newPage(); await hubSignIn(ctx, h);
      await saveCreds(ctx, h, 'down', { password: 'x' }).catch(() => {});
      await page.goto(hubO(h) + '/go/down'); await settle(page, 'down', 'hub-form');
      await fillForm(page, { password: 'x' }); await settle(page, 'down', 'hub-form');
      assert.ok((await page.locator('.e').textContent()).length > 5); await ctx.close();
    });
  }
});

test.describe('TV Manager top bar', () => {
  for (const [label, vp] of [['desktop', { width: 1280, height: 700 }], ['tablet', { width: 900, height: 700 }], ['phone', { width: 390, height: 760 }]])
    test(`Apps button sits in the top bar next to sign out (${label})`, { timeout: 40000 }, async () => {
      await stack.freshHub(); const ctx = await browser.newContext({ viewport: vp }), page = await ctx.newPage();
      await page.goto(svcO('localhost', 'tvm') + '/?nosso'); await page.fill('#pw', CREDS.tvm.password); await page.keyboard.press('Enter');
      await page.waitForSelector('.topbar .apps-pill');
      const bar = await page.locator('.topbar').boundingBox(), apps = await page.locator('.topbar .apps-pill').boundingBox(), out = await page.locator('.topbar [aria-label="Sign out"]').boundingBox();
      assert.ok(apps.y >= bar.y && apps.y + apps.height <= bar.y + bar.height, 'Apps button is inside the top bar');
      assert.ok(apps.x + apps.width <= out.x + 1, 'Apps is to the left of Sign out');
      assert.ok(out.x + out.width <= vp.width, 'nothing cut off at the right edge');
      assert.equal(await page.locator('.nav .nav-extra, .nav .appslink').count(), 0, 'no duplicate Apps / Sign out in the side or bottom bar');
      assert.match(await page.locator('.topbar .apps-pill').getAttribute('href'), /:8090\/apps$/);
      assert.equal(await page.locator('.topbar .apps-pill .lbl').isVisible(), vp.width >= 840, 'label shown on wide screens, icon only on phones');
      await ctx.close();
    });
});

test.describe('hub itself', () => {
  const h = 'localhost';
  const hit = (p, o = {}) => fetch(hubO(h) + p, { redirect: 'manual', ...o });
  test('first run: setup form, weak password refused, strong accepted once', async () => {
    await stack.freshHub(); const ctx = await newCtx(h), page = await ctx.newPage();
    await page.goto(hubO(h) + '/'); await settle(page, 'x', 'hub-login'); assert.ok(await page.locator('#a-pw2').count(), 'confirm field shown on first run');
    assert.equal((await api(ctx, h, 'POST', '/api/auth/setup', { password: 'abc' })).status, 400);
    assert.equal((await api(ctx, h, 'POST', '/api/auth/setup', { password: HUBPW })).status, 200);
    assert.equal((await api(ctx, h, 'POST', '/api/auth/setup', { password: 'another-one' })).status, 409, 'cannot re-run setup');
    await ctx.close();
  });
  test('API needs a session; wrong password rejected; lockout after 5 tries', async () => {
    await stack.freshHub(); const ctx = await newCtx(h); await hubSignIn(ctx, h); await api(ctx, h, 'POST', '/api/auth/logout');
    assert.equal((await hit('/api/services')).status, 401);
    for (let i = 0; i < 5; i++) assert.equal((await hit('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'bad' + i }) })).status, 401);
    assert.equal((await hit('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: HUBPW }) })).status, 429, 'locked even with the right password');
    await ctx.close();
  });
  test('?next= only follows same-site /go paths (no open redirect)', async () => {
    await stack.freshHub(); const ctx = await newCtx(h), page = await ctx.newPage(); await hubSignIn(ctx, h);
    for (const bad of ['https://evil.example/', '//evil.example', '/go/../../x', 'javascript:alert(1)', '/api/services']) {
      await page.goto(hubO(h) + '/?next=' + encodeURIComponent(bad)); await settle(page, 'x', 'hub-home'); assert.ok(page.url().startsWith(hubO(h)), bad);
    }
    await ctx.close();
  });
  test('saved passwords: encrypted on disk, 0600, never returned by the API, and everything survives a restart', async () => {
    await stack.freshHub(); const ctx = await newCtx(h); await hubSignIn(ctx, h); await saveCreds(ctx, h, 'mockc', CREDS.mockc);
    const dir = stack.hubDir(), vault = fs.readFileSync(dir + '/vault.json', 'utf8');
    assert.ok(!vault.includes('cookiepw'), 'no plaintext in vault.json');
    assert.ok(!fs.readFileSync(dir + '/auth.json', 'utf8').includes(HUBPW), 'no plaintext hub password');
    for (const f of ['vault.json', 'auth.json']) assert.equal((fs.statSync(dir + '/' + f).mode & 0o777), 0o600);
    const list = await api(ctx, h, 'GET', '/api/services'); assert.ok(!JSON.stringify(list.body).includes('cookiepw'));
    assert.equal(list.body.find(x => x.id === 'mockc').login.hasPassword, true);
    await stack.restartHub();
    assert.equal((await api(ctx, h, 'GET', '/api/services')).status, 200, 'still signed in after a restart');
    assert.equal((await api(ctx, h, 'GET', '/api/services')).body.find(x => x.id === 'mockc').login.hasPassword, true, 'saved service logins still usable after restart');
    const page = await ctx.newPage(); await page.goto(svcO(h, 'mockc') + '/'); await settle(page, 'mockc', 'svc-in'); await ctx.close();
  });
  test('service names are escaped on the login form page (no script injection)', async () => {
    await stack.freshHub(); const ctx = await newCtx(h), page = await ctx.newPage(); await hubSignIn(ctx, h);
    const list = (await api(ctx, h, 'GET', '/api/services')).body, d = list.find(x => x.id === 'mockc');
    await api(ctx, h, 'PUT', '/api/services/mockc', { ...d, name: '<img src=x onerror="window.pwned=1">' });
    await page.goto(hubO(h) + '/go/mockc'); await settle(page, 'x', 'hub-form'); assert.equal(await page.evaluate(() => window.pwned), undefined); await ctx.close();
  });
  test('login is saved forever: survives restarts, renews on every visit, and only an explicit sign-out ends it', async () => {
    await stack.freshHub(); const ctx = await newCtx(h); await hubSignIn(ctx, h);
    const ck = (await ctx.cookies()).find(c => c.name === 'hub_session');
    assert.ok(ck.expires > Date.now() / 1000 + 390 * 86400, 'cookie lasts the browser maximum (400 days)');
    const old = ck.expires; await new Promise(r => setTimeout(r, 1500)); await api(ctx, h, 'GET', '/api/auth/status');
    assert.ok((await ctx.cookies()).find(c => c.name === 'hub_session').expires > old, 'each visit renews the cookie');
    assert.equal((fs.statSync(stack.hubDir() + '/sessions.json').mode & 0o777), 0o600);
    assert.ok(!fs.readFileSync(stack.hubDir() + '/sessions.json', 'utf8').includes(ck.value), 'session token itself is not stored');
    for (let i = 0; i < 3; i++) { await stack.restartHub(); assert.equal((await api(ctx, h, 'GET', '/api/services')).status, 200, 'restart ' + i); }
    await api(ctx, h, 'POST', '/api/auth/logout'); await stack.restartHub();
    assert.equal((await api(ctx, h, 'GET', '/api/services')).status, 401, 'signed-out stays signed out after a restart');
    assert.ok(!fs.existsSync(stack.hubDir() + '/sessions.json'), 'vault key removed with the last session');
    await hubSignIn(ctx, h); assert.equal((await api(ctx, h, 'GET', '/api/services')).status, 200); await ctx.close();
  });
  test('cards: apps with a View button open in the same tab, other sites in a new tab', async () => {
    await stack.freshHub(); const ctx = await newCtx(h), page = await ctx.newPage(); await hubSignIn(ctx, h);
    await page.goto(hubO(h) + '/'); await settle(page, 'x', 'hub-home');
    for (const c of await page.locator('.card').all()) {
      const ours = (await c.getByText('View', { exact: true }).count()) > 0;
      for (const l of await c.locator('a[href^="/go/"]').all()) assert.equal(await l.getAttribute('target'), ours ? null : '_blank', (await c.locator('h3').innerText()) + (ours ? ' (ours)' : ' (other)'));
    }
    await ctx.close();
  });
  test('QR button opens a code for the hub apps page (sits beside the theme and sign-out buttons)', async () => {
    await stack.freshHub(); const ctx = await newCtx(h), page = await ctx.newPage(); await hubSignIn(ctx, h);
    await page.goto(hubO(h) + '/'); await settle(page, 'x', 'hub-home');
    const xs = await Promise.all(['#qrbtn', '#logout', '#theme'].map(async s => (await page.locator(s).boundingBox()).x));
    assert.ok(xs[0] < xs[1] && xs[1] < xs[2], 'order: QR, sign out, theme');
    await page.click('#qrbtn'); await page.waitForSelector('#qrbox svg path');
    assert.match(await page.locator('#qrurl').textContent(), /^http:\/\/[\d.]+:18090\/apps$/);
    assert.ok((await page.locator('#qrbox svg path').getAttribute('d')).length > 500, 'a real code is drawn');
    await page.click('#qrclose'); assert.equal(await page.locator('#qrdlg[open]').count(), 0); await ctx.close();
  });
  test('hub sign-out button and /logout end the session', async () => {
    await stack.freshHub(); const ctx = await newCtx(h), page = await ctx.newPage(); await hubSignIn(ctx, h);
    await page.goto(hubO(h) + '/'); await settle(page, 'x', 'hub-home'); await page.click('#logout'); await settle(page, 'x', 'hub-login');
    assert.equal((await api(ctx, h, 'GET', '/api/services')).status, 401); await ctx.close();
  });
  test('UI: Edit dialog saves a login and Open then signs in', async () => {
    await stack.freshHub(); const ctx = await newCtx(h), page = await ctx.newPage(); await hubSignIn(ctx, h);
    await page.goto(hubO(h) + '/'); await settle(page, 'x', 'hub-home');
    await page.locator('.card', { hasText: 'Mock cookie' }).getByText('Edit').click();
    await page.selectOption('#f-lmode', 'cookie'); await page.fill('#f-lpass', CREDS.mockc.password); await page.click('#save');
    await page.waitForTimeout(800);
    await page.locator('.card', { hasText: 'Mock cookie' }).getByText('Open', { exact: true }).click();
    await settle(page, 'mockc', 'svc-in'); await ctx.close();
  });
});
