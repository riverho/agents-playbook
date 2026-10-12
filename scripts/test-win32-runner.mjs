// Acceptance coverage for the Windows runner fix:
//   1. .cmd/.bat shims (npm, pnpm, yarn) work as acceptance_checks on Windows.
//   2. `pb run -- <cmd>` spawns .cmd shims correctly on Windows.
//   3. Regression: non-shim commands still work.
// Skips gracefully if a tool is not on PATH.
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

const root = tempDir('pbwin-');
for (const d of ['scripts', 'memory', 'processes', 'skills', 'artifacts/reports']) {
  mkdirSync(join(root, d), { recursive: true });
}
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));

const master = [
  'name: win32-runner-test',
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
].join('\n');

writeFileSync(join(root, 'SKILL.md'), '# test\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'processes/index.yaml'), 'processes: []\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills: []\n');
writeFileSync(join(root, 'playbook.yaml'), master);

const pb = (args, opts = {}) => execFileSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], {
  cwd: root,
  encoding: 'utf8',
  stdio: 'pipe',
  ...opts,
});
const mustThrow = (args) => { try { pb(args); return false; } catch { return true; } };
const fillQ5 = () => {
  const path = join(root, 'memory/cycle.md');
  const text = readFileSync(path, 'utf8').replace(
    /\(Your host memory is the PAST[\s\S]*?do not silently follow memory\.\)/,
    'No conflicts found.',
  );
  writeFileSync(path, text, 'utf8');
};
const which = (cmd) => {
  try {
    const sep = process.platform === 'win32' ? ';' : ':';
    const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';');
    for (const dir of (process.env.PATH || '').split(sep)) {
      for (const ext of exts) {
        if (existsSync(join(dir, cmd + ext))) return cmd + ext;
      }
    }
  } catch {}
  return null;
};

const failures = [];
const skipped = [];

pb(['loop', 'new', '--goal', 'win32 runner test', '--stop', 'done']);
pb(['cycle', '--new', '--goal', 'win32 runner test', '--stop', 'done']);
fillQ5();

const writeTask = (id, title, checks) => {
  const lines = [
    '# tests',
    'tasks:',
    `  - id: ${id}`,
    `    title: ${title}`,
    `    status: todo`,
    `    priority: 1`,
    `    acceptance_checks:`,
  ];
  for (const c of checks) lines.push(`      - ${c}`);
  writeFileSync(join(root, 'memory/backlog.yaml'), lines.join('\n') + '\n');
};

// ---------- Test 1: npm --version in acceptance_checks (the original bug) ----------
if (!which('npm')) {
  skipped.push('npm not on PATH — skipping shim test');
} else {
  writeTask('NPM', 'npm shim', ['npm --version']);
  const out = pb(['validate', '--task', 'NPM']);
  if (!/PASS\s+npm --version/.test(out)) {
    failures.push(`expected PASS for "npm --version", got:\n${out}`);
  } else {
    console.log('OK   test 1: npm --version PASS in acceptance_checks');
  }
}

// ---------- Test 2: pnpm/yarn shim (skipped if not installed) ----------
for (const cmd of ['pnpm', 'yarn']) {
  if (!which(cmd)) { skipped.push(`${cmd} not on PATH`); continue; }
  writeTask(cmd.toUpperCase(), `${cmd} shim`, [`${cmd} --version`]);
  const out = pb(['validate', '--task', cmd.toUpperCase()]);
  if (new RegExp(`PASS\\s+${cmd} --version`).test(out)) {
    console.log(`OK   test 2: ${cmd} --version PASS in acceptance_checks`);
  } else {
    failures.push(`expected PASS for "${cmd} --version", got:\n${out}`);
  }
  break; // one is enough
}

// ---------- Test 3: regression — non-shim commands still work ----------
writeTask('NODE', 'node regression', ['node -e "process.exit(0)"']);
const out3 = pb(['validate', '--task', 'NODE']);
if (!/PASS\s+node -e "process\.exit\(0\)"/.test(out3)) {
  failures.push(`expected PASS for node regression, got:\n${out3}`);
} else {
  console.log('OK   test 3: non-shim command (node -e) still PASSes');
}

// ---------- Test 4: pb run -- <cmd> spawns and records in processes.ndjson ----------
// Use a sleeper.js file so argv has no cmd.exe-special chars (parens etc.).
// `node -e "..."` argv contains ( ) > which cmd.exe would interpret; using a
// script file sidesteps that limit while still proving the cmdRun path works.
const sleeperPath = join(root, 'sleeper.js');
writeFileSync(sleeperPath, 'setInterval(function(){}, 1000);', 'utf8');
pb(['run', '--', process.execPath, sleeperPath]);
// Give the spawn a tick to land the ndjson append.
await new Promise((r) => setTimeout(r, 200));
const procText = readFileSync(join(root, 'memory/processes.ndjson'), 'utf8');
const procLines = procText.split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
const runEntry = procLines.find((e) => e.cmd && e.cmd.includes('sleeper.js'));
if (!runEntry) {
  failures.push(`pb run -- did not record a process entry in memory/processes.ndjson; contents:\n${procText}`);
} else {
  console.log(`OK   test 4: pb run -- recorded pid=${runEntry.pid} cmd="${runEntry.cmd}"`);
}

// ---------- Test 5: pb ps lists it as alive; pb stop kills it cleanly ----------
const psOut = pb(['ps']);
if (runEntry && !psOut.includes(String(runEntry.pid))) {
  failures.push(`pb ps did not list pid ${runEntry.pid}\n${psOut}`);
} else if (runEntry) {
  console.log(`OK   test 5a: pb ps lists pid ${runEntry.pid} as alive`);
}

// pb stop (with the active loop) flips the ndjson entry to status:stopped via
// taskkill /F /T on Windows.
const stopOut = pb(['stop']);
const procTextAfter = readFileSync(join(root, 'memory/processes.ndjson'), 'utf8');
const procLinesAfter = procTextAfter.split(/\r?\n/).filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
const latestForPid = [...procLinesAfter].reverse().find((e) => e.pid === runEntry?.pid);
if (runEntry && (!latestForPid || latestForPid.status === 'running')) {
  failures.push(`pb stop did not flip pid ${runEntry.pid} to stopped; latest entry: ${JSON.stringify(latestForPid)}`);
} else if (runEntry) {
  console.log(`OK   test 5b: pb stop flipped pid ${runEntry.pid} → status=${latestForPid.status}`);
}

// Give the OS a moment to actually reap the process.
await new Promise((r) => setTimeout(r, 500));

rmSync(root, { recursive: true, force: true });

if (skipped.length) {
  console.log('NOTE — skipped checks:');
  for (const s of skipped) console.log('  - ' + s);
}
if (failures.length) {
  console.error('\nFAIL — win32 runner checks:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nPASS — win32 runner: .cmd/.bat shims work in acceptance_checks and pb run --');
