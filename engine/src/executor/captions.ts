/**
 * CaptionRasterizer [O5] — burn-in captions, ported from Katana's
 * CaptionRenderer (katana-frontend caption_renderer.ts, Sam's implementation).
 * The wrapping, layout, and style-drawing logic follows that renderer; the
 * engine-side adaptations are deliberate and documented:
 *
 * - Input is a parsed VTT (vtt.ts): each CUE is a display unit (Katana builds
 *   sentences from a raw transcript because it has no display units; VTT
 *   authors them). Cues wrap into lines against the placement box.
 * - Current-word (karaoke) treatment is gated on the VTT carrying inline
 *   word timestamps — with cue-level timing only, every word would count as
 *   "current" and the block style would highlight the whole line.
 * - Burned cues VANISH between windows: no Katana editor behavior of showing
 *   the nearest sentence outside its time range.
 * - Placement is a resolved box on the canvas (bottom-anchored block), not
 *   Katana's per-aspect-ratio placement tables.
 * - Output is a VideoFrame per composed frame (a dynamic composite slot), not
 *   a GPUTexture copy — both engine renderers consume VideoFrames natively.
 */

import type { Geometry, CaptionSlotSpec, Sec } from '../schema';
import { parseVtt, type Cue, type CueWord } from './vtt';
import { FONT_URLS, BUILT_IN_FONTS } from './captionFonts';

interface LaidWord extends CueWord { x: number; y: number; width: number }
interface LaidLine { words: LaidWord[]; width: number }

/** Katana's hexToLuminance (libs/utils.ts) — WCAG relative luminance. */
function hexToLuminance(hex: string): number {
  hex = hex.replace('#', '');
  const ch = (i: number) => parseInt(hex.substring(i, i + 2), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(ch(0)) + 0.7152 * lin(ch(2)) + 0.0722 * lin(ch(4));
}

export class CaptionRasterizer {
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly cues: Cue[];
  private readonly wordGap: number;
  private readonly lineHeight: number;
  private readonly lineGap: number;
  private fontReady: Promise<void> | null = null;
  private lastKey = '';
  private lastEmpty = true;

  constructor(
    private readonly geom: Geometry,
    private readonly spec: CaptionSlotSpec,
    vttText: string,
  ) {
    this.cues = parseVtt(vttText);
    this.canvas = new OffscreenCanvas(geom.w, geom.h);
    const ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) throw new Error('no 2d context for caption rasterizing');
    this.ctx = ctx;

    // Katana's sizing relationships (word_gap/line_height/line_gap from size)
    this.wordGap = spec.sizePx * 0.35;
    this.lineHeight = spec.sizePx;
    this.lineGap = (this.lineHeight * 2) / 3;

    if (!BUILT_IN_FONTS.includes(spec.font)) {
      const source = FONT_URLS[spec.font] ?? FONT_URLS['Open Sans']!;
      const face = new FontFace(spec.font, source);
      // the FontFaceSet lives on self.fonts in WORKERS but on document.fonts
      // in pages (window has no .fonts) — the rasterizer runs in both (burn
      // in the worker, style previews on the page)
      const fontSet = (self as unknown as { fonts?: FontFaceSet }).fonts
        ?? (typeof document !== 'undefined' ? document.fonts : undefined);
      if (fontSet) {
        fontSet.add(face);
        this.fontReady = face.load().then(() => undefined);
      }
    }
    this.ctx.font = `700 ${spec.sizePx}px '${spec.font}', sans-serif`;
  }

  async ready(): Promise<void> {
    if (this.fontReady) {
      // a rejected load (registry entries without URLs, network failures)
      // must not fail the render — the canvas falls back to sans-serif
      await this.fontReady.catch(() => undefined);
      this.ctx.font = `700 ${this.spec.sizePx}px '${this.spec.font}', sans-serif`;
      this.fontReady = null;
    }
  }

  /** Rasterize the captions at `time` (output clock). Null = nothing to show. */
  frameAt(time: Sec): VideoFrame | null {
    const cue = this.cues.find((c) => c.start <= time && time <= c.end);
    if (!cue) { this.lastEmpty = true; return null; }

    const currentWord = cue.wordTiming
      ? cue.words.find((w) => w.start <= time && time <= w.end) ?? null
      : null;
    // redraw only when the visible state changes (Katana's word-change gate)
    const key = `${cue.start}:${currentWord ? currentWord.start : -1}`;
    if (key !== this.lastKey || this.lastEmpty) {
      this.draw(cue, currentWord, time);
      this.lastKey = key;
      this.lastEmpty = false;
    }
    return new VideoFrame(this.canvas, { timestamp: Math.round(time * 1e6), duration: 1 });
  }

  /** Wrap a cue's words into lines against the box width (createSentences' core). */
  private layout(cue: Cue): LaidLine[] {
    const ctx = this.ctx;
    const maxWidth = this.spec.box.w;
    const lines: LaidLine[] = [];
    let line: LaidLine = { words: [], width: 0 };
    for (const word of cue.words) {
      const width = ctx.measureText(word.text).width;
      const extended = line.words.length ? line.width + this.wordGap + width : width;
      if (line.words.length && extended > maxWidth) {
        lines.push(line);
        line = { words: [{ ...word, x: 0, y: 0, width }], width };
      } else {
        line.words.push({ ...word, x: 0, y: 0, width });
        line.width = extended;
      }
    }
    if (line.words.length) lines.push(line);

    // bottom-anchored block inside the box, lines centered horizontally
    const total = lines.length * this.lineHeight + (lines.length - 1) * this.lineGap;
    const box = this.spec.box;
    let baseline = box.y + box.h - total + this.lineHeight;   // first line's baseline
    for (const l of lines) {
      let x = box.x + (box.w - l.width) / 2;
      for (const w of l.words) {
        w.x = x; w.y = baseline;
        x += w.width + this.wordGap;
      }
      baseline += this.lineHeight + this.lineGap;
    }
    return lines;
  }

  /** Style drawing ported from Katana's drawSentence (shadow/outline/block). */
  private draw(cue: Cue, currentWord: CueWord | null, _time: Sec): void {
    const ctx = this.ctx;
    const { style, color, sizePx } = this.spec;
    ctx.clearRect(0, 0, this.geom.w, this.geom.h);
    ctx.font = `700 ${sizePx}px '${this.spec.font}', sans-serif`;
    ctx.textBaseline = 'alphabetic';

    const lines = this.layout(cue);

    // backing bar (Katana's CaptionParams.shadow): one semi-transparent
    // rounded rect per line, painted before any text
    if (this.spec.bar) {
      ctx.save();
      ctx.shadowColor = 'transparent';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      const pad = sizePx * 0.25;
      for (const line of lines) {
        const first = line.words[0];
        if (!first) continue;
        ctx.beginPath();
        ctx.roundRect(
          first.x - pad, first.y - this.lineHeight,
          line.width + pad * 2, this.lineHeight + this.lineGap / 2,
          sizePx / 5,
        );
        ctx.fill();
      }
      ctx.restore();
    }

    for (const line of lines) {
      for (const w of line.words) {
        const isCurrent = currentWord != null
          && w.start === currentWord.start && w.text === currentWord.text;

        ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
        ctx.shadowBlur = Math.sqrt(sizePx / 5);
        ctx.shadowOffsetX = Math.sqrt(sizePx / 10);
        ctx.shadowOffsetY = Math.sqrt(sizePx / 10);

        if (style === 'block') {
          if (isCurrent) {
            // highlight background behind the current word (Katana block style)
            const offset = Math.min(w.width * 0.1, 3);
            const lum = hexToLuminance(color);
            ctx.fillStyle = lum < 0.1 ? 'rgba(255, 255, 255, 1)' : color;
            ctx.beginPath();
            ctx.roundRect(
              w.x - this.wordGap / 2 - offset, w.y - this.lineHeight,
              w.width + this.wordGap + offset, this.lineHeight + this.lineGap / 2,
              sizePx / 5,
            );
            ctx.fill();
            ctx.shadowOffsetY = 0;
            ctx.fillStyle = lum > 0.9 || lum < 0.1 ? 'rgba(0, 0, 0, 1)' : 'rgba(255, 255, 255, 1)';
          } else {
            ctx.fillStyle = 'white';
            ctx.shadowColor = 'black';
            ctx.shadowBlur = 5;
          }
          ctx.fillText(w.text, w.x, w.y);
        } else if (style === 'outline') {
          // Katana 'bold' style minus the bounce (bounce needs per-frame
          // rerender; a later refinement — stated, not silent)
          ctx.strokeStyle = 'black';
          ctx.lineWidth = Math.max(3, sizePx * 0.06);
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.strokeText(w.text, w.x, w.y);
          const lum = hexToLuminance(color);
          ctx.fillStyle = isCurrent && lum < 0.9 && lum > 0.1 ? color : 'white';
          ctx.fillText(w.text, w.x, w.y);
        } else {
          // default: white with shadow
          ctx.fillStyle = 'white';
          ctx.shadowColor = 'black';
          ctx.shadowBlur = 5;
          ctx.fillText(w.text, w.x, w.y);
        }
      }
    }

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
}
