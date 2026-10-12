#!/usr/bin/env node
// scripts/pb-flow.mjs
// ----------------------------------------------------------------------------
// Flow runner — run a sequence of monitor modes with artifact-dir handoff.
// A flow is flows/<id>.yaml listing ordered steps, each { mode, input?, output? }.
// Sequencing lives ONLY in the flow file (modes carry no next: pointers). Handoff
// is explicit artifact dirs (decided design): step A writes its `output` dir; step
// B reads it as its `input`. Semantics:
//   - ONE loop epoch per flow run (the runner opens it; each step reuses it).
//   - FAIL-FAST: a step whose backlog does not drain halts the flow with a
//     non-zero exit; later steps do not run.
//
// Usage: node scripts/pb-flow.mjs --flow <id|path> [--dry-run]
// ----------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { readActiveLoop, runNode } from './lib/loop-lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PB = resolve(ROOT, 'scripts/pb.mjs');
const MONITOR = resolve(ROOT, 'scripts/pb-daily-monitor.mjs');

function parseArgs(argv) {
  const args = { flow: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--flow') args.flow = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (!args.flow) args.flow = a;
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.flow) {
  console.error('Usage: node scripts/pb-flow.mjs --flow <id|path> [--dry-run]');
  process.exit(1);
}

function flowPath(idOrPath) {
  if (idOrPath.includes('/') || idOrPath.endsWith('.yaml')) return resolve(ROOT, idOrPath);
  return resolve(ROOT, 'flows', `${idOrPath}.yaml`);
}

function loadFlow(idOrPath) {
  const abs = flowPath(idOrPath);
  if (!existsSync(abs)) throw new Error(`Flow not found: ${abs}`);
  const doc = yaml.load(readFileSync(abs, 'utf8')) || {};
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    throw new Error(`Flow ${idOrPath} must have a non-empty "steps" array`);
  }
  return doc;
}

const runPb = (argv) => runNode(PB, argv, { cwd: ROOT });

function runStep(step, dryRun) {
  // the flow opened (or reused) this loop for its steps: the monitor runs inside it on purpose
  const argv = ['--mode', step.mode, '--adopt-loop'];
  if (step.input) argv.push('--input', step.input);
  if (step.output) argv.push('--output', step.output);
  if (dryRun) argv.push('--dry-run');
  return runNode(MONITOR, argv, { cwd: ROOT });
}

// ----------------------------------------------------------------------------
const flow = loadFlow(args.flow);
const flowId = flow.id || args.flow;
console.log(`[flow ${flowId}] ${flow.steps.length} step(s)`);

// One loop epoch per flow run. Open it here so every step reuses it (the monitor
// reuses an existing active loop). If a loop is already active, reuse it as-is.
let loop = args.dryRun ? null : readActiveLoop(ROOT);
if (!args.dryRun && !loop) {
  const r = runPb(['loop', 'new', '--fresh', '--goal', `Flow: ${flowId}`, '--stop', 'All flow steps drained']);
  if (r.code !== 0) {
    console.error(`[flow ${flowId}] could not open loop epoch:\n${r.out || ''}`);
    process.exit(1);
  }
  loop = readActiveLoop(ROOT);
}
const epoch = args.dryRun ? '(dry-run)' : (loop?.id || '(none)');
console.log(`[flow ${flowId}] epoch: ${epoch}`);

for (let i = 0; i < flow.steps.length; i++) {
  const step = flow.steps[i];
  console.log(`\n[flow ${flowId}] step ${i + 1}/${flow.steps.length}: mode=${step.mode}` +
    `${step.input ? ` input=${step.input}` : ''}${step.output ? ` output=${step.output}` : ''}`);
  const r = runStep(step, args.dryRun);
  process.stdout.write(r.out || '');
  if (r.code !== 0) {
    // FAIL-FAST: do not run later steps.
    console.error(`\n[flow ${flowId}] HALTED at step ${i + 1} (mode=${step.mode}, exit=${r.code}). ` +
      `${flow.steps.length - i - 1} later step(s) skipped.`);
    process.exit(r.code);
  }
}

console.log(`\n[flow ${flowId}] all ${flow.steps.length} step(s) drained cleanly.`);
