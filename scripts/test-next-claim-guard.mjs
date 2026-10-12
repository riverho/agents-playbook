// Acceptance coverage for the `next --claim` guardrail gap: `pb checkpoint` detects a
// missing loop / missing or stale cycle brief, but `pb next --claim` used to ignore all
// of that and claim anyway. This proves claiming is now refused until those preconditions
// are met (and that --force still allows an explicit override).
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbclaim-');
for (const d of ['scripts', 'memory', 'processes', 'skills', 'artifacts/reports']) {
  mkdirSync(join(root, d), { recursive: true });
}
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));

writeFileSync(join(root, 'SKILL.md'), '# test skill\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills: []\n');
writeFileSync(join(root, 'memory/backlog.yaml'), [
  'tasks:',
  '  - id: A',
  '    title: task A',
  '    status: todo',
  '    priority: 1',
  '    acceptance_checks:',
  '      - node scripts/pb.mjs validate',
  '  - id: B',
  '    title: task B',
  '    status: todo',
  '    priority: 2',
  '    acceptance_checks:',
  '      - node scripts/pb.mjs validate',
  '',
].join('\n'));
writeFileSync(join(root, 'playbook.yaml'), [
  'name: t',
  'version: 0.3.1',
  'entry: SKILL.md',
  'paths:',
  '  scripts: scripts',
  '  processes: processes',
  '  skills: skills',
  '  memory: memory',
  '  artifacts: artifacts',
  '  reports: artifacts/reports',
  'index:',
  '  processes_index: processes/index.yaml',
  '  skills_index: skills/index.yaml',
  '  memory:',
  '    project_memory: memory/project-memory.md',
  '    backlog: memory/backlog.yaml',
  '    journal: memory/journal.ndjson',
  '    cycle: memory/cycle.md',
  '    loops: memory/loops.yaml',
  '    lessons: memory/lessons.ndjson',
  '    processes: memory/processes.ndjson',
  'loop:',
  '  description: test',
  'guardrails:',
  '  allowed_statuses: [todo, in_progress, blocked, done]',
  '',
].join('\n'));

const pb = (args) => execFileSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'pipe',
});
const tryRun = (args) => {
  try { return { ok: true, out: pb(args) }; }
  catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || '') }; }
};
const fillQ5 = () => {
  const path = join(root, 'memory/cycle.md');
  const text = readFileSync(path, 'utf8').replace(
    /\(Your host memory is the PAST[\s\S]*?do not silently follow memory\.\)/,
    'No conflicts found.',
  );
  writeFileSync(path, text, 'utf8');
};

// 1. No loop, no cycle brief at all — claiming must be refused.
let r = tryRun(['next', '--claim']);
if (r.ok) throw new Error('next --claim succeeded with no active loop and no cycle brief');
if (!/No active loop/.test(r.out)) throw new Error('refusal did not mention the missing loop');
if (!/No cycle brief/.test(r.out)) throw new Error('refusal did not mention the missing cycle brief');

// 2. Loop open, but still no cycle brief — still refused.
pb(['loop', 'new']);
r = tryRun(['next', '--claim']);
if (r.ok) throw new Error('next --claim succeeded with an active loop but no cycle brief');
if (!/No cycle brief/.test(r.out)) throw new Error('refusal did not mention the missing cycle brief once a loop was open');

// 3. Cycle opened but Q5 left as the unfilled placeholder — still refused.
pb(['cycle', '--new', '--goal', 'phase one', '--stop', 'A done']);
r = tryRun(['next', '--claim']);
if (r.ok) throw new Error('next --claim succeeded with an unanswered Q5 memory-conflict check');
if (!/Q5/.test(r.out)) throw new Error('refusal did not mention the unanswered Q5 check');

// 4. Fill Q5 — claim should now succeed.
fillQ5();
r = tryRun(['next', '--claim']);
if (!r.ok) throw new Error(`next --claim was refused once loop + cycle were both satisfied: ${r.out}`);
pb(['record', '--task', 'A', '--action', 'work', '--status', 'done']);

// 5. Close the phase with `pb reflect` — the brief is now stale for the next claim.
pb(['reflect', '--notes', 'phase one wrapped']);
r = tryRun(['next', '--claim']);
if (r.ok) throw new Error('next --claim succeeded against a cycle brief made stale by `pb reflect`');
if (!/stale/.test(r.out)) throw new Error('refusal did not mention the stale cycle brief');

// 6. --force overrides the guard explicitly.
r = tryRun(['next', '--claim', '--force']);
if (!r.ok) throw new Error(`--force did not override the stale-cycle guard: ${r.out}`);

console.log('PASS — `next --claim` enforces active-loop + cycle-brief preconditions that `checkpoint` only used to warn about');
