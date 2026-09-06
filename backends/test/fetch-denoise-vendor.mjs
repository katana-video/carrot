// Fetch the denoise binaries (DeepFilterNet + RNNoise builds, see the
// directory's WEIGHTS_LICENSE) into test/vendor/ for the Node tests
// (idempotent). Run: node test/fetch-denoise-vendor.mjs
import { mkdirSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = 'https://cdn.katana.video/carrot/denoise/v/0.0.5/'
const FILES = {
  'dfn.wasm': 406259,
  'dfn_weights.pack': 13817933,
  'dfn_weights_int8.pack': 7950596,
  'rnnoise.wasm': 134856,
}

const vendor = join(dirname(fileURLToPath(import.meta.url)), 'vendor')
mkdirSync(vendor, { recursive: true })

for (const [name, bytes] of Object.entries(FILES)) {
  const dest = join(vendor, name)
  if (existsSync(dest) && statSync(dest).size === bytes) continue
  const res = await fetch(BASE + name)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length !== bytes) throw new Error(`${name}: got ${buf.length} bytes, expected ${bytes}`)
  writeFileSync(dest, buf)
  console.log(`fetched ${name} (${bytes} bytes)`)
}
console.log('vendor/ ready')
