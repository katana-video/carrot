// Carrot playground: document + files → plan() → runPipeline() in a worker.
// A small, honest host: probe facts, plan on the main thread (pure), run in
// the worker, show every deliverable. No framework.
import { plan, imageFacts, timedTextFacts, type AssetFacts, type FactsTable } from '@katana-video/carrot';
import { EngineWorkerClient, type EngineRunResult } from '@katana-video/carrot/client';
import EngineWorker from './worker?worker';
import { EXAMPLES } from './examples';

type Kind = 'video' | 'audio' | 'image' | 'timed-text';
const engine = new EngineWorkerClient(new EngineWorker());
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const docEl = $<HTMLTextAreaElement>('doc');
const exampleEl = $<HTMLSelectElement>('example');
const dropEl = $('drop');
const fileEl = $<HTMLInputElement>('file');
const assetsEl = $('assets').querySelector('tbody')!;
const planBtn = $<HTMLButtonElement>('plan');
const runBtn = $<HTMLButtonElement>('run');
const cancelBtn = $<HTMLButtonElement>('cancel');
const planOut = $('planOut');
const progressWrap = $('progressWrap');
const progressEl = $<HTMLProgressElement>('progress');
const stepLabel = $('stepLabel');
const outputsEl = $('outputs');
const backendEl = $('backend');

let files: File[] = [];
let planned: ReturnType<typeof plan> | null = null;
let abort: AbortController | null = null;

// examples menu
for (const [i, ex] of EXAMPLES.entries()) {
  const o = document.createElement('option');
  o.value = String(i); o.textContent = ex.title;
  exampleEl.append(o);
}
const showExample = (i: number) => { docEl.value = JSON.stringify(EXAMPLES[i]!.document, null, 2); invalidate(); };
exampleEl.onchange = () => showExample(Number(exampleEl.value));
showExample(0);
backendEl.textContent = 'gpu' in navigator ? 'WebGPU available' : 'WebGL2 (no WebGPU in this browser)';

// files
dropEl.onclick = () => fileEl.click();
fileEl.onchange = () => { addFiles(Array.from(fileEl.files ?? [])); fileEl.value = ''; };
dropEl.ondragover = (e) => { e.preventDefault(); dropEl.classList.add('over'); };
dropEl.ondragleave = () => dropEl.classList.remove('over');
dropEl.ondrop = (e) => { e.preventDefault(); dropEl.classList.remove('over'); addFiles(Array.from(e.dataTransfer?.files ?? [])); };
docEl.oninput = () => { invalidate(); renderAssets(); };

function addFiles(added: File[]): void { files = files.concat(added); invalidate(); renderAssets(); }
function kindOf(f: File): Kind {
  if (f.type.startsWith('video/')) return 'video';
  if (f.type.startsWith('audio/')) return 'audio';
  if (f.type.startsWith('image/')) return 'image';
  if (/\.(vtt|srt)$/i.test(f.name) || f.type.startsWith('text/')) return 'timed-text';
  return /\.(mp3|wav|ogg|m4a|flac)$/i.test(f.name) ? 'audio' : 'video';
}
function assetIds(): string[] {
  try { return Object.keys((JSON.parse(docEl.value) as { assets?: Record<string, unknown> }).assets ?? {}); } catch { return []; }
}
function renderAssets(): void {
  const ids = assetIds();
  assetsEl.innerHTML = '';
  const n = Math.max(ids.length, files.length);
  for (let i = 0; i < n; i++) {
    const tr = document.createElement('tr');
    const id = ids[i]; const f = files[i];
    tr.innerHTML = `<td><code>${id ?? '<span class="muted">(no asset)</span>'}</code></td><td>${f ? `${f.name} <span class="muted">${kindOf(f)}, ${(f.size / 1e6).toFixed(1)} MB</span>` : '<span class="muted">(no file yet)</span>'}</td><td></td>`;
    if (f) { const b = document.createElement('button'); b.textContent = '×'; b.onclick = () => { files.splice(i, 1); invalidate(); renderAssets(); }; tr.lastElementChild!.append(b); }
    assetsEl.append(tr);
  }
}
function invalidate(): void { planned = null; runBtn.disabled = true; }

async function factsFor(f: File): Promise<AssetFacts> {
  const kind = kindOf(f);
  if (kind === 'image') { const bmp = await createImageBitmap(f); const r = imageFacts(bmp.width, bmp.height); bmp.close(); return r; }
  if (kind === 'timed-text') return timedTextFacts();
  return engine.probeFacts(f);
}

planBtn.onclick = async () => {
  invalidate();
  outputsEl.innerHTML = '';
  let doc: unknown;
  try { doc = JSON.parse(docEl.value); } catch (e) { planOut.className = 'err'; planOut.textContent = `not JSON: ${(e as Error).message}`; return; }
  const ids = assetIds();
  if (files.length < ids.length) { planOut.className = 'err'; planOut.textContent = `the document declares ${ids.length} asset(s); ${files.length} file(s) attached`; return; }
  planOut.className = 'muted'; planOut.textContent = 'probing…';
  const facts: FactsTable = {};
  try { for (const [i, id] of ids.entries()) facts[id] = await factsFor(files[i]!); }
  catch (e) { planOut.className = 'err'; planOut.textContent = `probe failed: ${(e as Error).message}`; return; }
  const r = plan(doc, facts);
  if (!r.pipeline || r.errors.length) {
    planOut.className = 'err';
    planOut.textContent = r.errors.map((e) => `${e.code} @ ${e.path || '(root)'}: ${e.message}`).join('\n') || 'plan produced no pipeline';
    return;
  }
  planned = r;
  planOut.className = 'ok';
  const factLines = Object.entries(facts).map(([id, f]) => `  ${id}: ${f.kind}${f.video ? ` ${f.video.width}×${f.video.height} ${f.video.codec ?? ''}` : ''}${f.image ? ` ${f.image.width}×${f.image.height}` : ''}${f.audio ? ` audio ${f.audio.sampleRate}Hz×${f.audio.channels} ${f.audio.codec ?? ''}` : ''}${Number.isFinite(f.duration) && f.duration > 0 ? ` ${f.duration.toFixed(2)}s` : ''}`);
  planOut.textContent = `plan OK — ${r.pipeline.steps.length} step(s): ${r.pipeline.steps.map((s) => `${s.id} (${s.kind})`).join(' → ')}\nfacts:\n${factLines.join('\n')}`;
  runBtn.disabled = false;
};

runBtn.onclick = async () => {
  if (!planned?.pipeline) return;
  const ids = assetIds();
  const assets: Record<string, { kind: Kind; blob: Blob; label?: string }> = {};
  for (const [i, id] of ids.entries()) assets[id] = { kind: kindOf(files[i]!), blob: files[i]!, label: files[i]!.name };
  abort = new AbortController();
  runBtn.disabled = true; planBtn.disabled = true; cancelBtn.disabled = false;
  progressWrap.hidden = false; progressEl.value = 0; stepLabel.textContent = 'starting…'; outputsEl.innerHTML = '';
  const t0 = performance.now();
  try {
    const res = await engine.runPipeline(planned.pipeline, assets, {
      signal: abort.signal,
      onStep: (s) => { stepLabel.textContent = `step ${s.stepIndex + 1}/${s.stepCount}: ${s.stepId} (${s.kind})`; progressEl.value = 0; },
      onProgress: (p) => { progressEl.value = p.totalDuration ? p.mediaTime / p.totalDuration : 0; },
      onDeriverProgress: (f) => { progressEl.value = f; },
      onModelProgress: (m) => { stepLabel.textContent = `downloading model… ${(m.loaded / 1e6).toFixed(0)} / ${(m.total / 1e6).toFixed(0)} MB`; progressEl.value = m.total ? m.loaded / m.total : 0; },
    });
    progressEl.value = 1;
    stepLabel.textContent = `done in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    showOutputs(res);
  } catch (e) {
    stepLabel.textContent = '';
    outputsEl.innerHTML = `<pre class="err">${escapeHtml((e as Error).name === 'AbortError' ? 'cancelled' : `${(e as Error).name}: ${(e as Error).message}`)}</pre>`;
  } finally {
    abort = null; planBtn.disabled = false; cancelBtn.disabled = true; runBtn.disabled = !planned;
  }
};
cancelBtn.onclick = () => abort?.abort();

function showOutputs(res: EngineRunResult): void {
  const outs = res.outputs?.length ? res.outputs : res.blob ? [{ id: 'out', blob: res.blob }] : [];
  for (const o of outs) {
    const url = URL.createObjectURL(o.blob);
    const ext = extFor(o.blob.type);
    const box = document.createElement('div'); box.className = 'out';
    box.innerHTML = `<div class="row"><strong>${escapeHtml(o.id)}</strong> <span class="muted">${escapeHtml(o.blob.type || 'application/octet-stream')}, ${(o.blob.size / 1e6).toFixed(2)} MB${res.videoCodec ? `, ${res.videoCodec}` : ''}${res.audioCodec ? `/${res.audioCodec}` : ''}</span> <a href="${url}" download="${escapeHtml(o.id)}.${ext}">download</a></div>`;
    const t = o.blob.type;
    if (t.startsWith('video/')) { const v = document.createElement('video'); v.controls = true; v.src = url; box.append(v); }
    else if (t.startsWith('audio/')) { const a = document.createElement('audio'); a.controls = true; a.src = url; box.append(a); }
    else if (t.startsWith('image/')) { const im = document.createElement('img'); im.src = url; box.append(im); }
    else if (t.startsWith('text/') || t === 'application/x-subrip') { o.blob.text().then((s) => { const pre = document.createElement('pre'); pre.textContent = s; box.append(pre); }); }
    outputsEl.append(box);
  }
}
function extFor(mime: string): string {
  const m: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/x-matroska': 'mkv', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'text/vtt': 'vtt', 'application/x-subrip': 'srt' };
  return m[mime] ?? 'bin';
}
function escapeHtml(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
