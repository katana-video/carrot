// Starter documents for the playground menu. Every one of these shapes also
// appears in docs/examples.md, where it is planner-verified.
export const EXAMPLES: { title: string; document: unknown }[] = [
  {
    title: 'Trim the first 10 s → webm (1 video)',
    document: {
      version: '0.1',
      assets: { clip: { kind: 'video', label: 'input.mp4' } },
      operations: [{
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'clip', range: { start: 0, end: 10 } }],
        output: { container: 'webm', name: 'clip-first-10s' },
      }],
    },
  },
  {
    title: 'Convert to mp4, streams copied when possible (1 video)',
    document: {
      version: '0.1',
      assets: { clip: { kind: 'video' } },
      operations: [{
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'clip' }],
        output: { container: 'mp4', video: { codec: 'auto' }, audio: { codec: 'auto' }, name: 'clip' },
      }],
    },
  },
  {
    title: 'Square crop + vintage look → gif of the last 3 s (1 video)',
    document: {
      version: '0.1',
      assets: { clip: { kind: 'video' } },
      operations: [{
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'clip', range: { start: -3 } }],
        effects: [{ type: 'crop', aspect: '1:1', regionSource: 'user' }, { type: 'look', name: 'vintage' }],
        output: { container: 'gif', name: 'clip-last-3s' },
      }],
    },
  },
  {
    title: 'Watermark bottom-right at 20% width (1 video + 1 image)',
    document: {
      version: '0.1',
      assets: { clip: { kind: 'video' }, logo: { kind: 'image' } },
      operations: [{
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'clip' }],
        overlays: [{ type: 'image', source: 'logo', place: { anchor: 'bottom-right', margin: 16, width: '20%' }, placementSource: 'user', opacity: 0.9 }],
        output: { container: 'mp4', name: 'clip-watermarked' },
      }],
    },
  },
  {
    title: 'Transcribe → burn captions (1 video, downloads whisper)',
    document: {
      version: '0.1',
      assets: { clip: { kind: 'video' } },
      operations: [
        { id: 'caps', op: 'transcribe', source: 'clip', model: 'tiny' },
        {
          id: 'out', op: 'render',
          timeline: [{ type: 'clip', source: 'clip' }],
          overlays: [{ type: 'captions', source: 'caps', style: 'outline' }],
          output: { container: 'mp4', name: 'clip-captioned' },
        },
      ],
    },
  },
  {
    title: 'Transcribe → translate to Spanish → .vtt (1 video)',
    document: {
      version: '0.1',
      assets: { clip: { kind: 'video' } },
      operations: [
        { id: 'caps', op: 'transcribe', source: 'clip', model: 'tiny', language: 'en' },
        { id: 'es', op: 'translate', source: 'caps', to: 'es', from: 'en', format: 'vtt', name: 'clip-es' },
      ],
    },
  },
  {
    title: 'Denoise audio → wav (1 audio or video)',
    document: {
      version: '0.1',
      assets: { clip: { kind: 'audio' } },
      operations: [{
        id: 'out', op: 'render',
        timeline: [{ type: 'clip', source: 'clip' }],
        effects: [{ type: 'denoise', model: 'auto' }],
        output: { container: 'wav', name: 'clip-denoised' },
      }],
    },
  },
  {
    title: 'Remove background → png (1 image, downloads BiRefNet-lite)',
    document: {
      version: '0.1',
      assets: { photo: { kind: 'image' } },
      operations: [{ id: 'cut', op: 'removebg', source: 'photo', name: 'photo-no-background' }],
    },
  },
];
