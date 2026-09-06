// Playground smoke: load the page, pick an example, attach the engine
// harness fixture, plan, run, and check a real file came out. Headed Chrome
// (WebGPU renders black headless). Needs `vite preview --port 4177` (or
// PLAYGROUND_URL) and the engine harness fixtures (node ../engine/harness/run.mjs once).
//   DISPLAY=:1 node smoke.mjs
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.PLAYGROUND_URL ?? 'http://127.0.0.1:4177/carrot/';
const FIX = join(HERE, '..', 'engine', 'harness', 'fixtures');
const video = join(FIX, 'fA.mp4');
const logo = join(FIX, 'logo.png');
if (!existsSync(video)) { console.error(`missing ${video} — run the engine harness once`); process.exit(2); }

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`); if (!ok) fails++; };

await page.goto(URL_);
check(await page.locator('h1').textContent() === 'Carrot 🥕 playground', 'page loaded');

// example 4: watermark (video + image) — exercises overlays, both files, mp4 encode
await page.selectOption('#example', '3');
await page.setInputFiles('#file', [video, logo]);
check((await page.locator('#assets tr').count()) === 2, 'two assets listed');
await page.click('#plan');
await page.waitForFunction(() => document.getElementById('planOut').textContent.startsWith('plan OK'), null, { timeout: 30_000 });
check(true, 'plan OK');
const [dl] = await Promise.all([
  page.waitForFunction(() => document.querySelector('#outputs video'), null, { timeout: 120_000 }),
  page.click('#run'),
]);
check(!!dl, 'video output rendered');
const meta = await page.evaluate(() => document.querySelector('#outputs .row .muted').textContent);
check(/video\/mp4/.test(meta), `output is mp4 (${meta.trim()})`);
const step = await page.locator('#stepLabel').textContent();
check(/done in/.test(step), `run finished (${step})`);

// example 3: gif of the last 3 s with a crop + look (video only) — the trickier render path
await page.selectOption('#example', '2');
await page.evaluate(() => document.querySelectorAll('#assets button')[1]?.click());
await page.click('#plan');
await page.waitForFunction(() => document.getElementById('planOut').textContent.startsWith('plan OK'), null, { timeout: 30_000 });
await page.click('#run');
await page.waitForFunction(() => document.querySelector('#outputs img'), null, { timeout: 120_000 });
const meta2 = await page.evaluate(() => document.querySelector('#outputs .row .muted').textContent);
check(/image\/gif/.test(meta2), `gif output (${meta2.trim()})`);

await browser.close();
console.log(fails ? `${fails} FAILURES` : 'ALL PASS');
process.exit(fails ? 1 : 0);
