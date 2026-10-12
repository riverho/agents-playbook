#!/usr/bin/env node
// scripts/clean-test-fixtures.mjs — remove the temp fixtures old test runs left behind.
//
//   node scripts/clean-test-fixtures.mjs            dry run: list what would go
//   node scripts/clean-test-fixtures.mjs --execute  remove it
//
// Matches ONLY this repo's fixture names in os.tmpdir(): a test prefix (pb…-, flow-room-
// render-/browser-, "pb harness spaced ") followed by mkdtemp's 6-character suffix, plus a
// worker worktree created beside one (`<fixture>-worker-…`). Old fixtures LINK the repo's
// node_modules (some into other worktrees), so every link is unlinked — never followed —
// before a directory is removed (scripts/lib/test-temp.mjs removeTree).

import { readdirSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTree } from './lib/test-temp.mjs';

const execute = process.argv.includes('--execute');
const unknown = process.argv.slice(2).filter((a) => a !== '--execute');
if (unknown.length) { console.error(`clean-test-fixtures: unknown argument ${unknown.join(' ')}. Usage: [--execute]`); process.exit(2); }

const FIXTURE = /^(?:pb[a-z0-9-]*-|pb harness spaced |flow-room-(?:render|browser)-)[A-Za-z0-9]{6}(?:-worker-.+)?$/;
const root = tmpdir();
const hits = readdirSync(root).filter((name) => {
  if (!FIXTURE.test(name)) return false;
  try { return lstatSync(join(root, name)).isDirectory(); } catch { return false; }
});
if (!hits.length) { console.log(`No leftover test fixtures in ${root}.`); process.exit(0); }
const byPrefix = {};
for (const h of hits) { const k = h.replace(/[A-Za-z0-9]{6}(?:-worker-.+)?$/, '…'); byPrefix[k] = (byPrefix[k] || 0) + 1; }
console.log(`${hits.length} leftover test fixture dir(s) in ${root}:`);
for (const [k, n] of Object.entries(byPrefix).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
if (!execute) { console.log('\nDry run. Re-run with --execute to remove them (links are unlinked, never followed).'); process.exit(0); }
let removed = 0;
for (const h of hits) { removeTree(join(root, h)); try { lstatSync(join(root, h)); } catch { removed++; } }
console.log(`\nRemoved ${removed} of ${hits.length}.${removed < hits.length ? ' The rest are held open (a running process or a scanner); re-run later.' : ''}`);
