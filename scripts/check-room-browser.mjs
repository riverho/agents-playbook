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
import { makeFixture } from './test-fixture-playbook.mjs';
import { rmSync } from 'node:fs';
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
      const inCanvas = (el) => !!el.closest('.react-flow__viewport, .react-flow__edgelabel-renderer, .react-flow__viewport-portal');
      const vw = innerWidth, vh = innerHeight;
      let smallest = Infinity, where = '', counted = 0;
      for (const el of room.querySelectorAll('*')) {
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own) continue;
        if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;
        // the REAL on-screen scale: rendered height over layout height, so the canvas zoom AND any
        // counter-scale (fixed-size labels use scale(var(--inv))) are both counted
        const scale = el.offsetHeight > 0 ? r.height / el.offsetHeight : (inCanvas(el) ? zoom : 1);
        const px = parseFloat(getComputedStyle(el).fontSize) * scale;
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
    const discard = [...(document.querySelector('.flow-face--draft')?.querySelectorAll('button') ?? [])].find((b) => /Discard/.test(b.textContent));
    discard?.click(); await wait(300);
    return { cards: cards.length, pluses, focusable, items, drafted: !!draft, cmd, gone: !document.querySelector('.flow-face--draft'), writes: window.__writes };
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
    if (jump.writes !== 0) problems.push(`J3: the room sent ${jump.writes} write request(s) before anything was created`);
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
