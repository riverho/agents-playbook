#!/usr/bin/env node
// check-graph-ui-design.mjs — gate for the "paint the Flow-room design" task.
//
// Exists because a task's acceptance_checks are shell commands: asserting five artifact
// paths and the frame count is clearer as one script than as five `node -e` one-liners
// (and avoids cmd.exe quoting hazards — see memory/project-memory.md rule 8).
//
// It tests the DESIGN ARTIFACTS ONLY. It does not test that a human approved them; the
// separate manual approval task does that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'artifacts', 'graph-flow-ui');

const mustExist = [
  'DESIGN.md',
  'frames/frames.html',
  'frames/flow.css',
  'frames/f1-room-overview.png',
  'frames/f2-card-inspector.png',
  'frames/f3-multi-select-steering.png',
  'frames/f4-effects.png',
  'recon-design-language.md',
  'recon-pb-surfaces.md',
  'recon-wenmei-semantics.md',
];

const failures = [];
for (const rel of mustExist) {
  const p = path.join(dir, rel);
  if (!fs.existsSync(p)) failures.push(`missing: artifacts/graph-flow-ui/${rel}`);
  else if (rel.endsWith('.png') && fs.statSync(p).size < 20_000) failures.push(`too small to be a rendered frame: ${rel}`);
}

const html = fs.existsSync(path.join(dir, 'frames', 'frames.html'))
  ? fs.readFileSync(path.join(dir, 'frames', 'frames.html'), 'utf8')
  : '';
const frames = (html.match(/<section class="frame"/g) || []).length;
if (frames !== 4) failures.push(`frames.html declares ${frames} frames, expected 4`);

const design = fs.existsSync(path.join(dir, 'DESIGN.md')) ? fs.readFileSync(path.join(dir, 'DESIGN.md'), 'utf8') : '';
for (const needle of ['PB owns truth', 'design-contract.yaml', '## 5. Decisions I need approved']) {
  if (!design.includes(needle)) failures.push(`DESIGN.md is missing the section/marker: ${needle}`);
}

if (failures.length) {
  console.error('graph-ui design gate FAILED');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log(`graph-ui design gate passed: ${mustExist.length} artifacts, ${frames} frames`);
