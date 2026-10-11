#!/usr/bin/env node
// scripts/test-graph-layers-live.mjs — plan-20261010-029 (D21, contract G1, G4, F1)
// ----------------------------------------------------------------------------
// `pb graph --json` carries what the layer view draws, and nothing it would have to guess:
//
//   1. layers[] — one entry per declared layer with id, name, about, gate, position and
//      source 'declared'; an unlayered playbook gets bands DERIVED from dependency depth,
//      labelled 'derived'.
//   2. A gate's result is the last REAL evaluation, with its time, or `not-run`:
//        · before anything ran a gate        → not-run
//        · after `pb plan --check-gates`     → STILL not-run (a dry run writes nothing)
//        · after `pb next --claim`           → pass / fail with `at`
//        · after the gate command is edited  → not-run (the old result is about a
//                                               different command)
//      and `pb graph` itself never executes a gate (the gate writes a marker if run).
//   3. live — true only while a claim is held AND the journal moved within 15 minutes:
//      a quiet claim, a recent row on an unclaimed task, and a done task are all false.
// ----------------------------------------------------------------------------
import { existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, makeSuite, pbJson, runPb } from './test-fixture-playbook.mjs';

const t = makeSuite('test-graph-layers-live');
const { ok } = t;
const MARK = 'GATE-L1-RAN';
const PASS_GATE = 'node -e "process.exit(0)"';
const FAIL_GATE = `node -e "require('fs').writeFileSync('${MARK}','x');process.exit(1)"`;

// ---------------------------------------------------------------------------- 1, 2
{
  const root = t.track(makeFixture({
    layers: [
      { id: 'L0', name: 'substrate', about: 'the engine', gate: PASS_GATE },
      { id: 'L1', name: 'surfaces', about: 'what people see', gate: FAIL_GATE, human: true },
      { id: 'L2', name: 'orchestration' },
    ],
    tasks: [
      { id: 'base', title: 'the base', layer: 'L0', priority: 1 },
      { id: 'face', title: 'the face', layer: 'L1', dependencies: ['base'], priority: 2 },
    ],
  }));
  const results = join(root, 'memory/gate-results.json');

  let g = pbJson(root, ['graph', '--json']);
  ok('layers[] has one entry per declared layer, in order', Array.isArray(g.layers) && g.layers.map((l) => l.id).join() === 'L0,L1,L2', JSON.stringify(g.layers));
  const l1 = g.layers.find((l) => l.id === 'L1') || {};
  ok('a declared layer carries name, about, gate, human, position and source', l1.name === 'surfaces' && l1.about === 'what people see'
    && l1.gate === FAIL_GATE && l1.human === true && l1.position === 1 && l1.source === 'declared', JSON.stringify(l1));
  ok('a layer lists its member tasks', JSON.stringify(g.layers[0].tasks) === '["base"]' && JSON.stringify(l1.tasks) === '["face"]', JSON.stringify(g.layers));
  ok('before any gate ran, every gated layer says not-run', g.layers[0].gate_result.state === 'not-run' && l1.gate_result.state === 'not-run', JSON.stringify(g.layers.map((l) => l.gate_result)));
  ok('a layer without a gate says no-gate', g.layers[2].gate_result.state === 'no-gate', JSON.stringify(g.layers[2]));
  ok('pb graph never executes a gate command', !existsSync(join(root, MARK)));

  const dry = runPb(root, ['plan', '--layers', '--check-gates']);
  ok('the dry run DID evaluate the gates (the marker proves it)', existsSync(join(root, MARK)), dry.combined.slice(0, 400));
  rmSync(join(root, MARK), { force: true });
  g = pbJson(root, ['graph', '--json']);
  ok('a dry run writes no gate result', !existsSync(results) && g.layers[0].gate_result.state === 'not-run', JSON.stringify(g.layers[0].gate_result));

  const claim = runPb(root, ['next', '--claim'], { agent: 'lead' });
  ok('the claim succeeds', claim.code === 0, claim.combined.slice(0, 600));
  rmSync(join(root, MARK), { force: true });
  g = pbJson(root, ['graph', '--json']);
  const r0 = g.layers[0].gate_result;
  const r1 = g.layers[1].gate_result;
  ok('after a claim, a passing gate says pass with the time it ran', r0.state === 'pass' && !Number.isNaN(Date.parse(r0.at)), JSON.stringify(r0));
  ok('after a claim, a failing gate says fail with the time it ran', r1.state === 'fail' && !Number.isNaN(Date.parse(r1.at)), JSON.stringify(r1));
  ok('reading the recorded result did not run the gate again', !existsSync(join(root, MARK)));

  // the gate command changes: the recorded result describes a different command
  const pbYaml = join(root, 'playbook.yaml');
  writeFileSync(pbYaml, readFileSync(pbYaml, 'utf8').replace(JSON.stringify(PASS_GATE), JSON.stringify('node -e "process.exit(0)" --')));
  g = pbJson(root, ['graph', '--json']);
  ok('an edited gate command reads as not-run, never as the old result', g.layers[0].gate_result.state === 'not-run'
    && /changed/.test(g.layers[0].gate_result.reason || ''), JSON.stringify(g.layers[0].gate_result));

  // ------------------------------------------------------------------------- 3
  const base = g.nodes.find((n) => n.id === 'base');
  const face = g.nodes.find((n) => n.id === 'face');
  ok('a task claimed just now is live', base?.live === true && base.live_detail.window_s === 900, JSON.stringify(base?.live_detail));
  ok('an unclaimed task is not live', face?.live === false && /no claim/.test(face.live_detail.why), JSON.stringify(face?.live_detail));
}

// ---------------------------------------------------------------------------- 3 (time)
{
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();
  const row = (task, seq, ms, action = 'execute', status = 'in_progress') => ({
    ts: iso(ms), loop_id: 'loop-fix-001', task, agent: 'lead', agent_id: 'lead', action, status, checks: 'none', notes: 'fixture', seq,
  });
  const claimed = (task, ms) => ({ status: 'in_progress', claimed_by: 'lead', agent_id: 'lead', seq: 1, loop_id: 'loop-fix-001', updated_at: iso(ms) });
  const root = t.track(makeFixture({
    tasks: [{ id: 'quiet' }, { id: 'busy' }, { id: 'edge' }, { id: 'finished' }, { id: 'loose', dependencies: ['finished'] }],
    journal: [
      row('quiet', 1, 60 * 60 * 1000), row('busy', 2, 60 * 1000), row('edge', 3, 16 * 60 * 1000),
      row('finished', 4, 30 * 1000, 'execute', 'done'), row('loose', 5, 30 * 1000, 'comment', 'todo'),
    ],
    state: {
      quiet: claimed('quiet', 60 * 60 * 1000), busy: claimed('busy', 60 * 1000), edge: claimed('edge', 16 * 60 * 1000),
      finished: { status: 'done', seq: 4, updated_at: iso(30 * 1000) },
    },
  }));
  const g = pbJson(root, ['graph', '--json']);
  const n = (id) => g.nodes.find((x) => x.id === id) || {};
  ok('a held claim whose journal moved a minute ago is live', n('busy').live === true, JSON.stringify(n('busy').live_detail));
  ok('a held claim whose journal is an hour old is NOT live', n('quiet').live === false && /quiet/.test(n('quiet').live_detail.why), JSON.stringify(n('quiet').live_detail));
  ok('just past the 15-minute window is NOT live', n('edge').live === false, JSON.stringify(n('edge').live_detail));
  ok('a done task with a fresh row is NOT live', n('finished').live === false, JSON.stringify(n('finished').live_detail));
  ok('an unclaimed task with a fresh comment is NOT live', n('loose').live === false, JSON.stringify(n('loose').live_detail));

  // ------------------------------------------------------------------------ 1 (derived)
  ok('an unlayered playbook gets bands derived from dependency depth', Array.isArray(g.layers) && g.layers.length === 2
    && g.layers.every((l) => l.source === 'derived') && g.layers[1].tasks.includes('loose') && !g.layers[0].tasks.includes('loose'), JSON.stringify(g.layers));
  ok('a derived band has no gate and says so', g.layers.every((l) => l.gate === null && l.gate_result.state === 'no-gate'));
}

t.finish();
