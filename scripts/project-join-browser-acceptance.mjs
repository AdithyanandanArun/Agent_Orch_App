import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { chromium } = require('playwright');
const files = new Map([['index.html', 'text/html'], ['join.mjs', 'text/javascript'], ['join.css', 'text/css'], ['mingle.svg', 'image/svg+xml']]);
const requested = [];
const server = createServer(async (req, res) => {
  requested.push(req.url);
  const name = new URL(req.url, 'http://127.0.0.1').pathname.replace(/^\/join\//, '') || 'index.html';
  if (!files.has(name)) { res.writeHead(404).end(); return; }
  try { res.writeHead(200, { 'content-type': files.get(name) }).end(await readFile(new URL(`../website/join/${name}`, import.meta.url))); }
  catch { res.writeHead(500).end(); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}/join/`;
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(base)) external.push(request.url()); });
  const token = 'A'.repeat(43); // Explicit fixture, never a real invitation.
  await page.goto(`${base}#token=${token}`);
  const open = page.getByRole('link', { name: 'Open Mingle', exact: true });
  await open.waitFor();
  assert.equal(new URL(page.url()).hash, '');
  assert.equal(await open.getAttribute('href'), `mingle://join?token=${token}`);
  await page.getByRole('button', { name: 'Copy app link' }).click();
  await page.getByRole('status').filter({ hasText: 'App link copied' }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `mingle://join?token=${token}`);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const output = join(tmpdir(), `mingle-project-join-page-${process.pid}`);
  await mkdir(output, { recursive: true });
  await page.screenshot({ path: join(output, 'join-mobile.png'), fullPage: true });
  // Same-document navigation must not retain the previous valid invitation.
  await page.goto(`${base}#token=invalid`);
  await page.getByRole('status').filter({ hasText: 'No valid invitation' }).waitFor();
  assert.equal(await open.isVisible(), false);
  assert.equal(new URL(page.url()).hash, '');
  await page.goto(`${base}#token=${token}`);
  await open.waitFor();
  assert.equal(await open.getAttribute('href'), `mingle://join?token=${token}`);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.ok(requested.every(url => !url.includes(token)), 'The server must never receive the invitation fragment.');
  console.log(`Join-page browser acceptance passed; example screenshot: ${output}/join-mobile.png`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
