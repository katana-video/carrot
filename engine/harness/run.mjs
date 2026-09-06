// media-engine harness driver.
//
// Generates deterministic fixtures (ffmpeg), drives the harness page in headed
// Chrome (WebGPU canvases don't present headless — FINDINGS E2), executes every
// case on both GPU backends, and verifies outputs in Node with the oracle
// stack: ffprobe postconditions, ffmpeg SSIM differentials, volumedetect
// levels, and cross-backend SSIM agreement.
//
// Usage:  node packages/carrot/engine/harness/run.mjs [caseName ...]
// Requires: the harness host on :4176 (pnpm dev:harness), ffmpeg/ffprobe, google-chrome.

import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXDIR = join(HERE, 'fixtures');
const OUTDIR = mkdtempSync(join(tmpdir(), 'engine-harness-'));
const PAGE = 'http://127.0.0.1:4176/harness/index.html';
const only = process.argv.slice(2);

// ---------------------------------------------------------------------------
// fixtures (deterministic; cases.ts hardcodes their geometry/durations)
// ---------------------------------------------------------------------------
mkdirSync(FIXDIR, { recursive: true });
const gen = (file, args) => {
  if (existsSync(join(FIXDIR, file))) return;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, join(FIXDIR, file)]);
  console.log(`fixture: ${file}`);
};
gen('fA.mp4', ['-f', 'lavfi', '-i', 'testsrc2=duration=8:size=320x180:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=48000',
  '-ac', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
gen('fB.mp4', ['-f', 'lavfi', '-i', 'testsrc2=duration=5:size=480x270:rate=25',
  '-f', 'lavfi', '-i', 'sine=frequency=880:duration=5:sample_rate=44100',
  '-ac', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
gen('music.wav', ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=10:sample_rate=44100',
  '-ac', '2', '-c:a', 'pcm_s16le']);
gen('logo.png', ['-f', 'lavfi', '-i', 'color=c=red@0.6:s=96x48:d=1,format=rgba', '-frames:v', '1']);

// ---------------------------------------------------------------------------
// oracles
// ---------------------------------------------------------------------------
const probe = (file) => execFileSync('ffprobe', ['-v', 'error',
  '-show_entries', 'stream=codec_type,codec_name,width,height',
  '-show_entries', 'format=format_name,duration',
  '-of', 'default=noprint_wrappers=1', file]).toString();

const meanVolume = (file, from, to) => {
  const args = ['-i', file];
  if (from != null) args.unshift('-ss', String(from), '-to', String(to));
  const r = spawnSync('ffmpeg', [...args, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(r.stderr.match(/mean_volume: ([-\d.]+) dB/)?.[1] ?? -99);
};

const ssim = (a, b) => {
  const r = spawnSync('ffmpeg', ['-i', a, '-i', b, '-lavfi', 'ssim', '-an', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(r.stderr.match(/All:([\d.]+)/)?.[1] ?? 0);
};

const refCache = new Map();
function ffmpegRef(name, refSpec) {
  if (refCache.has(name)) return refCache.get(name);
  const out = join(OUTDIR, `ref-${name}.mp4`);
  const inputs = refSpec.inputs.flatMap((f) => ['-i', join(FIXDIR, f)]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, ...refSpec.args,
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  refCache.set(name, out);
  return out;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
try { await fetch('http://127.0.0.1:4176/'); }
catch { console.error('harness host not reachable on :4176 — run `pnpm dev:harness` first'); process.exit(2); }

const browser = await chromium.launch({
  channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(PAGE);
await page.waitForFunction(() => typeof window.__runCase === 'function', { timeout: 30_000 });
let cases = await page.evaluate(() => window.__cases());
if (only.length) cases = cases.filter((c) => only.includes(c.name));

const saveBlob = async (url, file) => {
  const b64 = await page.evaluate(async (u) => {
    const buf = await (await fetch(u)).arrayBuffer();
    let s = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(s);
  }, url);
  writeFileSync(file, Buffer.from(b64, 'base64'));
};

let failures = 0;
const caseVolumes = new Map(); // name → full-range mean dB (first backend)
const pending = []; // louderThanCase checks resolved at the end
const fail = (name, backend, what) => { failures++; console.log(`  FAIL ${name} [${backend}] ${what}`); };
const pass = (name, backend, what) => console.log(`  pass ${name} [${backend}] ${what}`);

for (const c of cases) {
  const ext = c.container;
  const backends = c.hasVideo ? ['webgpu', 'webgl2'] : ['auto'];
  const outs = {};
  console.log(`case ${c.name}`);

  for (const backend of backends) {
    const r = await page.evaluate(
      ([n, b]) => window.__runCase(n, b), [c.name, backend]);
    if (!r.ok) { fail(c.name, backend, `execute: ${r.error}`); continue; }
    const out = join(OUTDIR, `${c.name}-${backend}.${ext}`);
    await saveBlob(r.url, out);
    outs[backend] = out;

    const e = c.expected;
    const p = probe(out);
    const w = Number(p.match(/width=(\d+)/)?.[1]);
    const h = Number(p.match(/height=(\d+)/)?.[1]);
    const dur = Number(p.match(/duration=([\d.N/A]+)(?![\s\S]*duration=)/)?.[1]);
    const hasV = p.includes('codec_type=video');
    const hasA = p.includes('codec_type=audio');
    const fmt = p.match(/format_name=([^\n]+)/)?.[1] ?? '';
    const bytes = r.bytes ?? 0;
    const tol = e.durTol ?? 0.35;

    const checks = [
      ['streams', hasV === e.hasVideo && hasA === e.hasAudio, `v=${hasV}/${e.hasVideo} a=${hasA}/${e.hasAudio}`],
      ...(e.w != null ? [['geometry', w === e.w && h === e.h, `${w}x${h} want ${e.w}x${e.h}`]] : []),
      ['duration', Math.abs(dur - e.dur) <= tol, `${dur?.toFixed?.(2)}s want ${e.dur}±${tol}`],
      ...(e.format ? [['container', fmt.includes(e.format), `${fmt} want ~${e.format}`]] : []),
      ...(e.maxBytes ? [['size', bytes <= e.maxBytes, `${bytes}B max ${e.maxBytes}`]] : []),
    ];
    for (const [what, ok, detail] of checks) {
      ok ? pass(c.name, backend, `${what}: ${detail}`) : fail(c.name, backend, `${what}: ${detail}`);
    }

    if (e.ssimRef) {
      const ref = ffmpegRef(c.name, e.ssimRef);
      const s = ssim(out, ref);
      const ok = s >= (e.ssimMin ?? 0.85);
      ok ? pass(c.name, backend, `ssim-vs-ffmpeg: ${s}`) : fail(c.name, backend, `ssim-vs-ffmpeg: ${s} < ${e.ssimMin ?? 0.85}`);
    }

    if (backend === backends[0]) {
      if (e.audioNonSilentAt) {
        for (const [from, to, minDb] of e.audioNonSilentAt) {
          const mean = meanVolume(out, from, to);
          const ok = mean > minDb;
          ok ? pass(c.name, backend, `audio[${from},${to}]: ${mean}dB`) : fail(c.name, backend, `audio[${from},${to}]: ${mean}dB <= ${minDb}`);
        }
      }
      if (e.hasAudio) caseVolumes.set(c.name, meanVolume(out));
      if (e.louderThanCase) {
        pending.push({ caseName: c.name, baseline: e.louderThanCase.name, deltaDb: e.louderThanCase.deltaDb });
      }
    }
  }

  if (outs.webgpu && outs.webgl2) {
    const s = ssim(outs.webgpu, outs.webgl2);
    const ok = s >= 0.95;
    ok ? pass(c.name, 'x-backend', `ssim webgpu↔webgl2: ${s}`) : fail(c.name, 'x-backend', `ssim webgpu↔webgl2: ${s} < 0.95`);
  }
}

// louderThanCase: resolved after all cases so baselines exist
for (const p of pending) {
  const mine = caseVolumes.get(p.caseName);
  const base = caseVolumes.get(p.baseline);
  if (mine == null || base == null) {
    fail(p.caseName, 'audio', `louder-than: missing volume (mine=${mine}, ${p.baseline}=${base})`);
    continue;
  }
  const ok = mine >= base + p.deltaDb;
  ok ? pass(p.caseName, 'audio', `louder-than ${p.baseline}: ${mine}dB vs ${base}dB (+${(mine - base).toFixed(1)})`)
     : fail(p.caseName, 'audio', `louder-than ${p.baseline}: ${mine}dB vs ${base}dB, need +${p.deltaDb}`);
}

await browser.close();
console.log(`\noutputs in ${OUTDIR}`);
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
process.exit(failures ? 1 : 0);
