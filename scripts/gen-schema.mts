// Emits docs/schema/0.1/document.json — the IR document's JSON Schema,
// generated from the zod source of truth (engine/src/ir/document.ts) so the
// published schema can never drift from what plan() accepts.
//   pnpm gen:schema
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { irJsonSchema, IR_VERSION } from '../engine/src/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const out = join(HERE, '..', 'docs', 'schema', IR_VERSION, 'document.json');
mkdirSync(dirname(out), { recursive: true });
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `https://katana-video.github.io/carrot/schema/${IR_VERSION}/document.json`,
  title: `Carrot IR document v${IR_VERSION}`,
  description: 'A pipeline envelope: assets + operations. Normative text: docs/ir-spec.md; worked, planner-verified examples: docs/examples.md.',
  ...irJsonSchema(),
};
writeFileSync(out, JSON.stringify(schema, null, 2) + '\n');
console.log(`wrote ${out} (${(JSON.stringify(schema).length / 1024).toFixed(0)} KB)`);
