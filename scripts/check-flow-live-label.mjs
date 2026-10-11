#!/usr/bin/env node
// ============================================================================
//  check-flow-live-label.mjs — the room says WHICH source it is showing.
// ----------------------------------------------------------------------------
//  The chipbar printed a hardcoded `snapshot · pb graph --json` for every non-sample adapter, so
//  the adapter that reads the running engine was labelled a snapshot; the adapter's own `label` —
//  the one field that distinguishes a live projection from a bundled capture — was demoted to a
//  tooltip. This gate asserts the property two ways, because either alone is beatable:
//
//    1. STRUCTURE — the chip renders the adapter's label through `sourceChipText`, and no source
//       file hardcodes a source string. A future adapter cannot be mislabelled by a literal.
//    2. BEHAVIOUR — the real adapters are put through the real function and the matrix is checked
//       (live says live, the capture says snapshot, the sample keeps its stronger wording).
//
//  Usage: node scripts/check-flow-live-label.mjs
// ============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOM = join(ROOT, 'apps', 'flow-room');
const CHIP = join(ROOM, 'src', 'room', 'components', 'stage', 'FlowRoom.tsx');
const ADAPTER = join(ROOM, 'src', 'room', 'lib', 'flow-adapter.ts');
const TEST = join(ROOM, 'src', 'room', 'lib', 'flow-live-label.test.ts');

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };

// ── 1. structure ───────────────────────────────────────────────────────────
const chip = existsSync(CHIP) ? readFileSync(CHIP, 'utf8') : '';
check(Boolean(chip), 'FlowRoom.tsx is missing — the chipbar cannot be checked');
check(/sourceChipText\s*\(\s*active\s*\)/.test(chip),
  'the chipbar does not render its text through sourceChipText(active) — the source label is not derived from the adapter');
check(!/"snapshot · pb graph --json"/.test(chip),
  'the chipbar hardcodes a source string again: a literal cannot know whether the data is live');

// Every room source file, not only the one chip: a hardcoded source label anywhere is the defect.
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(full);
  }
  return out;
};
// Comments are documentation, not a source claim: `/** Hide the "live · <root>" footer */` is a
// sentence ABOUT the label. This blanks comments before scanning — a regex over raw text cannot
// tell the two apart, which is the same bug the Wenmei-retired gate had.
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

const hardcoded = [];
for (const file of walk(join(ROOM, 'src'))) {
  const text = stripComments(readFileSync(file, 'utf8'));
  // `"snapshot · …"` / `"live · …"` as a bare literal: both are source claims. An adapter's own
  // `label: "…"` is the legitimate place, so the adapter file is allowed to declare them.
  if (file === ADAPTER) continue;
  if (/["'`](?:snapshot|live)\s·[^"'`]*["'`]/.test(text)) hardcoded.push(file.slice(ROOT.length + 1).replace(/\\/g, '/'));
}
check(hardcoded.length === 0,
  `a source label is hardcoded outside an adapter's own label field:\n      ${hardcoded.join('\n      ')}`);

const adapter = existsSync(ADAPTER) ? readFileSync(ADAPTER, 'utf8') : '';
check(/export function sourceChipText/.test(adapter), 'flow-adapter.ts no longer exports sourceChipText');
const labels = [...adapter.matchAll(/^\s*label:\s*"([^"]+)"/gm)].map((m) => m[1]);
check(labels.length >= 3, `expected at least three adapter labels (snapshot, sample, live), found ${labels.length}`);
check(labels.some((l) => l.startsWith('live')), 'no adapter declares a live label');
check(labels.some((l) => l.startsWith('snapshot')), 'no adapter declares a snapshot label');

// ── 2. behaviour ───────────────────────────────────────────────────────────
if (!existsSync(TEST)) {
  problems.push('the adapter-matrix test src/room/lib/flow-live-label.test.ts is missing — the structure check alone cannot prove the chip says the right thing');
} else {
  // The room's own vitest entry, run with this Node: a `.cmd` shim cannot be execFile'd without a
  // shell on Windows, which is why the first version of this gate reported an empty failure.
  const vitest = join(ROOM, 'node_modules', 'vitest', 'vitest.mjs');
  if (!existsSync(vitest)) {
    problems.push(`the room's vitest entry is not installed at ${vitest} — the matrix cannot be run`);
  } else {
    try {
      execFileSync(process.execPath, [vitest, 'run', 'src/room/lib/flow-live-label.test.ts'], {
        cwd: ROOM, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n      ');
      problems.push(`the adapter-matrix test failed:\n      ${out || String(err?.message ?? err)}`);
    }
  }
}

// ── report ─────────────────────────────────────────────────────────────────
if (problems.length) {
  console.error(`FLOW LIVE LABEL FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('The room says which source it is showing:');
console.log(`  adapters declaring a label : ${labels.length} (${labels.map((l) => l.split(' ·')[0]).join(', ')})`);
console.log('  the chip renders          : sourceChipText(adapter) — live, snapshot and sample are told apart');
console.log('  no source label is hardcoded outside an adapter, and the matrix test passes');
