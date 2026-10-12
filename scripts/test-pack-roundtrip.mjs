#!/usr/bin/env node
// L1 loop proof (docs/pb-improvements-04072026.md §8.2): a mode leaves THIS
// repo as a .pbpack file and comes back alive in a DIFFERENT playbook.
//
// Build the real blogwatch pack → scaffold a scratch playbook root → strip
// blogwatch from it (fresh-install baseline) → prove the scratch validates →
// install the archive → prove validate/mode show/monitor dry-run all pass
// inside the scratch root.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PB = resolve(ROOT, 'scripts/pb.mjs');
const PACK = resolve(ROOT, 'scripts/pb-pack.mjs');
const tempRoot = tempDir('pb-pack-roundtrip-');
const scratch = resolve(tempRoot, 'scratch');
let pass = 0;
let total = 0;

function assert(name, condition, result) {
  total++;
  if (!condition) {
    console.error(`  FAIL  ${name}`);
    if (result) console.error(`${result.stdout || ''}${result.stderr || ''}`.trim());
    process.exitCode = 1;
    return;
  }
  console.log(`  PASS  ${name}`);
  pass++;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

try {
  // 1. Build the REAL blogwatch pack from this repo's modes/.
  const dist = resolve(tempRoot, 'dist');
  let r = run(process.execPath, [PACK, 'build', 'blogwatch', '--out', dist], { cwd: ROOT });
  const archive = r.status === 0 ? r.stdout.trim().split(/\s+/)[0] : null;
  assert('pb-pack build produces archive + sidecar',
    r.status === 0 && archive && existsSync(archive) && existsSync(`${archive}.sha256`), r);

  // 2. Scratch playbook root via the engine's own scaffold (copy-don't-clobber),
  //    then strip blogwatch so the install below is a real fresh install.
  r = run(process.execPath, [PB, 'scaffold', '--target', scratch], { cwd: ROOT });
  assert('pb scaffold sets up the scratch root', r.status === 0 && existsSync(resolve(scratch, 'playbook.yaml')), r);

  // The scaffolded pb.mjs needs js-yaml, and the monitor dry-run needs the
  // orchestrator + its lib (scaffold only ships the engine CLI).
  copyModules(resolve(ROOT, 'node_modules'), resolve(scratch, 'node_modules'));
  copyFileSync(resolve(ROOT, 'scripts/pb-daily-monitor.mjs'), resolve(scratch, 'scripts/pb-daily-monitor.mjs'));
  mkdirSync(resolve(scratch, 'scripts/lib'), { recursive: true });
  cpSync(resolve(ROOT, 'scripts/lib'), resolve(scratch, 'scripts/lib'), { recursive: true });

  rmSync(resolve(scratch, 'modes/blogwatch'), { recursive: true, force: true });
  rmSync(resolve(scratch, 'modes/blogwatch.yaml'), { force: true });
  // Strip the registration from the master's `modes:` map. Do it via the parsed
  // document, not a line regex: the map's entries are each preceded by a comment
  // line, so a `^\s{2}id:` substitution is brittle and silently no-ops when the
  // source playbook gains or loses a comment — which is exactly how this test
  // broke before. yaml.dump drops the map's comments, which is fine for a scratch
  // fixture.
  const playbookPath = resolve(scratch, 'playbook.yaml');
  const masterDoc = yaml.load(readFileSync(playbookPath, 'utf8'));
  delete masterDoc.modes.blogwatch;
  writeFileSync(playbookPath, yaml.dump(masterDoc, { lineWidth: 100 }), 'utf8');
  const catalogPath = resolve(scratch, 'modes/index.yaml');
  const catalog = yaml.load(readFileSync(catalogPath, 'utf8'));
  catalog.modes = (catalog.modes || []).filter((m) => m.id !== 'blogwatch');
  writeFileSync(catalogPath, yaml.dump(catalog), 'utf8');
  // (default_monitor_mode: blogwatch may remain — that's a preference, not a
  // registration; the fresh-install baseline is: no files, no map/catalog entry.)
  assert('scratch starts WITHOUT blogwatch',
    !existsSync(resolve(scratch, 'modes/blogwatch'))
      && !existsSync(resolve(scratch, 'modes/blogwatch.yaml'))
      && !/^\s{2}blogwatch:/m.test(readFileSync(playbookPath, 'utf8'))
      && !/^\s*-?\s*id:\s*blogwatch\s*$/m.test(readFileSync(catalogPath, 'utf8')));

  const scratchPb = resolve(scratch, 'scripts/pb.mjs');

  // 3. Clean baseline: the scratch validates BEFORE the install.
  r = run(process.execPath, [scratchPb, 'validate'], { cwd: scratch });
  assert('scratch pb validate green BEFORE install', r.status === 0, r);

  // 4. Install the archive into the scratch root.
  r = run(process.execPath, [PACK, 'install', archive, '--root', scratch], { cwd: ROOT });
  assert('pb-pack install into scratch exits 0', r.status === 0, r);

  // 5. The mode is alive in its new home.
  r = run(process.execPath, [scratchPb, 'validate'], { cwd: scratch });
  assert('scratch pb validate green AFTER install (map ↔ catalog agree)', r.status === 0, r);

  r = run(process.execPath, [scratchPb, 'mode', 'show', 'blogwatch'], { cwd: scratch });
  assert('mode show blogwatch works in scratch and lists watch-feeds',
    r.status === 0 && /watch-feeds/.test(r.stdout), r);

  r = run(process.execPath, [resolve(scratch, 'scripts/pb-daily-monitor.mjs'), '--dry-run', '--mode', 'blogwatch'],
    { cwd: scratch });
  assert('monitor scaffold dry-run green in scratch', r.status === 0, r);

  console.log(`test-pack-roundtrip: ${pass} pass, ${total - pass} fail`);
  if (pass !== total) process.exitCode = 1;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
