// IR end-to-end driver: document → plan() (facts from probe()) → execute() →
// ffprobe/volumedetect oracles. Usage: node packages/carrot/engine/harness/docs-check.mjs [case ...]
// Requires the harness host on :4176 (pnpm dev:harness); headed Chrome (FINDINGS E2).
import { chromium } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXDIR = join(HERE, 'fixtures');
const OUTDIR = mkdtempSync(join(tmpdir(), 'engine-docs-'));
const PAGE = 'http://127.0.0.1:4176/harness/index.html';
const only = process.argv.slice(2);

// fixtures (same as run.mjs)
mkdirSync(FIXDIR, { recursive: true });
const gen = (file, args) => {
  if (existsSync(join(FIXDIR, file))) return;
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args, join(FIXDIR, file)]);
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
if (!existsSync(join(FIXDIR, 'subs.vtt'))) {
  writeFileSync(join(FIXDIR, 'subs.vtt'), [
    'WEBVTT', '',
    '00:00:01.000 --> 00:00:03.000', 'Hello subtitles', '',
    '00:00:05.000 --> 00:00:07.000', 'Second cue', '',
  ].join('\n'));
}

// ---- tier-1 fixtures + vendor binaries ------------------------------------
gen('speech.mp4', ['-f', 'lavfi', '-i', 'testsrc2=duration=3:size=320x180:rate=30',
  '-f', 'lavfi', '-i', "flite=text='The quick brown fox jumps over the lazy dog':voice=slt",
  '-ar', '48000', '-ac', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '3']);
// the backends package's noisy-speech fixture (speech + shaped noise at 0 dB)
const noisySrc = join(HERE, '..', '..', 'backends', 'test', 'fixtures', 'denoise', 'noisy_snr0.wav');
if (!existsSync(join(FIXDIR, 'noisy.wav')) && existsSync(noisySrc)) {
  copyFileSync(noisySrc, join(FIXDIR, 'noisy.wav'));
}
// a portrait for removebg: web-bg-removal's own demo photo (MIT), fetched once
const portrait = join(FIXDIR, 'portrait.jpg');
if (!existsSync(portrait)) {
  const r = spawnSync('curl', ['-sfL', '-o', portrait,
    'https://raw.githubusercontent.com/katana-video/web-bg-removal/main/demo/portrait.jpg'], { encoding: 'utf8' });
  if (r.status !== 0) console.warn('could not fetch the portrait fixture — t1-removebg will be skipped');
}
const havePortrait = existsSync(portrait);
// weights are fetched by the backends themselves (CORS CDNs, browser-cached);
// nothing to vendor. Model-backed cases whose backend is not registered on
// the page (e.g. upscale — a host-private kernel) are skipped, not failed.

try { await fetch('http://127.0.0.1:4176/'); }
catch { console.error('harness host not reachable on :4176 — run `pnpm dev:harness` first'); process.exit(2); }

// persistent profile: whisper/opus models cache in the browser across runs
const context = await chromium.launchPersistentContext(join(HERE, '.chrome-profile'), {
  channel: 'chrome', headless: false,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const browser = context;
const page = context.pages()[0] ?? await context.newPage();
if (process.env.HARNESS_DEBUG) {
  page.on('console', (m) => console.log('[console]', m.text()));
}
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(PAGE);
await page.waitForFunction(() => typeof window.__runDocument === 'function', { timeout: 30_000 });
let cases = await page.evaluate(() => window.__docCases());
if (only.length) cases = cases.filter((c) => only.includes(c.name));

const probeFile = (f) => execFileSync('ffprobe', ['-v', 'error',
  '-show_entries', 'stream=codec_type,codec_name,width,height,sample_rate',
  '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', f]).toString();
// packet-identity oracle for stream copy: count + total bytes of video packets
const videoPacketStats = (f) => {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=size', '-of', 'csv=p=0', f]).toString().trim();
  const sizes = out ? out.split('\n').map(Number) : [];
  return { count: sizes.length, bytes: sizes.reduce((a, b) => a + b, 0) };
};
const meanVolume = (file, from, to) => {
  const r = spawnSync('ffmpeg', ['-ss', String(from), '-to', String(to), '-i', file,
    '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(r.stderr.match(/mean_volume: ([-\d.]+) dB/)?.[1] ?? -99);
};

// signalstats over t=[2,3], averaged (lighting-filter oracles)
const videoStats = (file) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file,
    '-vf', "select='between(t,2,3)',signalstats,metadata=print:file=-",
    '-f', 'null', '-'], { encoding: 'utf8' });
  const avg = (key) => {
    const vals = [...r.stdout.matchAll(new RegExp(`signalstats\\.${key}=([\\d.]+)`, 'g'))].map((m) => Number(m[1]));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN;
  };
  return { yAvg: avg('YAVG'), satAvg: avg('SATAVG') };
};

let failures = 0;
const fail = (n, w) => { failures++; console.log(`  FAIL ${n} ${w}`); };
const pass = (n, w) => console.log(`  pass ${n} ${w}`);

for (const c of cases) {
  if (c.name === 't1-removebg' && !havePortrait) {
    console.log(`skip ${c.name} (no portrait fixture)`);
    continue;
  }
  if (c.name === 't1-upscale-2x') {
    console.log(`skip ${c.name} (upscale is a host-supplied kernel — covered by apps/web/smoke.mjs)`);
    continue;
  }
  for (const backend of c.expected.backends ?? ['webgpu']) {
  const tag = (c.expected.backends?.length ?? 1) > 1 ? `${c.name}[${backend}]` : c.name;
  console.log(`case ${tag}`);
  const r = await page.evaluate(([n, b]) => window.__runDocument(n, b), [c.name, backend]);
  if (!r.ok) { fail(tag, `execute: ${r.error}`); continue; }
  const ext = c.expected.artifact ?? c.expected.ext ?? c.expected.still ?? (c.expected.hasVideo ? 'mp4' : 'wav');
  const out = join(OUTDIR, `${c.name}-${backend}.${ext}`);
  const b64 = await page.evaluate(async (u) => {
    const buf = await (await fetch(u)).arrayBuffer();
    let s = ''; const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(s);
  }, r.url);
  writeFileSync(out, Buffer.from(b64, 'base64'));

  const e = c.expected;

  // deriver-terminal artifacts [G3]: text/alpha oracles, no av probing
  if (e.artifact) {
    if (e.artifact === 'vtt' || e.artifact === 'srt') {
      const text = readFileSync(out, 'utf8');
      for (const s of e.artifactMatch ?? []) {
        text.includes(s) ? pass(tag, `artifact contains "${s}"`) : fail(tag, `artifact missing "${s}"\n---\n${text.slice(0, 400)}`);
      }
      if (e.artifactRegex) {
        new RegExp(e.artifactRegex, 'i').test(text)
          ? pass(tag, `artifact matches /${e.artifactRegex}/`)
          : fail(tag, `artifact fails /${e.artifactRegex}/\n---\n${text.slice(0, 400)}`);
      }
    }
    if (e.alphaSplit) {
      const r2 = spawnSync('ffmpeg', ['-v', 'error', '-i', out,
        '-vf', 'extractplanes=a,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' });
      const n = (k) => Number(r2.stdout.match(new RegExp(`signalstats\\.${k}=([\\d.]+)`))?.[1] ?? NaN);
      const min = n('YMIN'), max = n('YMAX');
      (min < 50 && max > 200)
        ? pass(tag, `alpha split: min ${min}, max ${max}`)
        : fail(tag, `alpha not split: min ${min}, max ${max}`);
    }
    continue;
  }

  const p = probeFile(out);
  const w = Number(p.match(/width=(\d+)/)?.[1]);
  const h = Number(p.match(/height=(\d+)/)?.[1]);
  const dur = Number(p.match(/duration=([\d.]+)(?![\s\S]*duration=)/)?.[1]);
  const hasV = p.includes('codec_type=video');
  const hasA = p.includes('codec_type=audio');

  (hasV === e.hasVideo && hasA === e.hasAudio)
    ? pass(tag, `streams v=${hasV} a=${hasA}`)
    : fail(tag, `streams v=${hasV}/${e.hasVideo} a=${hasA}/${e.hasAudio}`);
  if (e.w != null) {
    (w === e.w && h === e.h) ? pass(tag, `geometry ${w}x${h}`) : fail(tag, `geometry ${w}x${h} want ${e.w}x${e.h}`);
  }
  if (!e.still) {
    (Math.abs(dur - e.dur) <= 0.35) ? pass(tag, `duration ${dur.toFixed(2)}s`) : fail(tag, `duration ${dur?.toFixed?.(2)}s want ${e.dur}`);
  }
  if (e.videoCodecName || e.audioCodecName) {
    const codecs = [...p.matchAll(/codec_name=(\S+)/g)].map((m) => m[1]);
    if (e.videoCodecName) codecs.includes(e.videoCodecName)
      ? pass(tag, `vcodec ${e.videoCodecName}`) : fail(tag, `vcodec [${codecs}] want ${e.videoCodecName}`);
    if (e.audioCodecName) codecs.includes(e.audioCodecName)
      ? pass(tag, `acodec ${e.audioCodecName}`) : fail(tag, `acodec [${codecs}] want ${e.audioCodecName}`);
  }
  if (e.audioSampleRate) {
    const rate = Number(p.match(/sample_rate=(\d+)/)?.[1]);
    (rate === e.audioSampleRate)
      ? pass(tag, `sample_rate ${rate}`) : fail(tag, `sample_rate ${rate} want ${e.audioSampleRate}`);
  }
  if (e.videoPacketsMatch) {
    const got = videoPacketStats(out);
    const want = videoPacketStats(join(FIXDIR, e.videoPacketsMatch));
    (got.count === want.count && got.bytes === want.bytes)
      ? pass(tag, `packet-identical to ${e.videoPacketsMatch} (${got.count} pkts, ${got.bytes}B)`)
      : fail(tag, `packets ${got.count}/${got.bytes}B want ${want.count}/${want.bytes}B (re-encode leaked in?)`);
  }
  if (e.videoStats) {
    const s = videoStats(out);
    const vs = e.videoStats;
    if (vs.satAvgMax != null) (s.satAvg < vs.satAvgMax)
      ? pass(tag, `satAvg ${s.satAvg.toFixed(1)} < ${vs.satAvgMax}`)
      : fail(tag, `satAvg ${s.satAvg.toFixed(1)} >= ${vs.satAvgMax}`);
    if (vs.yAvgMin != null) (s.yAvg > vs.yAvgMin)
      ? pass(tag, `yAvg ${s.yAvg.toFixed(1)} > ${vs.yAvgMin}`)
      : fail(tag, `yAvg ${s.yAvg.toFixed(1)} <= ${vs.yAvgMin}`);
    if (vs.yAvgMax != null) (s.yAvg < vs.yAvgMax)
      ? pass(tag, `yAvg ${s.yAvg.toFixed(1)} < ${vs.yAvgMax}`)
      : fail(tag, `yAvg ${s.yAvg.toFixed(1)} >= ${vs.yAvgMax}`);
  }
  if (e.burnCheck) {
    const bc = e.burnCheck;
    const whitePixels = (t) => {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', out, '-frames:v', '1',
        '-vf', `crop=${bc.crop}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
      const buf = r.stdout; let n = 0;
      for (let i = 0; i + 2 < buf.length; i += 3) {
        if (buf[i] > 200 && buf[i + 1] > 200 && buf[i + 2] > 200) n++;
      }
      return n;
    };
    const active = whitePixels(bc.activeAt);
    (active >= bc.minActive)
      ? pass(tag, `caption pixels @${bc.activeAt}s: ${active}`)
      : fail(tag, `caption pixels @${bc.activeAt}s: ${active} < ${bc.minActive}`);
    if (bc.inactiveAt != null) {
      const inactive = whitePixels(bc.inactiveAt);
      (inactive <= bc.maxInactive)
        ? pass(tag, `caption gap @${bc.inactiveAt}s: ${inactive}`)
        : fail(tag, `caption gap @${bc.inactiveAt}s: ${inactive} > ${bc.maxInactive} (captions leaking?)`);
    }
  }
  if (e.subtitleText) {
    // system ffmpeg 4.4 predates S_TEXT/WEBVTT read support (it only knows the
    // legacy D_WEBVTT ids), so the oracle checks stream presence via ffprobe
    // plus the cue payload bytes in the muxed track (mkv blocks are plaintext)
    const hasS = p.includes('codec_type=subtitle');
    const bytes = readFileSync(out);
    const hasText = bytes.includes(e.subtitleText) && bytes.includes('S_TEXT/WEBVTT');
    (hasS && hasText) ? pass(tag, `subtitle track (S_TEXT/WEBVTT) carries "${e.subtitleText}"`)
      : fail(tag, `subtitle stream=${hasS}, cue bytes=${hasText}`);
  }
  if (e.ssimRef) {
    const ref = join(OUTDIR, `ref-${c.name}.mp4`);
    if (!existsSync(ref)) {
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', join(FIXDIR, e.ssimRef.fixture),
        '-vf', e.ssimRef.vf, '-an', '-c:v', 'libx264', '-crf', '12', ref]);
    }
    const sr = spawnSync('ffmpeg', ['-i', out, '-i', ref, '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
    const ssim = Number(sr.stderr.match(/All:([\d.]+)/)?.[1] ?? 0);
    (ssim >= e.ssimRef.min)
      ? pass(tag, `ssim-vs-ffmpeg ${ssim.toFixed(3)}`)
      : fail(tag, `ssim-vs-ffmpeg ${ssim.toFixed(3)} < ${e.ssimRef.min}`);
  }
  for (const [from, to, minDb] of e.audioNonSilentAt ?? []) {
    const mean = meanVolume(out, from, to);
    (mean > minDb) ? pass(tag, `audio[${from},${to}] ${mean}dB`) : fail(tag, `audio[${from},${to}] ${mean}dB <= ${minDb}`);
  }
  if (e.quieterThanFixture) {
    const q = e.quieterThanFixture;
    const mine = meanVolume(out, 0, 1e9);
    const base = meanVolume(join(FIXDIR, q.fixture), 0, 1e9);
    (mine <= base - q.deltaDb)
      ? pass(tag, `quieter than ${q.fixture}: ${mine}dB vs ${base}dB`)
      : fail(tag, `not quieter: ${mine}dB vs ${base}dB, need -${q.deltaDb}`);
  }
  }
}

await browser.close();
console.log(`\noutputs in ${OUTDIR}`);
console.log(failures ? `${failures} FAILURES` : 'ALL PASS');
process.exit(failures ? 1 : 0);
