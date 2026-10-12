#!/usr/bin/env node
// ============================================================================
//  test-room-write-primitives.mjs — the two write primitives the room was missing.
// ----------------------------------------------------------------------------
//  The room could not steer a GOAL and could not ATTACH a document, and it said so rather than
//  pretending: /api/steer hardcoded `goal_applied: false` ("the engine has no primitive to edit an
//  open cycle brief") and /api/attach answered 501 ("no pb command writes a task's docs: field").
//  Both statements were true, and both were gaps in the ENGINE, not the room.
//
//  This gate proves the primitives exist and that the room now uses them:
//    1. `pb cycle --edit` rewrites the OPEN brief in BOTH places the answer lives — the YAML front
//       matter that every command reads and the numbered question a human reads — journals the
//       change, refuses an empty edit, and is a no-op when the text already says that.
//    2. `pb attach` writes a card's `docs:`, refuses an absolute path and a path that is not there,
//       and the entry it writes PASSES `pb validate` (which is the reader that already existed).
//    3. The routes: /api/steer's goal half really edits the brief, /api/attach really writes docs,
//       and a refusal from the engine is passed through as 422 rather than softened into a 200.
// ============================================================================

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir } from './lib/test-temp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'apps', 'flow-room', 'server.mjs');
const CSRF = { 'x-pb-ui': '1', 'content-type': 'application/json' };

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pb(cwd, args) {
  try {
    const stdout = execFileSync(process.execPath, [join(cwd, 'scripts', 'pb.mjs'), ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

const work = tempDir('pb-room-writes-');
const pbRoot = join(work, 'scratch-playbook');
let server = null;
let base = '';

// The room reads documents through the graph, so the gate asserts on the same projection: a
// document recorded on the wrong task is a wrong CARD, whichever task the CLI meant.
const graphNodes = () => {
  const g = pb(pbRoot, ['graph', '--json']);
  try { return JSON.parse(g.stdout).nodes ?? []; } catch { return []; }
};
// Replace a task's whole `docs:` entry (block or flow) with the given single line, for fixtures.
const setDocsEntry = (taskId, line) => {
  const lines = readFileSync(join(pbRoot, 'memory', 'backlog.yaml'), 'utf8').split('\n');
  const idIdx = lines.findIndex((l) => /-\s*id:\s*\S+/.test(l) && l.includes(taskId));
  const dashIndent = (lines[idIdx]?.match(/^(\s*)-/) ?? ['', ''])[1];
  let end = lines.length;
  for (let i = idIdx + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s*)-\s/);
    if (m && m[1].length <= dashIndent.length) { end = i; break; }
  }
  const keyIndent = `${dashIndent}  `;
  const docsIdx = lines.findIndex((l, i) => i > idIdx && i < end && /^\s*docs\s*:/.test(l));
  if (docsIdx === -1) {
    lines.splice(end, 0, `${keyIndent}${line}`);
  } else {
    let last = docsIdx + 1;
    while (last < end && /^\s*(-|\S)/.test(lines[last]) && !/^\s*[a-z_]+:/.test(lines[last])) last += 1;
    lines.splice(docsIdx, last - docsIdx, `${keyIndent}${line}`);
  }
  writeFileSync(join(pbRoot, 'memory', 'backlog.yaml'), lines.join('\n'), 'utf8');
};

try {
  // ── a scratch playbook with one real task ────────────────────────────────
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'pb.mjs'), 'scaffold', '--target', pbRoot], {
    cwd: work, encoding: 'utf8',
  });
  mkdirSync(join(pbRoot, 'node_modules'), { recursive: true });
  for (const dep of ['js-yaml', 'argparse']) {
    const from = join(ROOT, 'node_modules', dep);
    if (existsSync(from)) cpSync(from, join(pbRoot, 'node_modules', dep), { recursive: true });
  }
  const step = (args, label) => {
    const r = pb(pbRoot, args);
    check(r.code === 0, `scratch setup: \`pb ${args.join(' ')}\` (${label}) exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    return r;
  };
  step(['loop', 'new'], 'open the loop');
  step(['cycle', '--new', '--goal', 'scratch goal', '--stop', 'the original stop'], 'cycle brief');

  // `pb plan` refuses until Q5 is answered, and no flag answers it — the same friction
  // scripts/test-app-live-api.mjs pins. Edited directly here because this gate is about the
  // primitives it does have.
  const cycleFile = join(pbRoot, 'memory', 'cycle.md');
  writeFileSync(cycleFile, readFileSync(cycleFile, 'utf8').replace(
    /\(Your host memory is the PAST[\s\S]*?memory\.\)/,
    'None for this fixture: the playbook folder is the truth.'
  ), 'utf8');
  const planned = step(['plan', '--goal', 'a card to steer and attach to', '--check', 'node -v'], 'seed a task');
  const taskId = /Planned \[([^\]]+)\]/.exec(planned.stdout)?.[1] ?? null;
  check(Boolean(taskId), 'scratch setup: could not read the planned task id');
  if (!taskId) throw new Error('no task id — cannot continue');

  const backlogFile = join(pbRoot, 'memory', 'backlog.yaml');
  const journalFile = join(pbRoot, 'memory', 'journal.ndjson');
  const journalRows = () => readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // ── 1. pb cycle --edit ───────────────────────────────────────────────────
  const edited = pb(pbRoot, ['cycle', '--edit', '--stop', 'the revised stop']);
  check(edited.code === 0, `pb cycle --edit --stop exited ${edited.code}: ${(edited.stderr || edited.stdout).trim()}`);
  const brief = readFileSync(cycleFile, 'utf8');
  const frontMatter = brief.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  check(/^stop: "the revised stop"$/m.test(frontMatter),
    'pb cycle --edit did not rewrite the front-matter stop — the half every command reads');
  const section4 = brief.split(/^##\s*4\./m)[1]?.split(/^##\s/m)[0] ?? '';
  check(/the revised stop/.test(section4),
    'pb cycle --edit did not rewrite question 4 — the half a human reads, so the brief would contradict itself');
  check(!/the original stop/.test(frontMatter), 'the old stop is still in the front matter');
  const view = pb(pbRoot, ['cycle']);
  check(/the revised stop/.test(view.stdout), 'pb cycle no longer prints the edited stop — the brief was written but not parseable');
  const editRow = journalRows().filter((r) => r.action === 'cycle-edit');
  check(editRow.length === 1, `expected exactly one cycle-edit journal row, found ${editRow.length}`);
  check(JSON.stringify(editRow[0]?.before ?? {}).includes('the original stop'),
    'the cycle-edit journal row did not record what the brief said BEFORE the edit');
  const noFlags = pb(pbRoot, ['cycle', '--edit']);
  check(noFlags.code === 2, `pb cycle --edit with nothing to change exited ${noFlags.code}, expected 2 (a refused usage, not a crash)`);
  const before = readFileSync(cycleFile, 'utf8');
  const again = pb(pbRoot, ['cycle', '--edit', '--stop', 'the revised stop']);
  check(again.code === 0 && /No change/.test(again.stdout), 're-applying the same stop did not report "No change"');
  check(readFileSync(cycleFile, 'utf8') === before, 'a no-op --edit rewrote the brief anyway');

  // ── 2. pb attach ─────────────────────────────────────────────────────────
  mkdirSync(join(pbRoot, 'docs'), { recursive: true });
  writeFileSync(join(pbRoot, 'docs', 'evidence.md'), '# Evidence\n', 'utf8');
  writeFileSync(join(pbRoot, 'docs', 'evidence-2.md'), '# More evidence\n', 'utf8');

  const attach = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs/evidence.md']);
  check(attach.code === 0, `pb attach exited ${attach.code}: ${(attach.stderr || attach.stdout).trim()}`);
  // Asserted through the PROJECTION the room actually reads, not a regex over the YAML text: the
  // items are quoted now (that is the fix for hostile filenames), and a textual assertion would
  // pin the spelling rather than the fact.
  check((graphNodes().find((n) => n.id === taskId)?.docs ?? []).map(String).includes('docs/evidence.md'),
    'pb attach did not record the document on the card the room renders');
  check(journalRows().filter((r) => r.action === 'attach').length === 1, 'pb attach wrote no journal row (the association would be unattributable)');
  const validAfterAttach = pb(pbRoot, ['validate']);
  check(validAfterAttach.code === 0,
    `pb validate fails on the entry pb attach just wrote — the writer and the checker disagree:\n      ${(validAfterAttach.stderr || validAfterAttach.stdout).trim().split('\n').slice(0, 3).join('\n      ')}`);

  const dup = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs/evidence.md']);
  check(dup.code === 0 && /already lists/.test(dup.stdout), 'attaching the same document twice was not a stated no-op');
  check(journalRows().filter((r) => r.action === 'attach').length === 1, 'the duplicate attach wrote a second journal row');

  const absolute = pb(pbRoot, ['attach', '--task', taskId, '--path', join(pbRoot, 'docs', 'evidence-2.md')]);
  check(absolute.code !== 0, 'pb attach ACCEPTED an absolute path, which pb validate rejects as not root-relative');
  check(/absolute/i.test(absolute.stderr + absolute.stdout), 'the absolute-path refusal did not say why');
  const missing = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs/never-written.md']);
  check(missing.code !== 0, 'pb attach ACCEPTED a path that does not exist — that is a claim, not a document');
  check(journalRows().filter((r) => r.action === 'attach').length === 1, 'a refused attach wrote a journal row anyway');
  check(!/never-written/.test(readFileSync(backlogFile, 'utf8')), 'a refused attach still recorded the path');

  // TEETH: the reader that already existed must actually bite when the document disappears.
  const docPath = join(pbRoot, 'docs', 'evidence.md');
  const docBytes = readFileSync(docPath);
  rmSync(docPath, { force: true });
  const validGone = pb(pbRoot, ['validate']);
  check(validGone.code !== 0, 'pb validate passed with a docs: path that no longer exists — the association is unverified');
  check(/evidence\.md/.test(validGone.stderr + validGone.stdout), 'validate failed but did not name the missing document');
  writeFileSync(docPath, docBytes);

  // ── 2b. a JSON backlog ───────────────────────────────────────────────────
  // The master may point `backlog:` at a .json file and writeBacklog supports it, so the writer
  // must not assume YAML: a textual insertion into a JSON document would corrupt it.
  {
    const master = join(pbRoot, 'playbook.yaml');
    const masterBefore = readFileSync(master, 'utf8');
    const flipped = masterBefore.replace(/backlog:\s*memory\/backlog\.yaml/, 'backlog: memory/backlog.json');
    check(flipped !== masterBefore, 'the scratch master does not name a backlog file to flip — the JSON case cannot be tested');
    writeFileSync(master, flipped, 'utf8');
    const jsonBacklog = {
      tasks: [{ id: taskId, title: 'a card to steer and attach to', status: 'todo', skill: 'run-task', mode: 'coding', priority: 1, acceptance_checks: ['node -v'] }],
    };
    writeFileSync(join(pbRoot, 'memory', 'backlog.json'), `${JSON.stringify(jsonBacklog, null, 2)}\n`, 'utf8');

    const jsonAttach = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs/evidence-2.md']);
    check(jsonAttach.code === 0, `pb attach against a JSON backlog exited ${jsonAttach.code}: ${(jsonAttach.stderr || jsonAttach.stdout).trim().split('\n')[0]}`);
    let jsonAfter = null;
    try { jsonAfter = JSON.parse(readFileSync(join(pbRoot, 'memory', 'backlog.json'), 'utf8')); } catch { jsonAfter = null; }
    check(jsonAfter !== null, 'pb attach CORRUPTED a JSON backlog — the file no longer parses');
    check(jsonAfter?.tasks?.[0]?.docs?.includes('docs/evidence-2.md') === true,
      'pb attach did not record the document in the JSON backlog');
    const jsonValidate = pb(pbRoot, ['validate']);
    check(jsonValidate.code === 0, `pb validate fails on a JSON backlog pb attach wrote:\n      ${(jsonValidate.stderr || jsonValidate.stdout).trim().split('\n').slice(0, 2).join('\n      ')}`);

    writeFileSync(master, masterBefore, 'utf8');
    rmSync(join(pbRoot, 'memory', 'backlog.json'), { force: true });
  }

  // ── 2c. the RIGHT task, not merely SOME task ─────────────────────────────
  // The scratch had ONE task, so a mutation that disabled the block-end detection put the document
  // on a different task and the gate still passed. Three tasks, attached at each position.
  {
    const extra = [];
    for (const goal of ['second card', 'third card']) {
      const r = step(['plan', '--goal', goal, '--check', 'node -v'], goal);
      const id = /Planned \[([^\]]+)\]/.exec(r.stdout)?.[1] ?? null;
      check(Boolean(id), `could not read the id of the ${goal}`);
      if (id) extra.push(id);
    }
    const allTasks = [taskId, ...extra];
    check(allTasks.length === 3, `expected 3 tasks in the scratch, have ${allTasks.length}`);
    for (const [index, id] of allTasks.entries()) {
      const file = `docs/pos-${index}.md`;
      writeFileSync(join(pbRoot, file), `# ${file}\n`, 'utf8');
      const r = pb(pbRoot, ['attach', '--task', id, '--path', file]);
      check(r.code === 0, `attach to task ${index + 1} of 3 exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
      const nodes = graphNodes();
      const mine = nodes.find((n) => n.id === id)?.docs ?? [];
      const elsewhere = nodes.filter((n) => n.id !== id).flatMap((n) => n.docs ?? []);
      check(mine.includes(file), `attach to task ${index + 1} of 3 did not record the document on THAT task (docs: ${JSON.stringify(mine)})`);
      check(!elsewhere.includes(file), `attach to task ${index + 1} of 3 recorded the document on a DIFFERENT task — the wrong card would show it`);
    }
  }

  // ── 2d. filenames that are legal but hostile to a naive YAML writer ──────
  // `[WIP].md`, `#notes.md`, `- dash.md`, `%pct.md`, `@at.md` and a name containing " #" all exist
  // on disk and all corrupted the backlog when written as bare list items — after which `pb
  // validate`, `pb graph` and `pb status` crashed on every read. They must attach cleanly.
  {
    const hostile = ['[WIP].md', '#notes.md', '- dash.md', '%pct.md', '@at.md', 'docs/a #b.md'];
    for (const name of hostile) {
      const full = join(pbRoot, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, '# hostile name\n', 'utf8');
      const wanted = name.replace(/\\/g, '/');
      const r = pb(pbRoot, ['attach', '--task', taskId, '--path', wanted]);
      check(r.code === 0, `attach refused the legal filename ${JSON.stringify(wanted)} (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
      const v = pb(pbRoot, ['validate']);
      check(v.code === 0, `attaching ${JSON.stringify(wanted)} left the backlog unparseable — pb validate exited ${v.code}`);
      const docs = (graphNodes().find((n) => n.id === taskId)?.docs ?? []).map(String);
      check(docs.includes(wanted), `the recorded path for ${JSON.stringify(wanted)} is not exactly what was given (docs: ${JSON.stringify(docs.slice(-3))})`);
    }
  }

  // ── 2e. a hand-written FLOW list must not gain a second `docs:` key ──────
  {
    setDocsEntry(taskId, 'docs: ["docs/pos-0.md"]');
    check(pb(pbRoot, ['validate']).code === 0, 'the flow-style fixture itself does not validate — the case cannot be tested');

    writeFileSync(join(pbRoot, 'docs', 'flow-added.md'), '# added\n', 'utf8');
    const again = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs/flow-added.md']);
    check(again.code === 0, `attach onto a flow-style docs list exited ${again.code}: ${(again.stderr || again.stdout).trim().split('\n')[0]}`);
    check(pb(pbRoot, ['validate']).code === 0, 'attach onto a flow-style docs list produced a duplicated key — the backlog no longer parses');
    const docs = (graphNodes().find((n) => n.id === taskId)?.docs ?? []).map(String);
    check(docs.includes('docs/flow-added.md') && docs.includes('docs/pos-0.md'),
      `the flow list lost an entry or missed the new one: ${JSON.stringify(docs)}`);
  }

  // ── 2f. a non-list `docs:` is refused, not silently replaced ─────────────
  {
    setDocsEntry(taskId, 'docs: "docs/pos-0.md"');
    const before = readFileSync(backlogFile, 'utf8');
    const r = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs/evidence.md']);
    check(r.code !== 0, 'attach ACCEPTED a task whose docs: is a plain string — it must refuse rather than replace the value');
    check(/not a list/i.test(r.stderr + r.stdout), 'the refusal did not say the docs: value is not a list');
    check(readFileSync(backlogFile, 'utf8') === before, 'a refused attach rewrote the backlog anyway');
    setDocsEntry(taskId, 'docs: ["docs/pos-0.md"]');
  }

  // ── 2g. traversal and directories ────────────────────────────────────────
  {
    writeFileSync(join(work, 'outside-the-playbook.md'), '# outside\n', 'utf8');
    const escaped = pb(pbRoot, ['attach', '--task', taskId, '--path', '../outside-the-playbook.md']);
    check(escaped.code !== 0, 'attach ACCEPTED a path that resolves outside the playbook root — the room would be handed a document it cannot open');
    check(/outside the playbook root/i.test(escaped.stderr + escaped.stdout), 'the traversal refusal did not say the path leaves the playbook');
    const dir = pb(pbRoot, ['attach', '--task', taskId, '--path', 'docs']);
    check(dir.code !== 0, 'attach ACCEPTED a directory as a document');
    check(/not a document|directory/i.test(dir.stderr + dir.stdout), 'the directory refusal did not say why');
    const after = pb(pbRoot, ['validate']);
    check(after.code === 0, 'the refused attaches left the backlog invalid');
  }

  // ── 2h. pb cycle --edit: line endings, block scalars, structure ──────────
  {
    // A hand-written block scalar is ONE value over several lines; replacing only its first line
    // made the front matter unparseable while the command reported success.
    const blockScalar = readFileSync(cycleFile, 'utf8').replace(/^stop:.*$/m, 'stop: >-\n  the original stop\n  continued on a second line');
    writeFileSync(cycleFile, blockScalar, 'utf8');
    const r = pb(pbRoot, ['cycle', '--edit', '--stop', 'a replacement stop']);
    check(r.code === 0, `cycle --edit over a block scalar exited ${r.code}: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
    const view = pb(pbRoot, ['cycle']);
    check(/a replacement stop/.test(view.stdout), `after editing a block-scalar brief, pb cycle reads: ${view.stdout.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
    check(!/continued on a second line/.test(readFileSync(cycleFile, 'utf8')), 'the block scalar\'s continuation survived the edit — the front matter is inconsistent');

    // A value carrying a heading would inject a question: refuse it rather than restructure the brief.
    const beforeBrief = readFileSync(cycleFile, 'utf8');
    const injected = pb(pbRoot, ['cycle', '--edit', '--goal', 'a real goal\n\n## 4. Where do I stop / hand back?\nINJECTED']);
    check(injected.code !== 0, 'cycle --edit ACCEPTED a goal containing a markdown heading — it can inject a section into the brief');
    check(readFileSync(cycleFile, 'utf8') === beforeBrief, 'a refused cycle --edit changed the brief anyway');

    // CRLF: the file must not come back with mixed line endings.
    const crlf = readFileSync(cycleFile, 'utf8').replace(/\r?\n/g, '\r\n');
    writeFileSync(cycleFile, crlf, 'utf8');
    const cr = pb(pbRoot, ['cycle', '--edit', '--stop', 'a crlf stop']);
    check(cr.code === 0, `cycle --edit on a CRLF brief exited ${cr.code}`);
    const afterText = readFileSync(cycleFile, 'utf8');
    check((afterText.match(/\n/g) || []).length === (afterText.match(/\r\n/g) || []).length,
      'cycle --edit returned a brief with mixed line endings');
    check(pb(pbRoot, ['cycle']).code === 0 && /a crlf stop/.test(pb(pbRoot, ['cycle']).stdout),
      'the CRLF brief no longer reads back');
  }

  // ── 2i. every row this work writes is stamped ────────────────────────────
  {
    const mine = journalRows().filter((r) => r.action === 'attach' || r.action === 'cycle-edit');
    check(mine.length > 0, 'no attach/cycle-edit rows to inspect');
    const unstamped = mine.filter((r) => typeof r.ts !== 'string' || !r.ts);
    check(unstamped.length === 0,
      `${unstamped.length} of ${mine.length} new journal row(s) carry no ts — pb status prints "?", the report renders "undefined", and report --since drops them`);
  }

  // ── 3. the room's routes ─────────────────────────────────────────────────
  const port = 9800 + Math.floor(Math.random() * 150);
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [SERVER, '--root', pbRoot, '--port', String(port), '--no-open'], { stdio: 'ignore' });
  let health = null;
  for (let i = 0; i < 60 && !health; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) health = await res.json();
    } catch { /* not up yet */ }
    if (!health) await sleep(200);
  }
  check(Boolean(health), `the server never answered /api/health on ${base}`);
  if (health) {
    const sessionRes = await fetch(`${base}/api/session`);
    const cookie = (sessionRes.headers.getSetCookie?.() ?? [''])[0].split(';')[0];
    check(Boolean(cookie), 'no session cookie was issued, so the write routes cannot be exercised');

    // attach: the route that used to answer 501
    const attachRes = await fetch(`${base}/api/attach`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ task: taskId, path: 'docs/evidence-2.md' }),
    });
    const attachBody = await attachRes.json().catch(() => null);
    check(attachRes.status === 200, `/api/attach returned ${attachRes.status} (was 501) — body ${JSON.stringify(attachBody)}`);
    check(/evidence-2\.md/.test(readFileSync(backlogFile, 'utf8')), '/api/attach answered 200 but the backlog has no entry for the document');
    check(attachBody?.count === 2, `/api/attach reported count ${attachBody?.count}, expected 2 after the second document`);

    // a refusal must survive the route rather than being softened into a success
    const refusedRes = await fetch(`${base}/api/attach`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ task: taskId, path: join(pbRoot, 'docs', 'evidence.md') }),
    });
    const refusedBody = await refusedRes.json().catch(() => null);
    check(refusedRes.status === 422, `an absolute path through /api/attach returned ${refusedRes.status}, expected 422`);
    check(/absolute/i.test(String(refusedBody?.detail ?? '')), 'the 422 did not carry the engine\'s own reason');

    const badShape = await fetch(`${base}/api/attach`, {
      method: 'POST', headers: { ...CSRF, cookie }, body: JSON.stringify({ task: taskId }),
    });
    check(badShape.status === 400, `/api/attach with no path returned ${badShape.status}, expected 400`);

    // steer: the goal half that used to be hardcoded false
    const steerRes = await fetch(`${base}/api/steer`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ tasks: [taskId], text: 'steer the room toward the gate', goal: 'the stop the room set' }),
    });
    const steerBody = await steerRes.json().catch(() => null);
    check(steerRes.status === 200, `/api/steer returned ${steerRes.status}`);
    check(steerBody?.goal_applied === true,
      `goal_applied was ${JSON.stringify(steerBody?.goal_applied)} — the goal half is still not applied${steerBody?.goal_note ? `: ${steerBody.goal_note}` : ''}`);
    check(/the stop the room set/.test(readFileSync(cycleFile, 'utf8')),
      'goal_applied said true but the brief does not carry the new stop — the route reported a write it did not make');
    check(steerBody?.ok === true, 'the steer reported not-ok although both halves landed');

    const steerGuard = await fetch(`${base}/api/steer`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ tasks: [taskId], text: 'x', goal: '--force' }),
    });
    check(steerGuard.status === 400, `a goal starting with "-" returned ${steerGuard.status}, expected 400 (it would be read as a flag)`);

    // A whitespace goal is NOT a request. The room derived "a goal was asked for" from the MODE,
    // so this path told the user "the engine refused the edit" when nothing had been asked.
    const blank = await fetch(`${base}/api/steer`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ tasks: [taskId], text: 'a steer with no goal', goal: '   ' }),
    });
    const blankBody = await blank.json().catch(() => null);
    check(blank.status === 200, `/api/steer with a whitespace goal returned ${blank.status}`);
    check(blankBody?.goal_requested === false, `a whitespace goal reported goal_requested=${JSON.stringify(blankBody?.goal_requested)} — nothing was asked for`);
    check(blankBody?.goal_note === undefined, 'a whitespace goal produced a goal_note, which the room renders as a refusal that never happened');

    // The refusal path: a goal the engine will not accept must report goal_applied=false AND say
    // why. Hardcoding goal_applied is caught here, because this request must fail.
    const refusal = await fetch(`${base}/api/steer`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ tasks: [taskId], text: 'a steer', goal: 'a goal\nwith a second line' }),
    });
    const refusalBody = await refusal.json().catch(() => null);
    check(refusalBody?.goal_requested === true, 'a multi-line goal was not reported as requested');
    check(refusalBody?.goal_applied === false, 'a goal the engine refuses reported goal_applied=true');
    check(typeof refusalBody?.goal_note === 'string' && refusalBody.goal_note.length > 0,
      'a refused goal carried no goal_note — the user would be told nothing about why it did not land');

    // Length is an input error, not a server error: a 9000-character argv made execFile throw on
    // Windows and the handler turned it into 500 "spawn ENAMETOOLONG".
    const huge = await fetch(`${base}/api/steer`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ tasks: [taskId], text: 'x'.repeat(9000) }),
    });
    check(huge.status === 400, `/api/steer with a 9000-character text returned ${huge.status}, expected 400`);

    // The corruption the checker found through this route: a legal filename the YAML writer used
    // to write bare, leaving the backlog unparseable for every later read.
    const hostile = 'docs/[WIP].md';
    mkdirSync(join(pbRoot, 'docs'), { recursive: true });
    writeFileSync(join(pbRoot, 'docs', '[WIP].md'), '# hostile\n', 'utf8');
    const hostileRes = await fetch(`${base}/api/attach`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ task: taskId, path: hostile }),
    });
    check(hostileRes.status === 200, `/api/attach with the legal filename ${hostile} returned ${hostileRes.status} — it used to leave the backlog unparseable`);
    check(pb(pbRoot, ['validate']).code === 0, `attaching ${hostile} through the route left the backlog unparseable`);

    const longPath = await fetch(`${base}/api/attach`, {
      method: 'POST', headers: { ...CSRF, cookie },
      body: JSON.stringify({ task: taskId, path: `docs/${'x'.repeat(500)}.md` }),
    });
    check(longPath.status === 400, `/api/attach with a 500-character path returned ${longPath.status}, expected 400`);
  }
} catch (err) {
  problems.push(`harness error: ${String(err?.message ?? err).split('\n')[0]}`);
} finally {
  if (server) { try { server.kill(); } catch { /* already gone */ } }
  await sleep(200);
  let removed = false;
  for (let i = 0; i < 6 && !removed; i += 1) {
    try { rmSync(work, { recursive: true, force: true }); removed = !existsSync(work); } catch { await sleep(150); }
  }
  if (!removed) console.error(`note: left the scratch playbook on disk: ${work}`);
}

console.log('Room write primitives — steer-the-goal and attach');
console.log('  pb cycle --edit : the OPEN brief is edited in the front matter AND question 4, journalled, no-op when unchanged');
console.log('  pb attach       : writes docs:, refuses absolute and missing paths, and the entry passes pb validate');
console.log('  the routes      : /api/steer applies the goal, /api/attach writes the card, refusals stay refusals');

if (problems.length) {
  console.error(`\nROOM WRITE PRIMITIVES FAILED (${problems.length} problem(s)):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nBoth primitives exist, the room uses them, and the refusals are the engine\'s own.');
