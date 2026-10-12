#!/usr/bin/env node
// scripts/test-scaffold-field-validation.mjs
// ----------------------------------------------------------------------------
// Finding 3: the generalized loadConfig only checked id_field + check_field, so
// an item missing the fields the mode's goal_template substitutes was silently
// planned with an empty goal ("Monitor  for "). loadConfig must reject an item
// that omits any ${field} referenced by the scaffold's goal_template.
//
// blogwatch's goal_template is "Monitor ${source} for ${criteria}". A watch with
// only {id, check} must be rejected. Red before the fix (accepted, exit 0),
// green after (non-zero with a goal_template-field error).
// ----------------------------------------------------------------------------
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tempDir } from './lib/test-temp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MONITOR = resolve(ROOT, 'scripts/pb-daily-monitor.mjs');

function runMonitor(configPath) {
  try {
    const out = execFileSync(process.execPath,
      [MONITOR, '--mode', 'blogwatch', '--config', configPath, '--dry-run'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

const dir = tempDir('pb-fieldval-');
try {
  // 1. BAD: item omits source/criteria (the goal_template fields) -> must be rejected.
  const bad = resolve(dir, 'bad.yaml');
  writeFileSync(bad, 'watches:\n  - id: b1\n    check: "true"\n', 'utf8');
  const r1 = runMonitor(bad);
  if (r1.code === 0) {
    console.error('  FAIL  item missing goal_template fields was accepted (should be rejected)');
    console.error(r1.out.split(/\r?\n/).slice(-6).map((l) => `        ${l}`).join('\n'));
    process.exit(1);
  }
  if (!/goal_template field/i.test(r1.out)) {
    console.error('  FAIL  rejected, but not with a goal_template-field error (masking a different failure)');
    console.error(r1.out.split(/\r?\n/).slice(-6).map((l) => `        ${l}`).join('\n'));
    process.exit(1);
  }
  console.log('  PASS  item missing a goal_template field is rejected with a clear error');

  // 2. GOOD: complete item still loads (guard is not over-broad).
  const good = resolve(dir, 'good.yaml');
  writeFileSync(good,
    'watches:\n  - id: g1\n    source: Src\n    criteria: Crit\n    check: "true"\n', 'utf8');
  const r2 = runMonitor(good);
  if (r2.code !== 0 || !/would plan:.*Src/.test(r2.out)) {
    console.error('  FAIL  a complete item was rejected (guard too strict)');
    console.error(r2.out.split(/\r?\n/).slice(-6).map((l) => `        ${l}`).join('\n'));
    process.exit(1);
  }
  console.log('  PASS  a complete item still plans');
  console.log('test-scaffold-field-validation: OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
