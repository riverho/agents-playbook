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
import { openRoom, ROOT, sleep } from './lib-room-browser.mjs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const problems = [];
const MIN_PX = 9;
const ZOOMS = [1, 0.5, 0.2, 0.05];
const expectTier = (z) => (z >= 0.75 ? 'full' : z >= 0.4 ? 'glance' : 'overview');

let room;
try {
  room = await openRoom({ url: flag('--url'), playbookRoot: flag('--root') ? resolve(flag('--root')) : ROOT });
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
      return { cards: cards.length, still: still.length, live: live.length, moving: moving.map((c) => (c.title || '').split(' — ')[0]).slice(0, 5), movingN: moving.length };
    })()`);
    console.log(`  F1 ${Math.round(z * 100)}%: ${f1.cards} card(s), ${f1.live} live, ${f1.still} still · ${f1.movingN} still card(s) animating`);
    if (f1.still === 0) problems.push(`F1 ${z}: no still card to watch — the check stopped watching`);
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
        const px = parseFloat(getComputedStyle(el).fontSize) * (inCanvas(el) ? zoom : 1);
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
}

if (problems.length) {
  console.error(`\nROOM BROWSER CHECK FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nThe room holds T3 (≥ 9px at every zoom), F4 (reduced motion) and G5 (beacons at 5%).');
