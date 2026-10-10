#!/usr/bin/env node
// scripts/test-check-timeout.mjs
// ----------------------------------------------------------------------------
// "Done" means a check exited 0. A check KILLED BY A TIMER is neither a pass nor a
// failure — it is an unanswered question, and this suite pins that distinction.
//
// The defect it guards: the timeout was a hard-coded 120000ms while this repo's own
// `npm test` took ~112s, so an 8s margin decided whether a GREEN suite was recorded or
// refused — and a killed check was reported exactly like a red one, which is why it
// stayed invisible. The resolution order is now most-specific-first:
//
//   1. task.`check_timeout_ms`      the command's own budget
//   2. env `PB_CHECK_TIMEOUT_MS`    the machine / CI override
//   3. the documented default       bounded, so a hang still surfaces
//
// Assertions, all through the real CLI against a temp playbook:
//   A. a check under the limit passes, and the run prints the resolved limit + source
//   B. the default is BOUNDED and is the number SKILL.md and `pb help` document
//   C. a check that sleeps past the limit is reported as TIMEOUT, never as FAIL
//   D. the limit is honoured from the env var — in both directions
//   E. the limit is honoured from the task field, and the field BEATS the env var
//   F. a genuinely failing check is still a FAIL, with no TIMEOUT in sight
//   G. a refused `record --status done` says TIMED OUT (not "checks failed") and writes
//      no row; when a row IS written (auto-run) it carries `checks: timed-out` + details
//   H. a nonsense field value warns and falls back to the next source
// ----------------------------------------------------------------------------
import {
  mkdirSync, mkdtempSync, copyFileSync, cpSync, writeFileSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of ['PB_CLAIM_TOKEN', 'PB_AGENT_CHAIN', 'PB_PARENT_AGENT_ID', 'PB_AGENT_ID', 'PB_SESSION_ID', 'PB_RUNTIME', 'PB_CHECK_TIMEOUT_MS']) delete e[k];
  return e;
})();
function runPb(root, args, { agent = 'agent', env = {} } = {}) {
  const r = spawnSync(process.execPath, [join(root, 'scripts/pb.mjs'), ...args], {
    cwd: root, encoding: 'utf8', env: { ...BASE_ENV, PB_AGENT_ID: agent, ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '', combined: `${r.stdout || ''}${r.stderr || ''}` };
}
const readJournal = (root) => readFileSync(join(root, 'memory/journal.ndjson'), 'utf8')
  .split(/\r?\n/).filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Helper scripts, not `node -e "..."`: cmd.exe treats ( ) < > & | specially, so a
// one-liner is a fixture bug waiting to happen (measured: `=>` becomes a redirect).
const SLOW_JS = 'setTimeout(() => {}, Number(process.argv[2] || 0));\n';
const FAIL_JS = 'process.exit(3);\n';

function makeFixture({ tasks }) {
  const root = mkdtempSync(join(tmpdir(), 'pbtimeout-'));
  for (const d of ['scripts', 'memory', 'modes', 'skills/run-task', 'processes', 'artifacts/reports']) {
    mkdirSync(join(root, d), { recursive: true });
  }
  copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
  cpSync(resolve('node_modules'), join(root, 'node_modules'), { recursive: true });  // a COPY, never a link
  copyFileSync(resolve('SKILL.md'), join(root, 'SKILL.md'));
  writeFileSync(join(root, 'slow.js'), SLOW_JS);
  writeFileSync(join(root, 'fail.js'), FAIL_JS);
  writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - {id: run-task, file: skills/run-task/SKILL.md, process: run-task}\n');
  writeFileSync(join(root, 'skills/run-task/SKILL.md'), '# run-task\n');
  writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - {id: run-task, file: processes/run-task.yaml}\n');
  writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\nsteps: []\n');
  writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
  writeFileSync(join(root, 'memory/project-memory.md'), '# fixture memory\n');
  writeFileSync(join(root, 'memory/loops.yaml'), 'active: L1\nloops:\n  - id: L1\n    status: active\n    started_at: 2026-01-01T00:00:00.000Z\n');
  writeFileSync(join(root, 'memory/cycle.md'), '# c\n## 1. Goal\ntimeouts\n## 4. Stop\nnone\n## 5. Conflicts\nNone\n');
  writeFileSync(join(root, 'memory/journal.ndjson'), '');
  writeFileSync(join(root, 'memory/lessons.ndjson'), '');
  writeFileSync(join(root, 'memory/processes.ndjson'), '');
  writeFileSync(join(root, 'playbook.yaml'),
    'name: timeout-test\nversion: 0.7.1\nentry: SKILL.md\n' +
    'north_star: Make "done" mean a verified exit code, not a claim.\n' +
    'paths:\n  scripts: scripts\n  memory: memory\n  modes: modes\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
    'index:\n  cli: scripts/pb.mjs\n  skills_index: skills/index.yaml\n  processes_index: processes/index.yaml\n  memory:\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
    'loop:\n  description: test\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
    'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
    'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
  writeFileSync(join(root, 'memory/backlog.yaml'), tasks);
  return { root, pb: (args, opts) => runPb(root, args, opts), journal: () => readJournal(root) };
}
const task = (id, extra = '') =>
  `  - {id: ${id}, title: ${id}, status: todo, skill: run-task, mode: coding, priority: 1${extra}}\n`;
const TASKS = 'tasks:\n' +
  task('t-fast', ', acceptance_checks: ["node slow.js 250"]') +
  task('t-over-field', ', check_timeout_ms: 400, acceptance_checks: ["node slow.js 1500"]') +
  task('t-over-env', ', acceptance_checks: ["node slow.js 1500"]') +
  task('t-field-beats-env', ', check_timeout_ms: 5000, acceptance_checks: ["node slow.js 900"]') +
  task('t-fails', ', acceptance_checks: ["node fail.js"]') +
  task('t-bad-field', ', check_timeout_ms: soon, acceptance_checks: ["node slow.js 250"]');
const LIMIT_RE = /limit (\d+)ms per check from ([^)\n]+)/;

// ============================================================================
//  A + B. a passing check, and the default the docs promise
// ============================================================================
const fx = makeFixture({ tasks: TASKS });
let documented = null;
{
  const fast = fx.pb(['validate', '--task', 't-fast']);
  ok('a check well under the limit passes', fast.code === 0 && /PASS\s+node slow\.js 250/.test(fast.combined),
    `exit=${fast.code}\n${fast.combined.slice(0, 400)}`);
  const m = LIMIT_RE.exec(fast.combined);
  ok('the run prints the resolved limit and where it came from', !!m, fast.combined.slice(0, 300));
  const defaultMs = m ? Number(m[1]) : NaN;
  const source = m ? m[2].trim() : '';

  // The documented default, from the two places a human reads it.
  const skill = readFileSync(resolve('SKILL.md'), 'utf8');
  const skillMatch = /The default is (\d+) ms/.exec(skill);
  const help = fx.pb(['help']).out;
  const helpMatch = /check timeout:\s*(\d+)\s*ms default/.exec(help);
  documented = skillMatch ? Number(skillMatch[1]) : null;
  ok('SKILL.md documents the default in the canonical sentence',
    documented !== null, 'no "The default is <N> ms" in SKILL.md');
  ok('`pb help` documents the default in the canonical sentence',
    helpMatch !== null, 'no "check timeout: <N> ms default" in pb help');
  ok('the EXECUTED default is the number the docs state',
    documented !== null && Number.isFinite(defaultMs) && defaultMs === documented &&
    Number(helpMatch?.[1]) === documented && /default/.test(source),
    `executed=${defaultMs} (${source}) SKILL.md=${documented} help=${helpMatch?.[1]}`);
  ok('the default is BOUNDED — big enough that a slow suite is not killed, small enough that a hang surfaces',
    Number.isFinite(defaultMs) && defaultMs >= 300_000 && defaultMs <= 1_800_000,
    `default=${defaultMs}ms (want >= 300000 and <= 1800000)`);
}

// ============================================================================
//  C + D. a timeout is a TIMEOUT, and the env var sets the limit
// ============================================================================
{
  const over = fx.pb(['validate', '--task', 't-over-field']);
  ok('a check that sleeps past the limit is reported as TIMEOUT, not FAIL',
    over.code === 1 && /TIMEOUT\s+node slow\.js 1500/.test(over.combined) &&
    !/FAIL\s+node slow\.js 1500/.test(over.combined), over.combined.slice(0, 600));
  ok('the TIMEOUT line says "timed out after Nms (limit Mms ...)" and names how to raise it',
    /timed out after \d+ms \(limit 400ms/.test(over.combined) &&
    /check_timeout_ms/.test(over.combined) && /PB_CHECK_TIMEOUT_MS/.test(over.combined),
    over.combined.slice(0, 700));
  ok('the source of the limit is named (the task field)',
    /from task check_timeout_ms/.test(over.combined), over.combined.slice(0, 500));

  // Failures keep their own ink.
  const fails = fx.pb(['validate', '--task', 't-fails']);
  ok('a genuinely failing check is still a FAIL, with no TIMEOUT anywhere in the output',
    fails.code === 1 && /FAIL\s+node fail\.js/.test(fails.combined) && !/TIMEOUT/.test(fails.combined),
    fails.combined.slice(0, 500));

  // Env honoured: small → timeout; large → pass. Same task, same command.
  const envTight = fx.pb(['validate', '--task', 't-over-env'], { env: { PB_CHECK_TIMEOUT_MS: '400' } });
  ok('PB_CHECK_TIMEOUT_MS is honoured: a 400ms limit times out a 1500ms check',
    envTight.code === 1 && /TIMEOUT\s+node slow\.js 1500/.test(envTight.combined) &&
    /limit 400ms/.test(envTight.combined) && /from env PB_CHECK_TIMEOUT_MS/.test(envTight.combined),
    envTight.combined.slice(0, 600));
  const envLoose = fx.pb(['validate', '--task', 't-over-env'], { env: { PB_CHECK_TIMEOUT_MS: '5000' } });
  ok('the same env var, raised, lets the same check PASS (the value is used, not just read)',
    envLoose.code === 0 && /PASS\s+node slow\.js 1500/.test(envLoose.combined) &&
    /limit 5000ms/.test(envLoose.combined), envLoose.combined.slice(0, 500));
}

// ============================================================================
//  E. the task field is the most specific source and beats the env var
// ============================================================================
{
  const wins = fx.pb(['validate', '--task', 't-field-beats-env'], { env: { PB_CHECK_TIMEOUT_MS: '200' } });
  ok('a task field of 5000ms beats an env limit of 200ms (900ms check passes)',
    wins.code === 0 && /PASS\s+node slow\.js 900/.test(wins.combined) && /from task check_timeout_ms/.test(wins.combined),
    wins.combined.slice(0, 500));
}

// ============================================================================
//  G. record: a TIMEOUT refusal, no row written; an auto row carries the detail
// ============================================================================
{
  const before = fx.journal().length;
  const rec = fx.pb(['record', '--task', 't-over-field', '--action', 'execute', '--status', 'done', '--notes', 'x']);
  ok('`record --status done` refuses a timed-out check',
    rec.code === 1, `exit=${rec.code}\n${rec.combined.slice(0, 500)}`);
  ok('the refusal says TIMED OUT — never "acceptance checks failed"',
    /TIMED OUT/.test(rec.combined) && !/acceptance checks failed/.test(rec.combined),
    rec.combined.slice(0, 700));
  ok('the refusal repeats the limit, its source, and both ways to raise it',
    /limit 400ms/.test(rec.combined) && /check_timeout_ms/.test(rec.combined) && /PB_CHECK_TIMEOUT_MS/.test(rec.combined),
    rec.combined.slice(0, 700));
  ok('a refused record wrote no journal row (the refusal is not a record)',
    fx.journal().length === before, `${before} → ${fx.journal().length}`);

  const recFail = fx.pb(['record', '--task', 't-fails', '--action', 'execute', '--status', 'done', '--notes', 'x']);
  ok('a red check still gets the plain failed-checks refusal',
    recFail.code === 1 && /acceptance checks failed/.test(recFail.combined) && !/TIMED OUT/.test(recFail.combined),
    recFail.combined.slice(0, 500));
}

// A path where a row IS written: the autonomous runner blocks the task. The row must
// carry the distinction, because "killed by a timer" is not "the work was wrong".
{
  const auto = makeFixture({ tasks: 'tasks:\n' + task('auto-timeout', ', check_timeout_ms: 400, acceptance_checks: ["node slow.js 1500"]') });
  const run = auto.pb(['loop', 'run', '--auto', '--max-tasks', '1', '--retry', '0']);
  ok('the autonomous runner reports the timeout distinctly on the console',
    /TIMEOUT/.test(run.combined) && /timed out after \d+ms \(limit 400ms/.test(run.combined), run.combined.slice(0, 700));
  const rows = auto.journal();
  const row = rows.filter((r) => r.task === 'auto-timeout' && r.action === 'auto-execute').pop();
  ok('the journal row says the check TIMED OUT, not that it failed',
    row && row.status === 'blocked' && row.checks === 'timed-out', JSON.stringify(row));
  ok('the row carries the limit, the elapsed time and the command (answerable after the fact)',
    !!row?.check_timeouts?.[0] && row.check_timeouts[0].limit_ms === 400 &&
    typeof row.check_timeouts[0].elapsed_ms === 'number' && /slow\.js 1500/.test(row.check_timeouts[0].cmd),
    JSON.stringify(row?.check_timeouts));
}

// ============================================================================
//  H. a nonsense field value warns and falls back instead of disabling the limit
// ============================================================================
{
  const bad = fx.pb(['validate', '--task', 't-bad-field']);
  ok('a non-numeric check_timeout_ms warns and falls back to the next source',
    bad.code === 0 && /check_timeout_ms/.test(bad.combined) && /not a positive number/.test(bad.combined) &&
    /from default/.test(bad.combined),
    bad.combined.slice(0, 500));
}

console.log(`\ntest-check-timeout: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
