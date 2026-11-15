// Every app we control must be installable as a PWA (manifest + icons + service worker), and the service worker
// must be harmless (offline page only; never caches pages/API/sign-in).  Run: node --test tests/pwa.test.js
// Checked on http://localhost, which browsers treat as a secure context (plain-HTTP LAN addresses are not; see README).
const test = require('node:test'), assert = require('node:assert/strict');
const { chromium } = require(process.env.PW_CORE || '/home/jellyfin/pwtest/node_modules/playwright-core');
const stack = require('./stack'); const { P } = stack;
let browser;
const png = buf => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ok: buf.subarray(1, 4).toString() === 'PNG' });

// hub/tvm/fleet run on the throwaway stack; the Audio Flow Console and BrightSign page are checked read-only where they live.
const APPS = [
  { name: 'Services Hub', url: `http://localhost:${P.hub}/`, base: '/', stack: true },
  { name: 'TV Manager', url: `http://localhost:${P.tvm}/?nosso`, base: '/', stack: true },
  { name: 'Jellyfin Fleet', url: `http://localhost:${P.fleet}/?nosso`, base: '/', stack: true },
  { name: 'Audio Flow Console', url: 'http://localhost:8088/', base: '/' },
  { name: 'BrightSign Status', url: 'http://localhost/brightsign/status.html', base: '/brightsign/' },
];
test.before(async () => { await stack.start(); await stack.freshHub(); browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); await stack.stop(); });

for (const a of APPS) test.describe(a.name, () => {
  const origin = new URL(a.url).origin;
  let ctx, page, manifest;
  test.before(async () => {
    ctx = await browser.newContext(); page = await ctx.newPage();
    await page.goto(a.url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
  });
  test.after(async () => { await ctx.close(); });

  test('manifest is linked and complete', async () => {
    const href = await page.locator('link[rel=manifest]').getAttribute('href'); assert.ok(href, 'page links a manifest');
    manifest = await (await ctx.request.get(new URL(href, page.url()).href)).json();
    assert.ok(manifest.name && manifest.short_name, 'names');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.scope, a.base);
    assert.ok(new URL(manifest.start_url, origin).pathname.startsWith(a.base), 'start_url is inside the scope');
    assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i); assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
    const sizes = manifest.icons.map(i => i.sizes + ':' + i.purpose).sort();
    assert.deepEqual(sizes, ['192x192:any', '512x512:any', '512x512:maskable']);
  });
  test('icons exist, are real PNGs of the declared size', async () => {
    for (const i of manifest.icons) {
      const r = await ctx.request.get(new URL(i.src, origin).href); assert.equal(r.status(), 200, i.src);
      const d = png(await r.body()); assert.ok(d.ok, i.src + ' is a PNG'); assert.equal(`${d.w}x${d.h}`, i.sizes, i.src);
    }
    const t = await page.locator('link[rel=apple-touch-icon]').getAttribute('href');
    const r = await ctx.request.get(new URL(t, page.url()).href); assert.equal(r.status(), 200); assert.equal(png(await r.body()).w, 180);
  });
  test('service worker registers and takes control', async () => {
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    assert.equal(new URL(scope).pathname, a.base);
    await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(500);
    assert.ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'page is controlled after reload');
  });
  test('Chrome reports no installability problems', async () => {
    const cdp = await ctx.newCDPSession(page); await cdp.send('Page.enable');
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
    assert.deepEqual(installabilityErrors, [], JSON.stringify(installabilityErrors));
  });
  test('offline: shows a friendly page; API/sign-in are never cached', async () => {
    await ctx.setOffline(true);
    await page.goto(a.url, { waitUntil: 'domcontentloaded' });
    assert.match(await page.locator('body').innerText(), /You are offline/);
    const api = await page.evaluate(() => fetch('/api/auth/status').then(() => 'served', () => 'failed'));
    assert.equal(api, 'failed', 'API requests are not answered from a cache');
    await ctx.setOffline(false);
    await page.goto(a.url, { waitUntil: 'domcontentloaded' }); assert.doesNotMatch(await page.locator('body').innerText(), /You are offline/, 'back online: the real app, not the cached offline page');
  });
});
