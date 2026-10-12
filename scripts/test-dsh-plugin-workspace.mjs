#!/usr/bin/env node
// scripts/test-dsh-plugin-workspace.mjs
// ----------------------------------------------------------------------------
// Which playbook does the plugin think this session owns?
//
// This suite exists because the answer was WRONG in a live deployment and no other
// suite could see it. Every other plugin suite passes an explicit
// `playbookPath`, so discovery short-circuits and the workspace-resolution path is
// never exercised. In the field it was: the plugin read `agent.session.cwd`, which
// the harness types mark optional, fell through to `process.cwd()` — the DSH
// SERVER's launch directory — and bound a session whose workspace was project A to
// project B's playbook, because that is where the server happened to be started.
//
// So the fixture is built to make exactly that mistake visible:
//
//   <tmp>/server/            <- the driver's process.cwd()  (playbook: project-b)
//     .agents-playbook/
//     node_modules/          <- harness peers, so the plugin can import
//   <tmp>/project-a/.agents-playbook/   <- the session's workspace (registry says so)
//
// A plugin that consults `process.cwd()` reports project-b. A plugin that consults
// the workspace registry reports project-a. Nothing else differs, so the assertion
// cannot pass for the wrong reason.
//
// The second half covers the other side of the same contract: when no workspace can
// be resolved at all, the plugin must REFUSE (not guess) — `status` finds no
// playbook, and `init` declines to scaffold into a directory the session does not
// own.
// ----------------------------------------------------------------------------

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempDir } from './lib/test-temp.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

const REPO = resolve('.');
const tmp = tempDir('pbplugws-');

// --- a minimal, VALID playbook, parameterised by its own name -----------------
// `pb status --json` reports this name, which is how the assertions tell the two
// fixtures apart without depending on any path being echoed back.
function makePlaybook(dir, name) {
  for (const d of ['scripts', 'memory', 'modes', 'processes', 'skills/run-task', 'artifacts/reports']) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  writeFileSync(join(dir, 'scripts', 'pb.mjs'), readFileSync(join(REPO, 'scripts', 'pb.mjs')));
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: t\ndescription: t\n---\n');
  writeFileSync(join(dir, 'memory', 'project-memory.md'), '# memory\n');
  writeFileSync(join(dir, 'memory', 'journal.ndjson'), '');
  writeFileSync(join(dir, 'memory', 'loops.yaml'), 'active: null\nloops: []\n');
  writeFileSync(join(dir, 'memory', 'cycle.md'),
    '# c\n## 1. What is this cycle\'s goal?\nws test\n## 2. What challenges do I foresee?\nNone\n' +
    '## 3. What were the previous challenges?\nNone\n## 4. Where do I stop?\nDone\n## 5. Do I have any conflicting memory?\nNone\n');
  writeFileSync(join(dir, 'memory', 'backlog.yaml'),
    'tasks:\n  - {id: W1, title: ws task, status: todo, priority: 1, skill: run-task}\n');
  writeFileSync(join(dir, 'processes', 'index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
  writeFileSync(join(dir, 'processes', 'run-task.yaml'), 'id: run-task\n');
  writeFileSync(join(dir, 'skills', 'index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
  writeFileSync(join(dir, 'skills', 'run-task', 'SKILL.md'), '---\nname: run-task\ndescription: t\n---\n');
  writeFileSync(join(dir, 'modes', 'coding.yaml'), 'id: coding\ndirective: ""\n');
  writeFileSync(join(dir, 'playbook.yaml'),
    `name: ${name}\nversion: 0.5.1\nentry: SKILL.md\n` +
    'paths:\n  scripts: scripts\n  processes: processes\n  skills: skills\n  memory: memory\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
    'index:\n  processes_index: processes/index.yaml\n  skills_index: skills/index.yaml\n  cli: scripts/pb.mjs\n  memory:\n    project_memory: memory/project-memory.md\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
    'loop:\n  description: test\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
    'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
    'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
  return join(dir, 'playbook.yaml');
}

const serverDir = join(tmp, 'server');
const serverPlaybook = join(serverDir, '.agents-playbook');
makePlaybook(serverPlaybook, 'project-b');

const wsDir = join(tmp, 'project-a');
const wsPlaybook = join(wsDir, '.agents-playbook');
makePlaybook(wsPlaybook, 'project-a');

// --- make the plugin importable FROM the server directory ---------------------
// The peers are the harness packages; probe first and skip honestly, exactly as the
// other plugin suites do, rather than failing for something this checkout cannot fix.
const DSH_CANDIDATES = [
  process.env.DSH_PACKAGES,
  'C:/Users/RH/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai',
  join(process.env.LOCALAPPDATA || '', 'npm-cache/_npx'),
].filter(Boolean);
function harnessDir() {
  for (const base of DSH_CANDIDATES) {
    if (base && existsSync(join(base, 'dsh-tools', 'package.json'))) return base;
  }
  return null;
}
const harness = harnessDir();
if (!harness) {
  console.log('  SKIP  harness packages not available — set DSH_PACKAGES to a @deepseek-ai directory to run this suite');
  console.log('\ntest-dsh-plugin-workspace: skipped (0 pass, 0 fail)');
  process.exit(0);
}

const nm = join(serverDir, 'node_modules');
mkdirSync(join(nm, '@deepseek-ai'), { recursive: true });
for (const pkg of ['dsh-tools', 'dsh-llm', 'schemastery', 'cordis']) {
  const from = join(harness, pkg);
  if (existsSync(from)) { try { symlinkSync(from, join(nm, '@deepseek-ai', pkg), 'junction'); } catch { /* exists */ } }
}
// Both fixtures live under `tmp`, so one copy here serves BOTH playbooks' engines:
// each `scripts/pb.mjs` walks up to it. Without this the playbooks cannot run at all
// and the suite would be measuring a module-resolution failure instead of the bug.
{
  const shared = join(tmp, 'node_modules');
  mkdirSync(shared, { recursive: true });
  try { symlinkSync(join(REPO, 'node_modules', 'js-yaml'), join(shared, 'js-yaml'), 'junction'); } catch { /* exists */ }
}

// --- the driver: real plugin, stub ctx, cwd = the SERVER directory -------------
const driverPath = join(serverDir, 'driver.mjs');
writeFileSync(driverPath, `
const plugin = await import(${JSON.stringify(new URL('../dsh-plugin/index.js', import.meta.url).href + '?ws=' + Date.now())});

const mode = process.argv[2];
const registered = [];
const services = { tools: { register: (t) => registered.push(t) } };

// The real service shape: a session -> owned directory mapping.
if (mode === 'registry') {
  services.workspaceRegistry = {
    list: () => [{ id: 'ws-1', path: ${JSON.stringify(wsDir)}, title: 'project-a', sessionIds: ['sess-1'] }],
  };
}

const ctx = {
  get tools() { return services.tools; },
  get skills() { return services.skills; },
  get workspaceRegistry() { return services.workspaceRegistry; },
  get(name) { return services[name]; },
  inject(keys, cb) { if (keys.every((k) => services[k])) cb(ctx); },
  on() {},
  logger: { warn() {} },
};

// NO playbookPath: discovery must resolve the workspace on its own. That is the point.
plugin.apply(ctx, { injectContext: false });
const tool = registered[0];
// The agent carries an id and a session id but NO cwd, mirroring the live harness
// where session.cwd was unset and the plugin fell through to process.cwd().
const agent = { id: 'agent-1', session: { id: 'sess-1' } };

const out = {};
out.cwd = process.cwd();
try { out.status = await tool.execute({ action: 'status' }, { agent }); }
catch (e) { out.statusError = String(e && e.message); }
// Only the no-workspace run exercises init: in the registry run there is nothing to
// scaffold, and running it would mutate the very fixture the assertions read.
if (mode === 'none') {
  try { out.init = await tool.execute({ action: 'init' }, { agent }); }
  catch (e) { out.initError = String(e && e.message); }
}
console.log('__R__' + JSON.stringify(out));
`);

function drive(mode) {
  const r = spawnSync(process.execPath, [driverPath, mode], { cwd: serverDir, encoding: 'utf8', timeout: 180_000 });
  const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__R__'));
  let out = null;
  try { out = JSON.parse(line.slice('__R__'.length)); } catch { /* reported by the caller */ }
  return { out, raw: `${r.stdout || ''}${r.stderr || ''}`.slice(-700) };
}

const readName = (dir) => {
  const m = /^name:\s*(.+)$/m.exec(readFileSync(join(dir, 'playbook.yaml'), 'utf8'));
  return m ? m[1].trim() : null;
};

// --- 1. the registry wins, and process.cwd() is never consulted ---------------
{
  const { out, raw } = drive('registry');
  ok('the driver ran and produced a result', !!out, raw);
  if (out) {
    ok('process.cwd() really was the OTHER project (the fixture is meaningful)',
      resolve(out.cwd) === resolve(serverDir), `cwd=${out.cwd}`);
    ok('the plugin resolved the session workspace from the registry, NOT process.cwd()',
      out.status?.status?.name === 'project-a',
      `resolved=${JSON.stringify(out.status?.status?.name)} expected=project-a (project-b would mean process.cwd() was used)\n` +
      `engine said: ${String(out.status?.text || out.statusError || '').slice(0, 300)}`);
    ok('the plugin did NOT adopt the playbook at process.cwd()',
      out.status?.status?.name !== 'project-b', `resolved=${out.status?.status?.name}`);
  }
}

// --- 2. no workspace at all: refuse, do not guess ----------------------------
{
  const { out, raw } = drive('none');
  ok('the driver ran with no workspace registry and no agent cwd', !!out, raw);
  if (out) {
    ok('status reports "no playbook found" instead of borrowing process.cwd()',
      out.status?.ok === false && out.status?.error === 'no playbook found',
      JSON.stringify(out.status) + '\n' + raw);
    ok('init refuses to scaffold into an unowned directory',
      out.init?.ok === false && out.init?.error === 'unknown workspace',
      JSON.stringify(out.init) + '\n' + raw);
    ok('the refusal explains what to do instead of failing silently',
      /playbookPath/.test(String(out.init?.detail || '')), String(out.init?.detail));
  }
}

// --- 3. the bystander playbook was left untouched -----------------------------
{
  ok('the playbook sitting at process.cwd() was never modified by init',
    readName(serverPlaybook) === 'project-b', `name=${readName(serverPlaybook)}`);
  ok('the session workspace playbook is intact',
    readName(wsPlaybook) === 'project-a', `name=${readName(wsPlaybook)}`);
}

// --- 4. the legacy singular install directory is discoverable ------------------
// Projects scaffolded before the plural spelling settled carry `.agent-playbook`;
// they must not be invisible.
{
  const legacyDir = join(tmp, 'legacy');
  const legacyPb = join(legacyDir, '.agent-playbook');
  makePlaybook(legacyPb, 'project-legacy');
  const { findPlaybookRoot } = await import(new URL('../dsh-plugin/core.mjs', import.meta.url).href);
  ok('a playbook at the legacy singular .agent-playbook is discovered',
    resolve(findPlaybookRoot({ workspace: legacyDir }) || '') === resolve(legacyPb),
    `found=${findPlaybookRoot({ workspace: legacyDir })}`);
  ok('the plural spelling still wins when both are present',
    (() => {
      makePlaybook(join(legacyDir, '.agents-playbook'), 'project-plural');
      return resolve(findPlaybookRoot({ workspace: legacyDir }) || '') === resolve(join(legacyDir, '.agents-playbook'));
    })());
}

console.log(`\ntest-dsh-plugin-workspace: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
