#!/usr/bin/env node
// ============================================================================
//  check-room-versions.mjs — the state bar, History and versions, in a browser
//  (D23–D26; contract S1, S3–S8).
// ----------------------------------------------------------------------------
//  Two fixture playbooks, each drawn by the built room behind its own server:
//
//   · a plain one (no versions): S1's fallback — the bar shows the active loop as an
//     unnamed version, says "No orchestrator scheduled", and there is no History clock.
//   · a versioned one: v0.1 closed (its proof passed), v0.2 open with a carried card,
//     an orchestrator block and one tick. Checked:
//       S1  the bar names v0.2, its phase, the orchestrator and its last tick, and the age
//       S6  the graph draws v0.2's cards only; the carried card says "from v0.1"
//       S8  the orchestrator's defer is in the card's conversation, in its own voice
//       S4  an unchanged Refresh is ONE /api/state answered 304, and no graph read
//       S3  refresh sends no write; a journal change re-reads the graph and the card glows
//       S5  History lists v0.2 then v0.1 (newest first), with goals and stop checks
//       S7  picking v0.1 draws it read-only: no "+ Add a card", and the + offers only
//           "Fork into the open version" and "Comment"; the fork lands in v0.2 as an
//           experiment that follows the old card
//
//  Usage: node scripts/check-room-versions.mjs      (needs a build of apps/flow-room)
// ============================================================================
import { openRoom, sleep } from './lib-room-browser.mjs';
import { makeFixture, runPb, pbJson } from './test-fixture-playbook.mjs';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const problems = [];
let fixtureSeq = 0;
const roots = [];
const iso = (min) => new Date(Date.now() - min * 60_000).toISOString();

function plainFixture() {
  return makeFixture({ prefix: 'pbver-plain-', tasks: [{ id: 'p1', title: 'A plain task' }, { id: 'p2', title: 'Another plain task' }] });
}

function versionedFixture() {
  const root = makeFixture({
    prefix: 'pbver-',
    loops: 'active: null\nloops: []\n',
    tasks: [
      { id: 'old-1', title: 'Shipped in the first version', extra: ['version: v0.1', 'kind: feature'] },
      { id: 'old-2', title: 'Also shipped in the first version', extra: ['version: v0.1', 'kind: fix'] },
      { id: 'new-1', title: 'Carried over from the first version', extra: ['version: v0.2', 'kind: feature', 'carried_from: v0.1'] },
      { id: 'new-2', title: 'Fresh work in the second version', extra: ['version: v0.2', 'kind: feature'] },
      { id: 'new-3', title: 'Waiting on a person in the second version', manual: true, extra: ['version: v0.2', 'kind: feature'] },
    ],
  });
  // `version new` reseeds the cycle brief with its questions open; a person would answer them,
  // so the fixture keeps its answered brief (or planning is refused, rightly)
  const brief = readFileSync(join(root, 'memory/cycle.md'), 'utf8');
  const a = runPb(root, ['version', 'new', '--name', 'v0.1', '--title', 'First', '--goal', 'first version goal', '--stop-check', 'node -e process.exit(0)']);
  const b = runPb(root, ['version', 'new', '--name', 'v0.2', '--title', 'Second', '--goal', 'second version goal', '--stop-check', 'node scripts/pb.mjs validate', '--draft']);
  if (a.code !== 0 || b.code !== 0) throw new Error(`fixture versions: ${a.combined}${b.combined}`);
  writeFileSync(join(root, 'memory/cycle.md'), brief);
  // A person closes a version (V6 refuses agents), so the fixture writes what the lifecycle
  // would have left: v0.1 closed with its proof, v0.2 open. The journal's `version` rows are
  // the durable record (loops.yaml is their projection), so that is where it goes.
  const journalPath = join(root, 'memory/journal.ndjson');
  const existing = readFileSync(journalPath, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
  let seq = Math.max(0, ...existing.map((r) => Number(r.seq) || 0));
  const loops = yaml.load(readFileSync(join(root, 'memory/loops.yaml'), 'utf8'));
  const v1 = { ...loops.loops.find((l) => l.version === 'v0.1'), state: 'closed', status: 'closed', closed_at: iso(60 * 24), stop_result: { outcome: 'passed', at: iso(60 * 24) } };
  const v2 = { ...loops.loops.find((l) => l.version === 'v0.2'), state: 'open', status: 'active', started_at: iso(60 * 23) };
  const template = existing.filter((r) => r.action === 'version').pop() ?? {};
  appendFileSync(journalPath,
    JSON.stringify({ ...template, ts: iso(60 * 24), loop_id: v1.id, task: `version:${v1.id}`, notes: 'closed v0.1 (fixture)', version_record: v1, seq: ++seq }) + '\n'
    + JSON.stringify({ ...template, ts: iso(60 * 23), loop_id: v2.id, task: `version:${v2.id}`, notes: 'opened v0.2 (fixture)', version_record: v2, active_loop: v2.id, seq: ++seq }) + '\n');
  // each card in its version's loop (V4); old ones done
  const backlogPath = join(root, 'memory/backlog.yaml');
  let backlog = readFileSync(backlogPath, 'utf8');
  for (const [id, v] of [['old-1', v1], ['old-2', v1], ['new-1', v2], ['new-2', v2], ['new-3', v2]]) {
    backlog = backlog.replace(new RegExp(`(- id: "?${id}"?\\r?\\n)`), `$1    loop_id: ${v.id}\n`);
  }
  writeFileSync(backlogPath, backlog);
  const statePath = join(root, 'memory/backlog-state.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  const done1 = ++seq, done2 = ++seq;
  st['old-1'] = { status: 'done', seq: done1, updated_at: iso(60 * 30) };
  st['old-2'] = { status: 'done', seq: done2, updated_at: iso(60 * 30) };
  writeFileSync(statePath, JSON.stringify(st, null, 2));
  const row = (o) => JSON.stringify({ checks: 'none', ...o }) + '\n';
  appendFileSync(journalPath,
    row({ ts: iso(60 * 30), loop_id: v1.id, task: 'old-1', agent: 'lead', agent_id: 'lead', action: 'execute', status: 'done', checks: 'passed', notes: 'done', seq: done1 })
    + row({ ts: iso(60 * 30), loop_id: v1.id, task: 'old-2', agent: 'lead', agent_id: 'lead', action: 'execute', status: 'done', checks: 'passed', notes: 'done', seq: done2 })
    + row({ ts: iso(4), loop_id: v2.id, task: 'new-2', agent: 'orchestrator', agent_id: 'orchestrator', action: 'defer', status: 'todo', notes: 'Deferred: waiting on your decision. The orchestrator took new-1 instead.', chose: 'new-1', reason: 'waiting on your decision', seq: ++seq })
    + row({ ts: iso(4), loop_id: v2.id, task: `version:${v2.id}`, agent: 'orchestrator', agent_id: 'orchestrator', action: 'tick', status: 'event', notes: 'tick: proposed new-1', tick: { stop_reason: null, chosen: 'new-1' }, seq: ++seq }));
  fixtureSeq = seq;
  // the master schedules an orchestrator (propose-only)
  appendFileSync(join(root, 'playbook.yaml'), 'orchestrator:\n  every_minutes: 15\n  max_workers: 0\n');
  return root;
}

const snap = (evaluate) => evaluate(`(() => {
  const bar = document.querySelector('.flow-statebar');
  return {
    bar: bar ? bar.innerText.replace(/\\s+/g, ' ').trim() : null,
    past: bar?.dataset.past,
    hist: !!document.querySelector('.flow-statebar__hist'),
    cards: [...document.querySelectorAll('.flow-face[data-live]')].map((c) => c.dataset.id).sort(),
    from: [...document.querySelectorAll('.flow-face__from')].map((e) => e.closest('.flow-face')?.dataset.id + ':' + e.textContent.trim()),
    bandPlus: document.querySelectorAll('.flow-bandplus').length,
  };
})()`);
const NET = `(() => { window.__net = []; if (window.__netWrapped) return; window.__netWrapped = true; const f = window.fetch;
  window.fetch = async (u, o) => { const graphFail = window.__failGraph && String(u).includes('/api/graph'); if (graphFail) window.__failGraph = false;
    const r = graphFail ? new Response(JSON.stringify({ error: 'injected by the gate' }), { status: 500, headers: { 'content-type': 'application/json' } }) : await f(u, o); window.__net.push({ url: String(u).replace(location.origin, ''), method: (o && o.method) || 'GET', status: r.status }); return r; }; })()`;

let room;
try {
  // ── the fallback: no versions ───────────────────────────────────────────
  {
    const root = plainFixture(); roots.push(root);
    room = await openRoom({ playbookRoot: root });
    await room.navigate();
    await sleep(800);
    const s = await snap(room.evaluate);
    console.log(`  plain: ${JSON.stringify(s)}`);
    if (!s.bar) problems.push('S1: no state bar on a plain playbook');
    else {
      if (!/fixture loop/.test(s.bar)) problems.push(`S1 fallback: the bar does not show the active loop as an unnamed version: "${s.bar}"`);
      if (!/No orchestrator scheduled/.test(s.bar)) problems.push(`S1 fallback: with no orchestrator block the bar must say "No orchestrator scheduled": "${s.bar}"`);
      if (s.hist) problems.push('S5 fallback: a playbook without versions shows a History clock');
    }
    await room.close(); room = null;
  }

  // ── a versioned playbook ────────────────────────────────────────────────
  const root = versionedFixture(); roots.push(root);
  room = await openRoom({ playbookRoot: root });
  const { evaluate } = room;
  await room.navigate();
  await sleep(900);
  let s = await snap(evaluate);
  console.log(`  open version: ${JSON.stringify(s)}`);
  if (!s.bar) problems.push('S1: no state bar');
  else {
    if (!/v0\.2/.test(s.bar) || /Viewing/.test(s.bar)) problems.push(`S1: the bar does not name the open version v0.2: "${s.bar}"`);
    if (!/Orchestrator (idle|working|waiting on you|stopped|paused)/.test(s.bar)) problems.push(`S1: the bar does not say what the orchestrator is doing: "${s.bar}"`);
    if (!/last tick .+ ago/.test(s.bar)) problems.push(`S1: the bar does not show the last tick: "${s.bar}"`);
    if (!/Read (just now|\d+ min ago)/.test(s.bar)) problems.push(`S1: the bar does not show the data's age: "${s.bar}"`);
    if (!s.hist) problems.push('S5: no History clock on a versioned playbook');
  }
  if (s.cards.join() !== 'new-1,new-2,new-3') problems.push(`S6: the open version's graph draws [${s.cards}], expected only v0.2's cards [new-1,new-2,new-3]`);
  if (!s.from.includes('new-1:from v0.1')) problems.push(`V5: the carried card does not say where it came from: ${JSON.stringify(s.from)}`);

  // S8: the orchestrator's defer, in its own voice, in the card's conversation
  const s8 = await evaluate(`(async () => {
    const card = document.querySelector('.flow-face[data-id="new-2"]');
    card?.focus(); card?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await new Promise((r) => setTimeout(r, 500));
    const t = document.querySelector('.flow-inspector')?.innerText ?? '';
    return { open: !!t, orchestrator: /Orchestrator/.test(t), reason: /waiting on your decision/i.test(t) };
  })()`);
  console.log(`  S8: ${JSON.stringify(s8)}`);
  if (!s8.open || !s8.orchestrator || !s8.reason) problems.push(`S8: the orchestrator's defer is not in the card's conversation with its reason: ${JSON.stringify(s8)}`);
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  await sleep(300);

  // S4 + S3: an unchanged Refresh is one 304 and no graph read; nothing is written
  await evaluate(NET);
  const refresh = `(async () => { document.querySelector('.flow-statebar button[aria-label^="Refresh now"]')?.click(); await new Promise((r) => setTimeout(r, 1500)); return window.__net.slice(); })()`;
  const unchanged = await evaluate(refresh);
  console.log(`  unchanged refresh: ${JSON.stringify(unchanged)}`);
  const stateReqs = unchanged.filter((r) => r.url.startsWith('/api/state'));
  if (stateReqs.length !== 1 || stateReqs[0].status !== 304) problems.push(`S4: an unchanged Refresh should be one /api/state answered 304, got ${JSON.stringify(stateReqs)}`);
  if (unchanged.some((r) => r.url.startsWith('/api/graph'))) problems.push('S4: an unchanged Refresh re-read the graph');
  // a change on disk: the next refresh re-reads the graph and the moved card glows once
  appendFileSync(join(root, 'memory/journal.ndjson'), JSON.stringify({ ts: new Date().toISOString(), loop_id: undefined, task: 'new-2', agent: 'lead', agent_id: 'lead', action: 'comment', status: 'todo', checks: 'none', notes: 'a new note on new-2', seq: fixtureSeq + 1 }) + '\n');
  await evaluate(NET);
  const changed = await evaluate(refresh);
  const glow = await evaluate(`[...document.querySelectorAll('.flow-face--changed')].map((c) => c.dataset.id)`);
  console.log(`  changed refresh: ${JSON.stringify(changed)} · glowing ${JSON.stringify(glow)}`);
  if (!changed.some((r) => r.url.startsWith('/api/state') && r.status === 200)) problems.push('S2: after a journal change the refresh did not read the new state');
  if (!changed.some((r) => r.url.startsWith('/api/graph'))) problems.push('S2: after a journal change the refresh did not re-read the graph');
  if (glow.join() !== 'new-2') problems.push(`S2: the card that moved should glow once — glowing [${glow}], expected [new-2]`);
  const writes = [...unchanged, ...changed].filter((r) => r.method !== 'GET');
  if (writes.length) problems.push(`S3: refresh sent write request(s): ${JSON.stringify(writes)}`);
  // a graph read that FAILS keeps the last good graph, says so, and is retried on the next
  // refresh — the change is not swallowed into a 304 (checker, seq 290)
  appendFileSync(join(root, 'memory/journal.ndjson'), JSON.stringify({ ts: new Date().toISOString(), task: 'new-1', agent: 'lead', agent_id: 'lead', action: 'comment', status: 'todo', checks: 'none', notes: 'another note', seq: fixtureSeq + 2 }) + '\n');
  await evaluate(NET);
  await evaluate('window.__failGraph = true');
  const failed = await evaluate(refresh);
  const failBar = (await snap(evaluate)).bar ?? '';
  await evaluate(NET);
  const retried = await evaluate(refresh);
  const okBar = (await snap(evaluate)).bar ?? '';
  console.log(`  failed graph read: ${JSON.stringify(failed)} · bar "${failBar.slice(0, 60)}" · retry ${JSON.stringify(retried)}`);
  if (!/Refresh failed/.test(failBar)) problems.push(`S2: a failed graph read does not say so: "${failBar}"`);
  if (!retried.some((r) => r.url.startsWith('/api/state') && r.status === 200) || !retried.some((r) => r.url.startsWith('/api/graph') && r.status === 200)) problems.push(`S2: after a failed graph read the next refresh did not re-read the graph: ${JSON.stringify(retried)}`);
  if (/Refresh failed/.test(okBar)) problems.push(`S2: the bar still reports a failure after a good refresh: "${okBar}"`);

  // S5: History, newest first
  const hist = await evaluate(`(async () => {
    document.querySelector('.flow-statebar__hist')?.click();
    for (let i = 0; i < 20 && !document.querySelector('.flow-history__table'); i++) await new Promise((r) => setTimeout(r, 150));
    const rows = [...document.querySelectorAll('.flow-history__table tbody tr')].map((tr) => tr.innerText.replace(/\\s+/g, ' ').trim());
    return { rows };
  })()`);
  console.log(`  History: ${JSON.stringify(hist)}`);
  if (hist.rows.length < 2 || !/^v0\.2/.test(hist.rows[0]) || !/^v0\.1/.test(hist.rows[1])) problems.push(`S5: History is not v0.2 then v0.1: ${JSON.stringify(hist.rows)}`);
  else {
    if (!/second version goal/.test(hist.rows[0]) || !/pb\.mjs validate/.test(hist.rows[0])) problems.push(`S5: v0.2's row lacks its start goal or stop check: ${hist.rows[0]}`);
    if (!/\d{4}-\d{2}-\d{2}/.test(hist.rows[0])) problems.push(`S5: v0.2's row has no opening date: ${hist.rows[0]}`);
    if (!/closed/.test(hist.rows[1]) || !/passed/.test(hist.rows[1])) problems.push(`S5: v0.1's row does not say it closed with its proof passing: ${hist.rows[1]}`);
  }

  // S6 + S7: open v0.1 — read-only history
  await evaluate(`(async () => { [...document.querySelectorAll('.flow-history__table tbody tr')][1]?.querySelector('button')?.click(); await new Promise((r) => setTimeout(r, 1500));
    // a finished version's cards are stacked per band (G3): show them
    for (const b of document.querySelectorAll('.flow-face--stack .flow-linkbtn')) b.click();
    await new Promise((r) => setTimeout(r, 800)); })()`);
  s = await snap(evaluate);
  console.log(`  past version: ${JSON.stringify(s)}`);
  if (s.past !== 'true' || !/Viewing v0\.1/.test(s.bar ?? '')) problems.push(`S7: picking v0.1 does not say you are viewing a closed version: "${s.bar}"`);
  if (s.cards.join() !== 'old-1,old-2') problems.push(`S6: v0.1's graph draws [${s.cards}], expected [old-1,old-2]`);
  if (s.bandPlus !== 0) problems.push(`S7: a closed version offers "+ Add a card" (${s.bandPlus})`);
  const menu = await evaluate(`(async () => {
    const plus = document.querySelector('.flow-face[data-id="old-1"] .flow-plus');
    plus?.click(); await new Promise((r) => setTimeout(r, 250));
    return [...document.querySelectorAll('.flow-pop [role=menuitem]')].map((b) => b.textContent.trim());
  })()`);
  console.log(`  past + menu: ${JSON.stringify(menu)}`);
  if (menu.length !== 2 || !/^Fork into the open version/.test(menu[0]) || !/^Comment/.test(menu[1])) problems.push(`S7: a past card's + offers [${menu.join(' | ')}], expected only "Fork into the open version" and "Comment"`);
  const fork = await evaluate(`(async () => {
    [...document.querySelectorAll('.flow-pop [role=menuitem]')].find((b) => /Fork into the open version/.test(b.textContent))?.click();
    for (let i = 0; i < 40 && !document.querySelector('.flow-pop .flow-draft__note'); i++) await new Promise((r) => setTimeout(r, 200));
    const n = document.querySelector('.flow-pop .flow-draft__note');
    return { note: n?.textContent ?? null, refused: n?.classList.contains('is-refused') ?? null };
  })()`);
  console.log(`  fork into the open version: ${JSON.stringify(fork)}`);
  const tasks = pbJson(root, ['graph', '--json', '--version', 'v0.2']).nodes.filter((n) => (n.kind ?? 'task') === 'task');
  const forked = tasks.find((n) => !['new-1', 'new-2', 'new-3'].includes(n.id));
  if (fork.refused !== false || !forked) problems.push(`S7: "Fork into the open version" did not create a card in v0.2: ${JSON.stringify(fork)}`);
  else if (forked.task_kind !== 'experiment' || forked.version !== 'v0.2') problems.push(`V4: the fork is ${forked.task_kind} in ${forked.version}, expected an experiment in v0.2`);
  const old = pbJson(root, ['graph', '--json', '--version', 'v0.1']).nodes.find((n) => n.id === 'old-1');
  if (old?.status !== 'done' || old?.version !== 'v0.1') problems.push(`S7: the past card changed: ${JSON.stringify({ status: old?.status, version: old?.version })}`);

  // and back
  await evaluate(`(async () => { document.querySelector('.flow-pop button[role=menuitem]')?.click(); await new Promise((r) => setTimeout(r, 200));
    [...document.querySelectorAll('.flow-statebar button')].find((b) => /Back to the open version/.test(b.textContent))?.click(); await new Promise((r) => setTimeout(r, 1500)); })()`);
  s = await snap(evaluate);
  console.log(`  back: ${JSON.stringify(s)}`);
  if (s.past !== 'false' || !s.cards.includes('new-1') || s.bandPlus === 0) problems.push(`S6: "Back to the open version" did not return to v0.2 with its add buttons: ${JSON.stringify(s)}`);
  for (const e of room.cdp.errors.slice(0, 5)) problems.push(`page error: ${String(e).split('\n')[0]}`);
} catch (err) {
  problems.push(`browser harness failed: ${err.stack ?? err.message}`);
} finally {
  if (room) await room.close();
  for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch { /* temp */ } }
}

if (problems.length) {
  console.error(`\nROOM VERSIONS CHECK FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nThe room holds S1 (state bar + fallback), S3/S4 (refresh reads only; unchanged = one 304), S2 (moved cards glow), S5 (History newest first), S6 (one version per graph), S7 (past versions read-only, fork into the open one) and S8 (the orchestrator speaks on the card).');
