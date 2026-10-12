#!/usr/bin/env node
// Proves coding-domain skills mount only under coding while engine-operation
// skills remain available through additive pack/global resolution.

import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbcoding-');
for (const dir of ['scripts', 'memory', 'modes', 'skills', 'processes']) {
  mkdirSync(join(root, dir), { recursive: true });
}
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyFileSync(resolve('modes/coding.yaml'), join(root, 'modes/coding.yaml'));
copyFileSync(resolve('modes/demo.yaml'), join(root, 'modes/demo.yaml'));
cpSync(resolve('modes/coding'), join(root, 'modes/coding'), { recursive: true });
cpSync(resolve('modes/demo'), join(root, 'modes/demo'), { recursive: true });
copyModules(resolve('node_modules'), join(root, 'node_modules'));

writeFileSync(join(root, 'playbook.yaml'), [
  'name: coding-pack-test',
  'index:',
  '  memory:',
  '    backlog: memory/backlog.yaml',
  '    journal: memory/journal.ndjson',
  '    loops: memory/loops.yaml',
  'default_mode: coding',
  'modes:',
  '  coding: modes/coding.yaml',
  '  demo: modes/demo.yaml',
  'guardrails:',
  '  allowed_statuses: [todo, in_progress, blocked, done]',
  '',
].join('\n'));
writeFileSync(join(root, 'skills/index.yaml'), [
  'skills:',
  '  - {id: run-task, file: skills/run-task.md}',
  '  - {id: harden, file: skills/harden.md}',
  '',
].join('\n'));
writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
writeFileSync(join(root, 'memory/backlog.yaml'), 'tasks: []\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');

const pb = join(root, 'scripts/pb.mjs');
const setMode = (mode) => writeFileSync(join(root, 'memory/loops.yaml'),
  `active: test-loop\nloops:\n  - {id: test-loop, status: active, mode: ${mode}}\n`);
const list = (kind) => execFileSync(process.execPath, [pb, 'list', kind], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

let pass = 0;
let fail = 0;
function check(name, condition, output = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
    pass++;
  } else {
    console.error(`  FAIL  ${name}${output ? `\n        ${output}` : ''}`);
    fail++;
  }
}

setMode('coding');
let output = list('skills');
check('code-conformance resolves under coding', /\bcode-conformance\b/.test(output), output);
check('run-task remains available under coding', /\brun-task\b/.test(output), output);
check('harden remains available under coding', /\bharden\b/.test(output), output);
output = list('processes');
check('code-conformance process resolves under coding', /\bcode-conformance\b/.test(output), output);

setMode('demo');
output = list('skills');
check('code-conformance is not visible under demo', !/\bcode-conformance\b/.test(output), output);
check('engine skills remain available under demo', /\brun-task\b/.test(output) && /\bharden\b/.test(output), output);

const processDoc = yaml.load(readFileSync(resolve('modes/coding/processes/code-conformance.yaml'), 'utf8'));
const tierIds = new Set((processDoc.verification_tiers || []).map((tier) => tier.id));
check('process makes contract/static/behavior/regression/anti-gaming executable concerns',
  ['contract', 'static', 'behavior', 'regression', 'anti-gaming'].every((id) => tierIds.has(id)));
const processText = JSON.stringify(processDoc);
check('process rejects cwd-based root assumptions', /do not assume cwd/i.test(processText));
check('process requires compilable examples and repair-oriented failures',
  /compilable example/i.test(processText) && /repair-oriented/i.test(processText));
check('process audits suppression and weakened tests',
  /suppression/i.test(processText) && /weakened (expectations|tests)/i.test(processText));

console.log(`\ntest-coding-pack-skills: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
