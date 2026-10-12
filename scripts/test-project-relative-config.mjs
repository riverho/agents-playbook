#!/usr/bin/env node
// scripts/test-project-relative-config.mjs
// ----------------------------------------------------------------------------
// Finding 4: a project's project.yaml may declare its scaffold config path
// RELATIVE to the project root. pb-daily-monitor must resolve it against the
// project root, not the playbook repo root. This builds a throwaway workspace
// with a project-relative config and asserts the monitor resolves+loads it
// (dry-run) instead of crashing with "Config not found".
// Red before the fix (resolved against ROOT -> not found), green after.
// ----------------------------------------------------------------------------
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { tempDir } from './lib/test-temp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MONITOR = resolve(ROOT, 'scripts/pb-daily-monitor.mjs');

const ws = tempDir('pb-relcfg-');
try {
  const proj = resolve(ws, 'tproj');
  mkdirSync(resolve(proj, 'scaffolds'), { recursive: true });
  // project.yaml declares the blogwatch config as a PROJECT-RELATIVE path.
  writeFileSync(resolve(proj, 'project.yaml'),
    'modes:\n  blogwatch: scaffolds/blogwatch-run.yaml\n', 'utf8');
  // The blogwatch scaffold needs items[].{id,source,criteria,check}.
  writeFileSync(resolve(proj, 'scaffolds/blogwatch-run.yaml'),
    'watches:\n  - id: t1\n    source: TestSrc\n    criteria: TestCrit\n    check: "true"\n', 'utf8');

  let out;
  try {
    out = execFileSync(process.execPath,
      [MONITOR, '--mode', 'blogwatch', '--project', 'tproj', '--dry-run'],
      { cwd: ROOT, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, PB_WORKSPACE_PROJECTS: ws } });
  } catch (e) {
    const msg = `${e.stdout || ''}${e.stderr || ''}`;
    console.error('  FAIL  monitor did not resolve the project-relative config');
    console.error(msg.split(/\r?\n/).slice(-6).map((l) => `        ${l}`).join('\n'));
    process.exit(1);
  }
  if (!/would plan:.*TestSrc/.test(out)) {
    console.error('  FAIL  monitor ran but did not plan the item from the relative config');
    console.error(out.split(/\r?\n/).slice(-6).map((l) => `        ${l}`).join('\n'));
    process.exit(1);
  }
  console.log('  PASS  project-relative config resolved against the project root');
  console.log('test-project-relative-config: OK');
} finally {
  rmSync(ws, { recursive: true, force: true });
}
