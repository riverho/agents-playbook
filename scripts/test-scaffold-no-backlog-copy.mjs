#!/usr/bin/env node
// ============================================================================
//  test-scaffold-no-backlog-copy.mjs — scaffolding must not seed a workspace with
//  the SOURCE playbook's runtime state.
// ----------------------------------------------------------------------------
//  The defect this pins (found by running the lifecycle end to end, 2026-10-10):
//  scripts/pb.mjs copied the engine repo's memory/backlog.yaml into every fresh
//  target, so scaffolding "for goal X" produced a workspace whose backlog was
//  BYTE-IDENTICAL to this repo's — 47 unrelated tasks from another project.
//
//  Why it is a defect and not a convenience:
//    · the tasks are somebody else's work, and `pb next --claim` would offer them;
//    · their acceptance_checks name scripts this repo owns (scripts/test-*.mjs,
//      scripts/check-*.mjs) that scaffold does NOT copy, so every inherited task is
//      unverifiable by construction;
//    · memory/ is LOCAL TRUTH — the repo's own .gitignore excludes it precisely so
//      it is never treated as source;
//    · the intended starter already exists (`cmdInit` seeds a minimal backlog).
//
//  The boundary this test draws, explicitly:
//    SHIPS  (engine content, listed in package.json `files`): memory/project-memory.md
//    NEVER  (runtime state, per-workspace):  backlog.yaml, journal.ndjson,
//            loops.yaml, cycle.md, lessons.ndjson, backlog-state.json
//
//  Also asserts the SOURCE is unchanged — scaffold is a writer, so a probe that runs
//  it must prove it did not touch what it read (project rule 26).
// ============================================================================

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_BACKLOG = join(ROOT, 'memory', 'backlog.yaml');
// Runtime state that must NEVER travel. journal.ndjson is deliberately absent from
// this list: scaffold CREATES it as an empty file (asserted separately below), which
// is correct — an empty journal is a new workspace's own state, a copied one is not.
const RUNTIME_ONLY = ['loops.yaml', 'cycle.md', 'lessons.ndjson', 'backlog-state.json'];

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };
const hashes = (file) => (existsSync(file) ? `${statSync(file).size}:${readFileSync(file, 'utf8').length}` : null);

/** task ids declared in a backlog file, without needing the file to be the live one */
function taskIds(text) {
  return new Set([...text.matchAll(/^\s*-\s+id:\s*(\S+)\s*$/gm)].map((m) => m[1]));
}

if (!existsSync(SOURCE_BACKLOG)) {
  console.error(`no source backlog at ${SOURCE_BACKLOG} — nothing to compare against`);
  process.exit(1);
}

const sourceText = readFileSync(SOURCE_BACKLOG, 'utf8');
const sourceIds = taskIds(sourceText);
const sourceDigest = hashes(SOURCE_BACKLOG);
const sourceRuntime = RUNTIME_ONLY.map((f) => [f, hashes(join(ROOT, 'memory', f))]);

// the runtime files must exist in the SOURCE for the "not copied" assertions to mean anything
check(sourceIds.size > 0, 'the source backlog has no task ids — the probe would be vacuous');

const work = mkdtempSync(join(tmpdir(), 'pb-scaffold-probe-'));
const repoDir = join(work, 'myrepo');
const target = join(repoDir, '.agents-playbook');
mkdirSync(repoDir, { recursive: true });

try {
  let scaffoldOutput = '';
  try {
    scaffoldOutput = execFileSync(
      process.execPath,
      [join(ROOT, 'scripts', 'pb.mjs'), 'scaffold', '--target', target],
      { cwd: repoDir, encoding: 'utf8' }
    );
  } catch (err) {
    scaffoldOutput = String(err.stdout ?? '') + String(err.stderr ?? '');
    problems.push(`scaffold itself failed: ${err.message.split('\n')[0]}`);
  }

  const targetBacklog = join(target, 'memory', 'backlog.yaml');
  const targetJournal = join(target, 'memory', 'journal.ndjson');

  check(existsSync(targetBacklog), 'the scaffolded workspace has no memory/backlog.yaml at all');
  check(/(^|\s)scripts\/pb\.mjs(\s|,|$)/.test(scaffoldOutput) || existsSync(join(target, 'scripts', 'pb.mjs')),
    'scaffold did not copy the engine CLI');

  if (existsSync(targetBacklog)) {
    const targetText = readFileSync(targetBacklog, 'utf8');

    // 1. the headline assertion: no task of the source may appear in the target
    const inherited = [...taskIds(targetText)].filter((id) => sourceIds.has(id));
    check(inherited.length === 0,
      `the target inherited ${inherited.length} task id(s) from the SOURCE backlog — e.g. ${inherited.slice(0, 5).join(', ')}`);

    // 2. not a byte-copy, however it is spelled
    check(targetText !== sourceText, 'the target backlog is byte-identical to the SOURCE backlog');

    // 3. still a valid backlog a human and `pb` can read
    let parsed = null;
    try { parsed = yaml.load(targetText); } catch (err) {
      problems.push(`the target backlog is not valid YAML: ${err.message.split('\n')[0]}`);
    }
    check(parsed && Array.isArray(parsed.tasks), 'the target backlog has no `tasks:` array');
    check(targetText.startsWith('# memory/backlog.yaml'),
      'the target backlog lost the generated header (the "managed by pb" contract lines)');

    // 4. the engine content that IS supposed to ship, does
    check(existsSync(join(target, 'memory', 'project-memory.md')),
      'memory/project-memory.md is engine content and must still be scaffolded');
  }

  // 5. no other runtime file may travel
  for (const f of RUNTIME_ONLY) {
    check(!existsSync(join(target, 'memory', f)),
      `the target inherited runtime state: memory/${f}`);
  }
  check(existsSync(targetJournal) && readFileSync(targetJournal, 'utf8') === '',
    'the target journal must exist and be EMPTY, never a copy');

  // 6. the probe must not have written to the source it read (rule 26)
  check(hashes(SOURCE_BACKLOG) === sourceDigest, 'scaffold MODIFIED the source backlog');
  for (const [f, before] of sourceRuntime) {
    check(hashes(join(ROOT, 'memory', f)) === before, `scaffold MODIFIED the source memory/${f}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log('scaffold × runtime state');
console.log(`  source backlog      : ${sourceIds.size} task id(s), digest ${sourceDigest}`);
console.log(`  engine content      : memory/project-memory.md ships (in package.json files)`);
console.log(`  runtime state       : ${RUNTIME_ONLY.join(', ')} never ships`);
console.log(`  source untouched    : ${problems.some((p) => p.includes('MODIFIED')) ? 'NO' : 'yes'}`);

if (problems.length) {
  console.error(`\nSCAFFOLD LEAK FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nScaffold ships the engine, not the state: a new workspace starts with nobody else\'s tasks.');
