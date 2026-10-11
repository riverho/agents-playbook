#!/usr/bin/env node
// ============================================================================
//  check-room-browser.mjs — the contract rules only a browser can check.
// ----------------------------------------------------------------------------
//  T3  No text renders below 9px on screen at any zoom. The room is driven to 100%,
//      50%, 20% and 5%; at each, every visible text element's on-screen size is
//      measured (computed font-size × the canvas zoom it sits under).
//      The tier attribute must match the zoom (full ≥ 75%, glance ≥ 40%, overview).
//  F4  Reduced motion: under `prefers-reduced-motion: reduce` nothing on the face
//      animates, and the needs-a-person label keeps a solid outline instead.
//      Measured on a probe card injected into the page, so the check does not depend
//      on whether the backlog happens to hold a live or a waiting card today.
//  G5  At 5% every working / needs-you card shows its beacon (a fixed-size dot).
//
//  Usage: node scripts/check-room-browser.mjs [--url <running room>] [--root <playbook>]
//  Needs a build: npm --prefix apps/flow-room run build
// ============================================================================
import { openRoom, sleep } from './lib-room-browser.mjs';
import { makeFixture, runPb } from './test-fixture-playbook.mjs';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// By default the gate draws a FIXTURE playbook it builds itself, so what it watches does not
// depend on what today's backlog happens to hold (an independent checker found the F1 check
// passing vacuously when the real backlog had no quiet claim) and it runs the same in a
// worker worktree, which has no memory/. --root <playbook> or --url <room> look at a real one.
function roomFixture() {
  const now = Date.now();
  const iso = (min) => new Date(now - min * 60_000).toISOString();
  const row = (task, seq, min, action = 'implement', status = 'in_progress', checks = 'none') =>
    ({ ts: iso(min), loop_id: 'loop-fix-001', task, agent: 'lead', agent_id: 'lead', action, status, checks, notes: `${action} on ${task}. Detail follows.`, seq });
  const held = (task, min) => ({ status: 'in_progress', claimed_by: 'lead', agent_id: 'lead', seq: 1, loop_id: 'loop-fix-001', updated_at: iso(min) });
  const ready = Array.from({ length: 6 }, (_, k) => ({ id: `ready-${k + 1}`, title: `A task that is ready to start, number ${k + 1}`, layer: 'L1', priority: k + 2 }));
  return makeFixture({
    prefix: 'pbroom-',
    layers: [
      { id: 'L0', name: 'substrate', about: 'the engine', gate: 'node -e "process.exit(0)"' },
      { id: 'L1', name: 'surfaces', about: 'what people see', gate: 'node -e "process.exit(0)"' },
      { id: 'L2', name: 'orchestration', about: 'loops and versions' },
    ],
    tasks: [
      { id: 'live-claim', title: 'A claim whose journal moved a minute ago', layer: 'L1', priority: 1 },
      { id: 'quiet-claim', title: 'A claim nobody has touched for two hours', layer: 'L1', priority: 1 },
      { id: 'asks-you', title: 'Publish the package, or close it as superseded?', layer: 'L2', manual: true },
      { id: 'agent-question', title: 'Choose a platform', layer: 'L1', extra: ['human:', '  question: "Which platform first?"', '  options:', '    - { id: windows, label: Windows, effect: Verify Windows first }', '    - { id: posix, label: POSIX, effect: Verify POSIX first }', '  recommended: windows', '  recommended_by: Lead'] },
      { id: 'blocked-one', title: 'Waiting on a missing engine primitive', layer: 'L2' },
      { id: 'done-proven', title: 'Finished with its checks passing', layer: 'L0' },
      { id: 'done-unproven', title: 'Closed without a passing check', layer: 'L0' },
      ...ready,
    ],
    journal: [
      row('live-claim', 1, 1), row('quiet-claim', 2, 120), row('blocked-one', 3, 30, 'triage', 'blocked'),
      row('done-proven', 4, 300, 'execute', 'done', 'passed'), row('done-unproven', 5, 300, 'execute', 'done', 'none'),
    ],
    state: {
      'live-claim': held('live-claim', 1), 'quiet-claim': held('quiet-claim', 120),
      'blocked-one': { status: 'blocked', seq: 3, updated_at: iso(30) },
      'done-proven': { status: 'done', seq: 4, updated_at: iso(300) },
      'done-unproven': { status: 'done', seq: 5, updated_at: iso(300) },
    },
  });
}

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const problems = [];
const MIN_PX = 9;
const ZOOMS = [1, 0.5, 0.2, 0.05];
const expectTier = (z) => (z >= 0.75 ? 'full' : z >= 0.4 ? 'glance' : 'overview');

let room;
let fixture = null;
try {
  if (!flag('--url') && !flag('--root')) fixture = roomFixture();
  room = await openRoom({ url: flag('--url'), playbookRoot: flag('--root') ? resolve(flag('--root')) : fixture });
  if (fixture) console.log(`fixture playbook: ${fixture} (live, quiet, asking, blocked, proven and unproven done, 6 ready)`);
  const { evaluate, cdp } = room;
  const mounted = await room.navigate();
  console.log(`room: ${room.url} · ${mounted} node(s) mounted`);

  // the gate must be looking at a backlog: a room with no task cards passes nothing vacuously
  await evaluate('window.__flowRoom.setViewport({ x: 20, y: 20, zoom: 1 })');
  await sleep(300);
  const taskCards = await evaluate("document.querySelectorAll('.flow-face[data-live]').length");
  console.log(`task cards: ${taskCards}`);
  if (taskCards < 5) problems.push(`only ${taskCards} task card(s) mounted — the room is not drawing a backlog (run in a playbook with tasks, or pass --root <playbook>)`);

  // ── the legend's content fits the box the layout budgeted for it (plan-20261010-001) ──
  // A unit test reads the CSS; this reads what the browser actually laid out, inherited
  // values included (Tailwind's preflight line-height once made every row 2px too tall).
  {
    const lg = await evaluate(`(() => {
      const el = document.querySelector('.flow-legend');
      if (!el) return null;
      const rows = [...el.querySelectorAll('.flow-legend__row, .flow-legend__h')].map((r) => r.getBoundingClientRect().height / (r.getBoundingClientRect().height ? (r.offsetHeight / r.getBoundingClientRect().height) : 1));
      return { scrollH: el.scrollHeight, clientH: el.clientHeight, scrollW: el.scrollWidth, clientW: el.clientWidth, rowH: Math.max(...el.querySelectorAll('.flow-legend__row').length ? [...el.querySelectorAll('.flow-legend__row')].map((r) => r.offsetHeight) : [0]), lineHeight: getComputedStyle(el.querySelector('.flow-legend__row') ?? el).lineHeight, n: rows.length };
    })()`);
    console.log(`  legend: ${JSON.stringify(lg)}`);
    if (!lg) problems.push('the legend was not drawn');
    else {
      if (lg.scrollH > lg.clientH + 1) problems.push(`the legend's content (${lg.scrollH}px) is taller than its box (${lg.clientH}px) — rows are clipped (row line-height ${lg.lineHeight})`);
      if (lg.scrollW > lg.clientW + 1) problems.push(`the legend's content (${lg.scrollW}px) is wider than its box (${lg.clientW}px)`);
    }
  }

  // ── F1: nothing animates unless it is live or asking a person ──
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  for (const z of [1, 0.05]) {
    await evaluate(`window.__flowRoom.setViewport({ x: 20, y: 20, zoom: ${z} })`);
    await sleep(450);
    const f1 = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.flow-room:not(#__motion-probe) .flow-face[data-live]')];
      const still = cards.filter((c) => c.dataset.live === 'false' && !c.dataset.hil);
      const moving = still.filter((c) => c.getAnimations({ subtree: true }).some((a) => a.constructor.name === 'CSSAnimation' && a.playState === 'running'));
      const live = cards.filter((c) => c.dataset.live === 'true');
      const held = cards.filter((c) => c.dataset.beacon === 'held');
      const liveMoving = live.filter((c) => c.getAnimations({ subtree: true }).some((a) => a.constructor.name === 'CSSAnimation' && a.playState === 'running'));
      return { cards: cards.length, still: still.length, live: live.length, held: held.length, liveMoving: liveMoving.length, moving: moving.map((c) => (c.title || '').split(' — ')[0]).slice(0, 5), movingN: moving.length };
    })()`);
    console.log(`  F1 ${Math.round(z * 100)}%: ${f1.cards} card(s), ${f1.live} live (${f1.liveMoving} moving), ${f1.held} held, ${f1.still} still · ${f1.movingN} still card(s) animating`);
    if (f1.still === 0) problems.push(`F1 ${z}: no still card to watch — the check stopped watching`);
    // with the fixture both sides are guaranteed: a quiet claim must be still, a live one must move
    if (fixture && f1.held < 1) problems.push(`F1 ${z}: the fixture's quiet claim is not drawn as a still 'held' card`);
    if (fixture && f1.live > 0 && f1.liveMoving === 0) problems.push(`F1 ${z}: the live card does not animate — the positive control failed`);
    if (fixture && f1.live < 1) problems.push(`F1 ${z}: the fixture's live claim is not drawn as live`);
    if (f1.movingN) problems.push(`F1 ${z}: ${f1.movingN} card(s) that are not live animate: ${f1.moving.join(', ')}`);
  }

  // ── T3 + G5 ────────────────────────────────────────────────────────────────
  for (const zoom of ZOOMS) {
    await evaluate(`window.__flowRoom.setViewport({ x: 20, y: 20, zoom: ${zoom} })`);
    await sleep(450);
    const m = await evaluate(`(() => {
      const zoom = window.__flowRoom.getZoom();
      const room = document.querySelector('.flow-room');
      const realScale = (el) => { let s = 1; for (let a = el; a && a !== document.documentElement; a = a.parentElement) { const t = getComputedStyle(a).transform; if (t && t !== 'none') s *= new DOMMatrixReadOnly(t).a; } return s; };
      const inCanvas = (el) => !!el.closest('.react-flow__viewport, .react-flow__edgelabel-renderer, .react-flow__viewport-portal');
      const vw = innerWidth, vh = innerHeight;
      let smallest = Infinity, where = '', counted = 0;
      for (const el of room.querySelectorAll('*')) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
        // the EXACT on-screen scale: the product of every transform scale from the element up
        // (the canvas zoom, and the counter-scale fixed-size labels use) — no rounding, no padding
        const px = parseFloat(getComputedStyle(el).fontSize) * realScale(el);
        counted++;
        if (px < smallest) { smallest = px; where = (el.className && String(el.className).slice(0, 60)) + ' "' + el.textContent.trim().slice(0, 30) + '"'; }
      }
      const beaconCards = [...document.querySelectorAll('.flow-face[data-beacon="work"], .flow-face[data-beacon="you"]')];
      const shown = beaconCards.filter((c) => { const b = c.querySelector('.flow-beacon'); return b && getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width >= 10; }).length;
      return { zoom, tier: room.dataset.tier, smallest, where, counted, beaconCards: beaconCards.length, shown };
    })()`);
    const label = `${Math.round(zoom * 100)}%`;
    console.log(`  ${label.padStart(4)}  tier ${m.tier.padEnd(8)}  ${m.counted} text element(s), smallest ${Number.isFinite(m.smallest) ? m.smallest.toFixed(1) + 'px' : '—'}${m.where ? ` (${m.where})` : ''}`);
    if (Math.abs(m.zoom - zoom) > 0.001) problems.push(`${label}: the room did not reach the zoom (at ${m.zoom})`);
    if (m.tier !== expectTier(zoom)) problems.push(`${label}: tier is ${m.tier}, expected ${expectTier(zoom)}`);
    if (m.smallest < MIN_PX) problems.push(`T3 ${label}: text renders at ${m.smallest.toFixed(1)}px on screen (< ${MIN_PX}px): ${m.where}`);
    if (zoom === 1 && m.counted < 20) problems.push(`T3 100%: only ${m.counted} text element(s) measured — the check stopped watching the room`);
    if (zoom === 0.05) {
      console.log(`        beacons: ${m.shown} of ${m.beaconCards} working / needs-you card(s) visible`);
      if (m.shown !== m.beaconCards) problems.push(`G5 5%: ${m.beaconCards - m.shown} working / needs-you card(s) have no visible beacon`);
    }
  }

  // ── G1 / G5: one band per layer, each named at 5% ─────────────────────────
  await evaluate('window.__flowRoom.setViewport({ x: 40, y: 80, zoom: 0.05 })');
  await sleep(450);
  const bands = await evaluate(`(() => {
    const all = [...document.querySelectorAll('.flow-band')];
    const named = all.filter((b) => { const l = b.querySelector('.flow-band__label'); return l && getComputedStyle(l).display !== 'none' && l.getBoundingClientRect().height >= 10; });
    return { bands: all.length, named: named.length, ids: all.map((b) => b.dataset.band) };
  })()`);
  console.log(`  G1/G5 5%: ${bands.bands} band(s) [${bands.ids.join(', ')}], ${bands.named} named on screen`);
  if (!bands.bands) problems.push('G1: no layer bands were drawn');
  if (bands.named !== bands.bands) problems.push(`G5 5%: ${bands.bands - bands.named} band(s) have no visible label`);
  if (fixture && bands.ids.join() !== 'L0,L1,L2') problems.push(`G1: the fixture's bands are [${bands.ids.join(', ')}], expected [L0, L1, L2]`);

  // ── J1–J3: the + menu and a draft, with NO write before Create ────────────
  await evaluate('window.__flowRoom.setViewport({ x: 20, y: 20, zoom: 1 })');
  await sleep(450);
  await evaluate(`(() => { window.__writes = 0; const f = window.fetch; window.fetch = (u, o) => { if (o && o.method && o.method !== 'GET') window.__writes++; return f(u, o); }; })()`);
  const jump = await evaluate(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cards = [...document.querySelectorAll('.flow-face[data-live]')];
    const pluses = cards.map((c) => c.querySelectorAll('.flow-plus').length);
    const plus = cards[0]?.querySelector('.flow-plus');
    if (!plus) return { error: 'no + on the first card' };
    plus.focus();
    const focusable = document.activeElement === plus;
    plus.click(); await wait(200);
    const items = [...document.querySelectorAll('.flow-pop [role=menuitem]')].map((b) => b.textContent.trim().slice(0, 30));
    const follow = [...document.querySelectorAll('.flow-pop [role=menuitem]')].find((b) => /Follow-up/.test(b.textContent));
    follow?.click(); await wait(700);
    const draft = document.querySelector('.flow-face--draft');
    const ta = draft?.querySelector('textarea');
    if (ta) {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, 'a follow-up typed in the gate'); ta.dispatchEvent(new Event('input', { bubbles: true })); await wait(200);
    }
    const cmd = document.querySelector('.flow-face--draft .flow-draft__cmd')?.textContent ?? '';
    // T3 with a draft OPEN, at the tier edges (the first T3 pass ran before any draft existed)
    const sizes = [];
    for (const z of [0.75, 0.74, 0.4, 0.39]) {
      { const d = window.__flowRoom.getNodes().find((n) => String(n.id).startsWith("draft:")); if (d) window.__flowRoom.setCenter(d.position.x + 144, d.position.y + 98, { zoom: z }); else window.__flowRoom.setViewport({ x: 20, y: 20, zoom: z }); } await wait(400);
      const draftShown = !!document.querySelector(".flow-face--draft");
      const zoomNow = window.__flowRoom.getZoom(); void zoomNow;
      const realScale = (el) => { let s = 1; for (let a = el; a && a !== document.documentElement; a = a.parentElement) { const t = getComputedStyle(a).transform; if (t && t !== 'none') s *= new DOMMatrixReadOnly(t).a; } return s; };
      let smallest = Infinity, where = '';
      for (const el of document.querySelectorAll('.flow-room *')) {
        const own = [...el.childNodes].some((n) => (n.nodeType === 3 && n.textContent.trim()) || el.tagName === 'TEXTAREA');
        if (!own || (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))) continue;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
        const px = parseFloat(getComputedStyle(el).fontSize) * realScale(el);
        if (px < smallest) { smallest = px; where = String(el.className).slice(0, 40) + ' "' + (el.textContent || el.value || '').trim().slice(0, 24) + '"'; }
      }
      sizes.push({ z, draftShown, smallest: Math.round(smallest * 10) / 10, where });
    }
    window.__flowRoom.setViewport({ x: 20, y: 20, zoom: 1 }); await wait(350);
    const discard = [...(document.querySelector('.flow-face--draft')?.querySelectorAll('button') ?? [])].find((b) => /Discard/.test(b.textContent));
    discard?.click(); await wait(300);
    return { cards: cards.length, pluses, focusable, items, drafted: !!draft, cmd, sizes, gone: !document.querySelector('.flow-face--draft'), writes: window.__writes };
  })()`);
  console.log(`  J1–J3: ${JSON.stringify(jump)}`);
  if (jump.error) problems.push(`J1: ${jump.error}`);
  else {
    if (jump.pluses.some((n) => n !== 1)) problems.push(`J1: a card has ${jump.pluses.find((n) => n !== 1)} + buttons (expected exactly one each)`);
    if (!jump.focusable) problems.push('J1: the + is not keyboard focusable');
    if (jump.items.length !== 3 || !/Follow-up/.test(jump.items[0]) || !/Fork/.test(jump.items[1]) || !/Comment/.test(jump.items[2])) problems.push(`J2: the + menu offers [${jump.items.join(' | ')}]`);
    if (!jump.drafted) problems.push('J2: Follow-up did not put a draft card on the canvas');
    if (!/^pb plan --goal "a follow-up typed in the gate" --dep \S+/.test(jump.cmd)) problems.push(`J3: the draft does not say what Create will run (${jump.cmd})`);
    if (!jump.gone) problems.push('J3: Discard did not remove the draft');
    for (const sz of jump.sizes ?? []) if (!sz.draftShown) problems.push(`T3 ${sz.z}: the draft was not on screen to measure`);
    for (const sz of jump.sizes ?? []) if (sz.smallest < MIN_PX) problems.push(`T3 ${sz.z} with a draft open: text at ${sz.smallest}px (< ${MIN_PX}px): ${sz.where}`);
    if (jump.writes !== 0) problems.push(`J3: the room sent ${jump.writes} write request(s) before anything was created`);
  }

  // ── the open card (D15) and M3: a message with an intent lands as ONE row ──
  // Only against the fixture: it is this gate's own temp playbook, so sending writes nothing real.
  if (fixture) {
    const journalFile = resolve(fixture, 'memory/journal.ndjson');
    const rowsBefore = readFileSync(journalFile, 'utf8').split('\n').filter((l) => l.trim()).length;
    const oc = await evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const card = document.querySelector('.flow-face[data-live="true"]');
      if (!card) return { error: 'no live card to open' };
      card.click(); await wait(400);
      const panel = document.querySelector('.flow-oc');
      if (!panel) return { error: 'clicking a card did not open it' };
      const heads = [...panel.querySelectorAll('h3, summary')].map((h) => h.textContent.trim().split(/\\s{2,}| step| \\d| no checks/)[0]);
      const idBeforeEngine = (panel.querySelector('.flow-oc__head')?.textContent ?? '').includes('live-claim');
      [...panel.querySelectorAll('.flow-oc__intent')].find((b) => /Change direction/.test(b.textContent))?.click(); await wait(100);
      const ta = panel.querySelector('textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(ta, 'Write the POSIX path conservatively.'); ta.dispatchEvent(new Event('input', { bubbles: true })); await wait(150);
      panel.querySelector('button[type=submit]').click();
      for (let i = 0; i < 40 && !/Saved to|refused|error|failed/i.test(panel.querySelector('[role=status]')?.textContent ?? ''); i++) await wait(150);
      return { heads, idBeforeEngine, status: panel.querySelector('[role=status]')?.textContent ?? '' };
    })()`);
    console.log(`  open card: ${JSON.stringify(oc)}`);
    const rows = readFileSync(journalFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const last = rows[rows.length - 1];
    if (oc.error) problems.push(`D15: ${oc.error}`);
    else {
      const want = ['What this is', 'Where it stands', 'Proof', 'Conversation', 'Engine details'];
      const got = oc.heads.filter((h) => want.includes(h));
      if (got.join('|') !== want.join('|')) problems.push(`D15: the open card's sections are [${oc.heads.join(' | ')}], expected ${want.join(' → ')}`);
      if (oc.idBeforeEngine) problems.push('K4: the open card shows the task ID in its title block (it belongs in engine details)');
      if (!/Saved to the project journal/.test(oc.status)) problems.push(`M3: sending did not report the saved row: "${oc.status}"`);
      if (rows.length !== rowsBefore + 1) problems.push(`M3: sending wrote ${rows.length - rowsBefore} journal row(s), expected exactly 1`);
      else if (last.action !== 'comment' || last.intent !== 'steer' || last.task !== 'live-claim' || last.notes !== 'Write the POSIX path conservatively.') {
        problems.push(`M3: the row written is ${JSON.stringify({ action: last.action, intent: last.intent, task: last.task, notes: last.notes })}`);
      }
    }
  }

  // ── A1: a card opens and closes by keyboard, and focus goes where it should ──
  {
    await evaluate(`(() => { document.querySelector('.flow-oc .flow-oc__close')?.click(); })()`);
    await sleep(300);
    const kb = await evaluate(`(async () => {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const card = document.querySelector('.flow-face[data-live][tabindex="0"]');
      if (!card) return { error: 'no task card is keyboard-focusable' };
      card.focus();
      const focused = document.activeElement === card;
      card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await wait(400);
      const panel = document.querySelector('.flow-oc');
      const inPanel = !!panel && panel.contains(document.activeElement);
      // Escape in a message box with text keeps the card AND the text; the next one closes
      const ta = panel?.querySelector('textarea');
      let keptDraft = false;
      if (ta) {
        const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        ta.focus(); set.call(ta, 'half a thought'); ta.dispatchEvent(new Event('input', { bubbles: true })); await wait(100);
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(300);
        keptDraft = !!document.querySelector('.flow-oc') && document.querySelector('.flow-oc textarea')?.value === 'half a thought';
      }
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(400);
      const closed = !document.querySelector('.flow-oc');
      const back = document.activeElement === card || document.activeElement?.dataset?.id === card.dataset.id;
      // Escape closes an open + menu
      const plus = card.querySelector('.flow-plus');
      plus?.click(); await wait(250);
      const menuOpen = !!document.querySelector('.flow-pop');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(250);
      return { focused, opened: !!panel, inPanel, keptDraft, closed, back, menuOpen, menuClosed: !document.querySelector('.flow-pop') };
    })()`);
    console.log(`  A1 keyboard: ${JSON.stringify(kb)}`);
    if (kb.error) problems.push(`A1: ${kb.error}`);
    else {
      if (!kb.focused) problems.push('A1: a task card cannot take keyboard focus');
      if (!kb.opened) problems.push('A1: Enter on a focused card does not open it');
      if (!kb.inPanel) problems.push('A1: opening a card does not move focus into it');
      if (!kb.closed) problems.push('A1: Escape does not close the open card');
      if (!kb.back) problems.push('A1: closing the card does not return focus to it');
      if (!kb.keptDraft) problems.push('A1: Escape in a message box with text closed the card or lost the text');
      if (!kb.menuOpen || !kb.menuClosed) problems.push(`A1: Escape does not close an open + menu (open ${kb.menuOpen}, closed after Escape ${kb.menuClosed})`);
    }
  }
  // H1-H4: the inbox is keyboard reachable; no write until an explicit answer.
  if (fixture) {
    const journalFile = resolve(fixture, 'memory/journal.ndjson');
    const before = readFileSync(journalFile, 'utf8').trim().split('\n').length;
    const receipt = await evaluate(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const toggle = document.querySelector('button[aria-label^="Waiting on you:"]');
      if (!toggle) return { error: 'no inbox button' };
      toggle.focus(); toggle.click(); await wait(150);
      const dialog = document.querySelector('.flow-decisions');
      if (!dialog) return { error: 'inbox did not open' };
      const kinds = [...dialog.querySelectorAll('.flow-decisions__inbox .flow-decisions__kind')].map(n => n.textContent);
      const question = [...dialog.querySelectorAll('.flow-decisions__inbox button')].find(n => /Which platform/.test(n.textContent));
      question?.click(); await wait(100);
      const panel = dialog.querySelector('form');
      if (!panel) return { error: 'no decision panel' };
      const options = panel.querySelectorAll('input[type=radio]').length;
      const recommendation = panel.querySelector('.flow-decisions__rec')?.textContent;
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      const text = panel.querySelector('textarea'); set.call(text, 'Start on Windows.'); text.dispatchEvent(new Event('input', { bubbles: true })); await wait(100);
      const submit = panel.querySelector('button[type=submit]'); submit.focus(); submit.click(); submit.click();
      for (let i = 0; i < 50 && !dialog.querySelector('.flow-decisions__receipt'); i++) await wait(150);
      return { kinds, options, recommendation, receipt: dialog.querySelector('.flow-decisions__receipt')?.textContent, count: toggle.textContent };
    })()`);
    const after = readFileSync(journalFile, 'utf8').trim().split('\n').map(JSON.parse);
    if (receipt.error) problems.push(`H3: ${receipt.error}`);
    else {
      if (!receipt.kinds.includes('Approval') || !receipt.kinds.includes('Question')) problems.push('H1: inbox does not distinguish approvals and questions');
      if (receipt.options < 2 || receipt.recommendation !== 'Lead recommends') problems.push('H2: question has no options or named recommendation');
      if (!/Decision recorded.*row/.test(receipt.receipt ?? '') || !/Start on Windows/.test(receipt.receipt ?? '')) problems.push(`H3: no recorded row is displayed: ${receipt.receipt}`);
      if (after.length !== before + 1 || after.at(-1).action !== 'decide' || after.at(-1).task !== 'agent-question') problems.push('H3: double-click did not write exactly one decision row');
      if (!/Waiting on you 1/.test(receipt.count)) problems.push(`H4: header count was not updated after answering: ${receipt.count}`);
    }
    if (flag('--shots')) {
      const dest = resolve(flag('--shots'));
      mkdirSync(dest, { recursive: true });
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(resolve(dest, 'decision-recorded.png'), Buffer.from(shot.data, 'base64'));
    }
    const finishAsk = runPb(fixture, ['record', '--task', 'asks-you', '--action', 'execute', '--status', 'done', '--notes', 'Fixture completed after the inbox loaded.']);
    if (finishAsk.code !== 0) problems.push(`H3 refusal fixture: could not complete asks-you: ${finishAsk.combined}`);
    const beforeRefusal = readFileSync(journalFile, 'utf8');
    const refused = await evaluate(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const dialog = document.querySelector('.flow-decisions');
      const panel = dialog.querySelector('form');
      const text = panel.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(text, 'Answer a card completed elsewhere.');
      text.dispatchEvent(new Event('input', { bubbles: true })); await wait(100);
      panel.querySelector('button[type=submit]').click();
      for (let i = 0; i < 50 && !panel.querySelector('.flow-decisions__result'); i++) await wait(150);
      return panel.querySelector('.flow-decisions__result')?.textContent;
    })()`);
    if (refused !== '[asks-you] is already done — there is nothing left to decide. Nothing was written.') problems.push(`H3: engine refusal not shown verbatim: ${refused}`);
    if (readFileSync(journalFile, 'utf8') !== beforeRefusal) problems.push('H3: a refused decision wrote a row');
    await evaluate(`document.querySelector('button[aria-label="Close decisions"]')?.click()`);
  }

  // ── F4: reduced motion, on an injected probe card ─────────────────────────
  const probe = `(() => {
    let host = document.getElementById('__motion-probe');
    if (!host) {
      host = document.createElement('div');
      host.id = '__motion-probe';
      host.className = 'flow-room';
      host.dataset.tier = 'overview';
      host.style.cssText = 'position:fixed;left:-2000px;top:0;width:400px;height:300px';
      host.innerHTML = '<div class="flow-face flow-face--live" data-hil="asking"><span class="flow-st flow-st--asking">Needs your decision</span><span class="flow-led"></span>' +
        '<div class="flow-cycle flow-face__bar flow-face__bar--working" data-step="3"><i class="flow-cycle__on"></i><i class="flow-cycle__on"></i><i class="flow-cycle__on flow-cycle__cur"></i><i></i><i></i><i></i></div>' +
        '<span class="flow-beacon flow-beacon--work"></span><span class="flow-beacon flow-beacon--hil"></span></div>';
      document.body.appendChild(host);
    }
    const q = (s) => host.querySelector(s);
    const anim = (el, pseudo) => getComputedStyle(el, pseudo || null).animationName;
    return {
      card: anim(q('.flow-face')), label: anim(q('.flow-st--asking')), led: anim(q('.flow-led')),
      sweep: anim(q('.flow-cycle__cur'), '::after'), beacon: anim(q('.flow-beacon--work')), sonar: anim(q('.flow-beacon--hil'), '::before'),
      outline: getComputedStyle(q('.flow-st--asking')).outlineStyle,
    };
  })()`;
  // headless Chrome may itself report reduced motion: state BOTH preferences explicitly
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await sleep(150);
  const moving = await evaluate(probe);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await sleep(150);
  const still = await evaluate(probe);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  console.log(`  motion  normal: ${JSON.stringify(moving)}`);
  console.log(`  motion  reduce: ${JSON.stringify(still)}`);
  for (const k of ['card', 'label', 'led', 'sweep', 'beacon', 'sonar']) {
    if (moving[k] === 'none') problems.push(`F4 probe: ${k} does not animate even with motion allowed — the probe stopped watching`);
    if (still[k] !== 'none') problems.push(`F4: ${k} still animates (${still[k]}) under prefers-reduced-motion`);
  }
  if (still.outline === 'none') problems.push('F4: under reduced motion the needs-a-person label lost its solid outline');
  // C1 in a real browser, in DARK. The token set is contrast-checked statically by
  // check-room-contract.mjs, but a static check cannot see an inline style, a literal background or
  // a stacked context — this asks the DOM what colour each visible text element actually ended up
  // with and what surface is painted behind it, after the dark tokens have applied.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(250);
  const dark = await evaluate(`(() => {
    const lum = (rgb) => {
      const parts = (rgb || '').match(/[\\d.]+/g) || [];
      const [r, g, b] = parts.slice(0, 3).map(Number).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    // A background can be TRANSLUCENT (--you-tint is a 10% wash). Reading rgba(180,22,127,0.1) as
    // if it were opaque says fuchsia-on-fuchsia is 1:1, which is a measurement bug, not a defect:
    // the layers are composited from the root down instead.
    const layersOf = (el) => { const out = []; let n = el; while (n) { out.push(getComputedStyle(n).backgroundColor); n = n.parentElement; } return out.reverse(); };
    const composite = (layers) => {
      let acc = [255, 255, 255];
      for (const c of layers) {
        const m = (c || '').match(/[\\d.]+/g);
        if (!m) continue;
        const [r, g, b] = m.slice(0, 3).map(Number);
        const a = m.length > 3 ? Number(m[3]) : 1;
        if (a === 0) continue;
        acc = [r * a + acc[0] * (1 - a), g * a + acc[1] * (1 - a), b * a + acc[2] * (1 - a)];
      }
      return 'rgb(' + acc.map((v) => Math.round(v)).join(', ') + ')';
    };
    const paintedBehind = (el) => composite(layersOf(el));
    const sample = [...document.querySelectorAll('.flow-face, .flow-chip, .flow-dock, .flow-insp, .flow-band, .react-flow__node')]
      .filter((el) => el.offsetParent !== null && (el.textContent || '').trim()).slice(0, 40);
    const bad = [];
    let checked = 0;
    for (const el of sample) {
      const fg = getComputedStyle(el).color;
      const bg = paintedBehind(el);
      checked += 1;
      const r = ratio(fg, bg);
      if (r < 4.5) bad.push({ cls: String(el.className).slice(0, 40), fg, bg, r: Number(r.toFixed(2)) });
    }
    const canvas = document.querySelector('.react-flow, .flow-room, main') || document.body;
    const surface = composite(layersOf(canvas));
    return { checked, bad: bad.slice(0, 4), surface, surfaceLum: Number(lum(surface).toFixed(4)) };
  })()`);
  console.log(`  dark    canvas ${dark.surface} (luminance ${dark.surfaceLum}) · ${dark.checked} text sample(s), ${dark.bad.length} under 4.5:1`);
  if (!(dark.surfaceLum < 0.12)) problems.push(`C1 dark: the canvas is still light (${dark.surface}, luminance ${dark.surfaceLum}) — the dark tokens did not apply`);
  if (dark.checked < 5) problems.push(`C1 dark: only ${dark.checked} text element(s) measured — too few to mean anything`);
  for (const b of dark.bad) problems.push(`C1 dark: .${b.cls} is ${b.r}:1 (${b.fg} on ${b.bg})`);
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });
  for (const e of room.cdp.errors.slice(0, 5)) problems.push(`page error: ${String(e).split('\n')[0]}`);
} catch (err) {
  problems.push(`browser harness failed: ${err.message}`);
} finally {
  if (room) await room.close();
  if (fixture) { try { rmSync(fixture, { recursive: true, force: true }); } catch { /* temp */ } }
}

if (problems.length) {
  console.error(`\nROOM BROWSER CHECK FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nThe room holds T3 (>= 9px at every zoom), F1 (only live cards move), F4 (reduced motion), G1/G5 (bands named at 5%) and J1-J3 (jump-in writes nothing before Create).');
