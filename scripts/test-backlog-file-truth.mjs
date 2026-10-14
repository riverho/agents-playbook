// ============================================================================
//  scripts/test-backlog-file-truth.mjs
// ----------------------------------------------------------------------------
// `memory/backlog.yaml` reports completion WRONGLY, and `pb validate` says green.
//
// Measured on this repository: 85 of 85 tasks in the file disagreed with the journal's
// projection. Every one of them read `status: todo` while the projection said `done`,
// `blocked` or `dropped`. The reason is structural rather than a bug in one write path:
// `writeBacklog` deliberately does NOT rewrite the file (it says so in its own comment —
// status is written into the sidecar so hand-edited YAML formatting and comments survive).
// So a task's `status:` in the file is whatever it was CREATED as. It is a fossil.
//
// The journal is the record; `backlog-state.json` is a projection of it; the YAML file is a
// DEFINITION file (id, title, skill, checks) that also happens to carry a `status:` key that
// nothing maintains. That is a trap, not a design: a person opening the file — the most
// natural thing to do in a repo named "backlog" — reads a task list that is 100% wrong,
// while every gate stays green because the gates read the projection.
//
// This is the same defect class as the endless loop: the truth exists in one place and is
// invisible, or actively contradicted, in the place a human looks.
//
// WHAT MUST BE TRUE:
//   1. `pb validate` (or `pb status`) REPORTS the disagreement instead of staying silent.
//   2. The report names the count and at least one example, so it is actionable.
//   3. It does NOT fail `pb validate`: the projection is authoritative and correct, so a
//      fossil file is a documentation hazard, not a broken playbook. Gating on it would
//      make every existing playbook red for a cosmetic reason.
//   4. A file that AGREES produces no warning (no permanent noise).
//   5. The file itself warns the reader at the top, so the trap is visible before the data.
// ============================================================================

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).replace(/\n/g, '\n       ').slice(0, 700)}` : ''}`); }
}

const pb = (cwd, args) => {
  const r = spawnSync(process.execPath, [join(cwd, 'scripts', 'pb.mjs'), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, PB_AGENT_ID: 'fixture' },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

// ---------------------------------------------------------------------------
// A fixture with a task whose FILE says todo but whose journal says done.
// ---------------------------------------------------------------------------
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pb-filetruth-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'memory'), { recursive: true });
  for (const f of ['scripts/pb.mjs', 'AGENTS.md', 'SKILL.md', 'README.md', 'INSTALL.md', 'package.json']) {
    const src = join(ROOT, f);
    if (existsSync(src)) cpSync(src, join(dir, f), { recursive: true });
  }
  const dep = join(ROOT, 'node_modules', 'js-yaml');
  if (existsSync(dep)) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    cpSync(dep, join(dir, 'node_modules', 'js-yaml'), { recursive: true });
  }
  writeFileSync(join(dir, 'playbook.yaml'), readFileSync(join(ROOT, 'playbook.yaml'), 'utf8')
    .replace(/^[ \t]*stop_when:.*\r?\n?/gm, '').replace(/^[ \t]*stop_action:.*\r?\n?/gm, ''), 'utf8');
  writeFileSync(join(dir, 'memory', 'backlog.yaml'), [
    'tasks:',
    '  - id: T1',
    "    title: 'a task that will be finished'",
    '    status: todo',
    '    skill: run-task',
    '    priority: 1',
    '    acceptance_checks: ["node -e \\"process.exit(0)\\""]',
    '',
  ].join('\n'), 'utf8');
  writeFileSync(join(dir, 'memory', 'journal.ndjson'), '', 'utf8');
  writeFileSync(join(dir, 'memory', 'cycle.md'),
    '---\nphase: 1\nstarted: "2026-01-01T00:00:00.000Z"\n---\n# brief\nAnswered — no conflict with my memory.\n', 'utf8');
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'init'], { cwd: dir, encoding: 'utf8' });
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'bootstrap'], { cwd: dir, encoding: 'utf8' });
  execFileSync(process.execPath, [join(dir, 'scripts', 'pb.mjs'), 'loop', 'new', '--goal', 'fixture', '--stop', 'done'],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, PB_AGENT_ID: 'fixture' } });
  const cp = join(dir, 'memory', 'cycle.md');
  writeFileSync(cp, readFileSync(cp, 'utf8')
    .replace(/\(Your host memory is the PAST[\s\S]*?memory\.\)/, 'NONE — scratch fixture for a test.'), 'utf8');
  return dir;
}

// ---------------------------------------------------------------------------
// 1 & 2. The disagreement IS reported, with a count and an example.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    // Finish T1 through the engine: the journal now says done, the file still says todo.
    pb(dir, ['next', '--claim']);
    const done = pb(dir, ['record', '--task', 'T1', '--action', 'execute', '--status', 'done', '--notes', 'finished']);
    ok('the fixture finishes T1 through the engine', done.code === 0, done.out.slice(0, 300));
    ok('the FILE still says todo (the fossil is reproduced)',
      /status:\s*todo/.test(readFileSync(join(dir, 'memory', 'backlog.yaml'), 'utf8')));

    const st = pb(dir, ['status']);
    ok('`pb status` reports the file/journal disagreement',
      /backlog\.yaml|file/i.test(st.out) && /disagree|stale|fossil/i.test(st.out), st.out.slice(0, 900));
    // Anchor the id to the WARNING, not to the page: the status output already mentions T1
    // elsewhere (it is the only task), so a bare /T1/ would pass even with no warning at all.
    ok('…and the warning itself names the task',
      /(disagree|stale|fossil)[^\n]*T1|T1[^\n]*(disagree|stale|fossil)/i.test(st.out), st.out.slice(0, 900));

    // `pb status --json` carries it too, so the harness can surface it.
    // NOTE: the helper returns `.out` (stdout+stderr combined), not `.stdout` — reading the
    // wrong property silently yielded "" and made three assertions fail for no engine reason.
    const js = pb(dir, ['status', '--json']);
    let payload = null;
    try { payload = JSON.parse(js.out.slice(js.out.indexOf('{'))); } catch { /* asserted */ }
    // Assert the STRUCTURED field, not a substring of the whole payload: the payload already
    // contains task ids and statuses elsewhere, so a loose match would pass on those.
    ok('status --json carries the disagreement as a structured field',
      payload?.backlog_file?.disagrees >= 1, JSON.stringify(payload?.backlog_file)?.slice(0, 400));
    ok('…with the disagreeing task named in examples',
      Array.isArray(payload?.backlog_file?.examples) && payload.backlog_file.examples.some((e) => /T1/.test(e)),
      JSON.stringify(payload?.backlog_file)?.slice(0, 400));
    ok('…and a human-readable warning string',
      typeof payload?.backlog_file?.warning === 'string' && /fossil|disagree/i.test(payload.backlog_file.warning),
      JSON.stringify(payload?.backlog_file?.warning)?.slice(0, 300));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 3. It does NOT fail `pb validate` — the projection is authoritative and correct, so a
//    fossil file is a documentation hazard, not a broken playbook. Gating it would turn
//    every existing playbook red for a cosmetic reason.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    pb(dir, ['next', '--claim']);
    pb(dir, ['record', '--task', 'T1', '--action', 'execute', '--status', 'done', '--notes', 'finished']);
    const v = pb(dir, ['validate']);
    ok('pb validate stays GREEN over a fossil file (authoritative state is the projection)',
      v.code === 0, `exit ${v.code}\n${v.out.slice(0, 500)}`);
    ok('…but validate still mentions it, so the hazard is not hidden',
      /backlog\.yaml|fossil|stale|disagree/i.test(v.out), v.out.slice(0, 900));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 4. A file that AGREES produces no warning — no permanent noise.
// ---------------------------------------------------------------------------
{
  const dir = makeFixture();
  try {
    // A brand-new task nobody has touched: file and projection agree on `todo`.
    const st = pb(dir, ['status']);
    ok('an untouched file produces no disagreement warning',
      !/disagree|fossil/i.test(st.out), st.out.slice(0, 700));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// 5. The real repository: its own backlog file must now carry the warning header, so the
//    trap is visible to a human BEFORE the misleading data.
// ---------------------------------------------------------------------------
{
  const text = readFileSync(join(ROOT, 'memory', 'backlog.yaml'), 'utf8');
  ok('this repository\'s backlog.yaml warns the reader that status is not source of truth',
    /status.*(not|NEVER).*truth|fossil|projection/i.test(text), text.split('\n').slice(0, 12).join('\n'));
}

console.log(`\ntest-backlog-file-truth: ${pass} pass, ${fail} fail`);
if (fail) process.exit(1);
