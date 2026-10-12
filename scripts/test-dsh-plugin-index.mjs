#!/usr/bin/env node
// scripts/test-dsh-plugin-index.mjs
// ----------------------------------------------------------------------------
// Integration test for the plugin ENTRY (index.js), driven with a stub ctx.
//
// This is the test that would have caught the two mistakes that are easy to make
// in a harness plugin and invisible in review:
//   - registering a tool whose `execute` never actually runs a command;
//   - staging context through an API the harness does not have.
// It loads the real module, calls `apply` with a fake ctx that captures the
// registered tool, and EXECUTES that tool against a real playbook on disk. The
// harness packages (@deepseek-ai/dsh-tools, dsh-llm, schemastery) are the real ones.
//
// It does not need a running agent: the plugin's own contract is that it talks to
// the engine through subprocesses and to the harness through tools/ctx.
// ----------------------------------------------------------------------------

import { mkdirSync, mkdtempSync, copyFileSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempDir, copyModules } from './lib/test-temp.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// --- a real playbook to operate on -------------------------------------------
const root = tempDir('pbplugidx-');
for (const d of ['scripts', 'memory', 'modes', 'processes', 'skills/run-task', 'artifacts/reports']) {
  mkdirSync(join(root, d), { recursive: true });
}
copyFileSync(resolve('scripts/pb.mjs'), join(root, 'scripts/pb.mjs'));
copyModules(resolve('node_modules'), join(root, 'node_modules'));
// A COMPLETE playbook: `validate --task` (action=check) validates the whole book, so a
// partial fixture would make the check action fail for reasons unrelated to the plugin.
writeFileSync(join(root, 'SKILL.md'), '---\nname: t\ndescription: t\n---\n');
writeFileSync(join(root, 'memory/project-memory.md'), '# memory\n');
writeFileSync(join(root, 'processes/index.yaml'), 'processes:\n  - id: run-task\n    file: processes/run-task.yaml\n');
writeFileSync(join(root, 'processes/run-task.yaml'), 'id: run-task\n');
writeFileSync(join(root, 'skills/index.yaml'), 'skills:\n  - id: run-task\n    file: skills/run-task/SKILL.md\n    process: run-task\n');
writeFileSync(join(root, 'skills/run-task/SKILL.md'), '---\nname: run-task\ndescription: t\n---\n');
writeFileSync(join(root, 'playbook.yaml'),
  'name: plugin-idx-test\nversion: 0.3.6\nentry: SKILL.md\n' +
  'paths:\n  scripts: scripts\n  processes: processes\n  skills: skills\n  memory: memory\n  artifacts: artifacts\n  reports: artifacts/reports\n' +
  'index:\n  processes_index: processes/index.yaml\n  skills_index: skills/index.yaml\n  cli: scripts/pb.mjs\n  memory:\n    project_memory: memory/project-memory.md\n    backlog: memory/backlog.yaml\n    journal: memory/journal.ndjson\n    loops: memory/loops.yaml\n    cycle: memory/cycle.md\n' +
  'loop:\n  description: test\n  steps:\n    - id: orient\n      do: orient\n      command: node scripts/pb.mjs status\n' +
  'default_mode: coding\nmodes:\n  coding: modes/coding.yaml\n' +
  'guardrails:\n  allowed_statuses: [todo, in_progress, blocked, done]\n');
writeFileSync(join(root, 'modes/coding.yaml'), 'id: coding\ndirective: ""\n');
writeFileSync(join(root, 'memory/journal.ndjson'), '');
writeFileSync(join(root, 'memory/loops.yaml'), 'active: L1\nloops:\n  - {id: L1, status: active}\n');
writeFileSync(join(root, 'memory/cycle.md'),
  '# c\n## 1. What is this cycle\'s goal?\nPlugin test\n## 2. What challenges do I foresee?\nNone\n' +
  '## 3. What were the previous challenges?\nNone\n## 4. Where do I stop?\nDone\n## 5. Do I have any conflicting memory?\nNone\n');
// PT2 stays todo for the whole run, so the context hook always has actionable work
// (with quietWhenIdle the plugin would correctly stay silent on an empty backlog).
writeFileSync(join(root, 'memory/backlog.yaml'),
  'tasks:\n' +
  '  - {id: PT1, title: plugin task, status: todo, priority: 1, skill: run-task, acceptance_checks: [node -e "process.exit(0)"]}\n' +
  '  - {id: PT2, title: stays queued, status: todo, priority: 2}\n');
execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: root });
execFileSync('git', ['config', 'user.name', 'T'], { cwd: root });
writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
execFileSync('git', ['add', '.'], { cwd: root });
execFileSync('git', ['commit', '-m', 'seed'], { cwd: root, stdio: 'ignore' });

const readState = () => { try { return JSON.parse(readFileSync(join(root, 'memory/backlog-state.json'), 'utf8')); } catch { return {}; } };
const readJournal = () => readFileSync(join(root, 'memory/journal.ndjson'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

// --- drive the real plugin entry with a stub ctx ------------------------------
// The plugin's peer dependencies are the harness packages. They are absent in a
// plain engine checkout (the plugin is published separately), so probe first and
// SKIP honestly rather than reporting a failure the repo cannot fix. Any harness
// checkout path can be supplied via DSH_PACKAGES.
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
  console.log('\ntest-dsh-plugin-index: skipped (0 pass, 0 fail)');
  process.exit(0);
}
// The driver runs from the temp fixture, so make the harness packages resolvable
// there by linking them into its node_modules (this is also a small proof that the
// plugin's declared peer dependencies are exactly what it imports).
{
  const nm = join(root, 'node_modules', '@deepseek-ai');
  mkdirSync(nm, { recursive: true });
  for (const pkg of ['dsh-tools', 'dsh-llm', 'schemastery', 'cordis']) {
    const from = join(harness, pkg);
    if (existsSync(from)) { try { symlinkSync(from, join(nm, pkg), 'junction'); } catch { /* already linked */ } }
  }
}

const driver = `
const plugin = await import(${JSON.stringify(new URL('../dsh-plugin/index.js', import.meta.url).href)});
const registered = [];
const inbox = [];
const providers = [];
// Model the REAL cordis contract, not a convenient one: ctx.inject(keys, cb) grants
// access through a scoped context and the callback fires only once those services exist.
// A stub that just called the callback synchronously would hide the very failure this
// arrangement exists to avoid (a plugin silently inactive because a declared service was
// absent) — so this stub defers until provide() is called.
const services = { tools: { register: (t) => registered.push(t) } };
const pendingInjections = [];
const ctx = {
  get tools() { return services.tools; },
  get skills() { return services.skills; },
  inject(keys, cb) {
    const ready = keys.every((k) => services[k]);
    if (ready) cb(ctx);
    else pendingInjections.push({ keys, cb });
  },
  provide(name, value) {
    services[name] = value;
    for (const p of [...pendingInjections]) {
      if (p.keys.every((k) => services[k])) { p.cb(ctx); pendingInjections.splice(pendingInjections.indexOf(p), 1); }
    }
  },
  on: (event, handler) => { ctx.__hooks = ctx.__hooks || {}; ctx.__hooks[event] = handler; },
  logger: { warn: (...a) => console.error('WARN', ...a) },
};
plugin.apply(ctx, { playbookPath: process.env.PB_ROOT, injectContext: true, quietWhenIdle: false });
// The plugin must be ACTIVE with only the tool registry present — that is the whole point
// of declaring the skill registry as a runtime dependency rather than a hard one.
const out = {};
out.exportedInject = plugin.inject;
out.toolRegisteredWithSkillsAbsent = registered.length > 0;
out.providersBeforeSkills = providers.length;
out.pendingInjectionsBeforeSkills = pendingInjections.length;
// Now provide the skill registry, as a profile that mounts it would.
ctx.provide('skills', { registerProvider: (p) => providers.push(p) });
out.providersAfterSkills = providers.length;
const tool = registered[0];
// steer() is how a turn-stopping handler keeps a turn open, so capturing it is the only way
// to observe the Stop gate from outside.
const steers = [];
const agent = { id: 'agent-1', session: { id: 'sess-1', cwd: process.env.PB_ROOT }, steer: (m) => steers.push(m) };
const fireStopGate = async () => {
  const hook = ctx.__hooks && ctx.__hooks['agent/turn-stopping'];
  if (typeof hook !== 'function') return;
  await hook({ agent, turn: 1, signal: { aborted: false } });
};
const run = (args) => tool.execute(args, { agent });
out.toolName = tool.name;
out.hasExecute = typeof tool.execute === 'function';
out.status = await run({ action: 'status' });
out.task = await run({ action: 'task', task: 'PT1' });
out.claim = await run({ action: 'claim' });
// Snapshot the claim state IMMEDIATELY: later actions legitimately move the task to
// done, so asserting at the end would be asserting the wrong moment in time.
out.claimState = JSON.parse(
  (await import('node:fs')).readFileSync(process.env.PB_ROOT + '/memory/backlog-state.json', 'utf8'),
)[out.claim.task] ?? null;

// --- the Stop gate: an unresolved claim must hold the turn open ---------------
out.hasStopGate = typeof (ctx.__hooks && ctx.__hooks['agent/turn-stopping']) === 'function';
await fireStopGate();
out.steersWhileClaimed = steers.length;
out.steerNamesTheClaimedTask = /PT1|PT2/.test((steers[0] && steers[0].content && steers[0].content[0] && steers[0].content[0].text) || '');
// Far more important than the first steer: firing again must NOT steer again. A gate that
// re-blocks every time force-continues every step forever.
await fireStopGate();
out.steersAfterSecondFire = steers.length;
// An agent holding no claim is not gated at all.
const unclaimedSteers = [];
const unclaimed = { id: 'agent-2', session: { id: 'sess-2' }, steer: (m) => unclaimedSteers.push(m) };
if (out.hasStopGate) await ctx.__hooks['agent/turn-stopping']({ agent: unclaimed, turn: 1, signal: { aborted: false } });
out.steersFromUnclaimedAgent = unclaimedSteers.length;
out.check = await run({ action: 'check', task: 'PT1' });
out.done = await run({ action: 'record', task: 'PT1', status: 'done', notes: 'via plugin' });
// Resolving the claim must silence the gate.
await fireStopGate();
out.steersAfterRecord = steers.length;
out.bogus = await run({ action: 'not-an-action' });
out.workerNoTask = await run({ action: 'worker' });
// Register a provider? Then exercise it the way the harness would: list, pick one,
// load it. A provider that lists but cannot load is a half-built integration.
out.providerNames = providers.map((p) => p.name ?? null);
if (providers[0]) {
  const list = await providers[0].list({ cwd: process.env.PB_ROOT });
  out.skillList = list.map((s) => ({ name: s.name, provider: s.provider, hasLocator: !!s.locator, contentLeaked: 'content' in s }));
  const first = list.find((s) => s.locator && s.locator.id === 'run-task');
  if (first) {
    const full = await providers[0].get(first, { cwd: process.env.PB_ROOT });
    out.skillGet = full ? { name: full.name, hasBody: typeof full.content === 'string' && full.content.length > 0, provider: full.provider, resourceBase: full.resourceBase?.kind ?? null, path: !!full.path } : null;
  }
  out.skillGetMissing = await providers[0].get({ name: 'playbook-nope', locator: { id: 'nope', file: 'skills/nope/SKILL.md' } }, { cwd: process.env.PB_ROOT });
}
// Run the injected-context hook, if the plugin registered one.
if (ctx.__hooks && ctx.__hooks['agent/pre-step']) {
  // Two agents: one with the purpose-built inject(), one with only the older inbox
  // surface. Both must end up with the context staged — the plugin must not depend on the
  // newer member existing.
  const injected = [];
  const fakeAgentInject = { ...agent, inject: (m) => injected.push(m) };
  await ctx.__hooks['agent/pre-step'](
    { agent: fakeAgentInject, messages: [], signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }),
  );
  out.viaInject = injected.length;
  out.injectSource = injected[0]?.source?.kind ?? null;
  out.injectText = injected[0]?.content?.[0]?.text ?? null;

  const fakeAgent = {
    ...agent,
    inbox: { append: (target, msg) => inbox.push({ target, msg }) },
  };
  const decision = await ctx.__hooks['agent/pre-step'](
    { agent: fakeAgent, messages: [], signal: { aborted: false } },
    async () => ({ kind: 'enter', messages: [] }),
  );
  out.decisionKind = decision?.kind;
  out.inboxTarget = inbox[0]?.target ?? null;
  out.inboxText = inbox[0]?.msg?.content?.[0]?.text ?? null;
  out.inboxSource = inbox[0]?.msg?.source?.kind ?? null;

  // A rejected step must stay rejected: the hook observes, it does not override a veto.
  const rejected = await ctx.__hooks['agent/pre-step'](
    { agent: fakeAgentInject, messages: [], signal: { aborted: false } },
    async () => ({ kind: 'reject' }),
  );
  out.rejectedPassthrough = rejected?.kind;

  // An aborted step must not stage context (its batch is being torn down).
  const beforeAbort = injected.length;
  await ctx.__hooks['agent/pre-step'](
    { agent: fakeAgentInject, messages: [], signal: { aborted: true } },
    async () => ({ kind: 'enter', messages: [] }),
  );
  out.abortedStaged = injected.length - beforeAbort;
}
console.log('__RESULT__' + JSON.stringify(out));
`;

const driverPath = join(root, 'driver.mjs');
writeFileSync(driverPath, driver);
const r = spawnSync(process.execPath, [driverPath], {
  cwd: root, encoding: 'utf8', env: { ...process.env, PB_ROOT: root }, timeout: 180_000,
});
const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
let out = {};
if (line) { try { out = JSON.parse(line.slice('__RESULT__'.length)); } catch { /* reported below */ } }

ok('the real plugin entry loads and registers a tool', !!out.toolName, `exit=${r.status}\n${r.stdout}\n${r.stderr}`);
ok('the registered tool is named `playbook`', out.toolName === 'playbook', String(out.toolName));
ok('the tool exposes an executable handler', out.hasExecute === true);

// --- the tool actually operates the engine ------------------------------------
ok('action=status returns the engine status payload',
  out.status?.ok === true && out.status.status?.schema === 'agent-playbook.status.v1',
  JSON.stringify(out.status)?.slice(0, 300));
ok('action=task returns the task projection with its checks',
  out.task?.ok === true && out.task.task?.task?.id === 'PT1' && Array.isArray(out.task.task.acceptance_checks),
  JSON.stringify(out.task)?.slice(0, 300));
ok('action=claim claims a task and captures the claim token',
  out.claim?.ok === true && ['PT1', 'PT2'].includes(out.claim.task)
    && typeof out.claim.claim_token === 'string' && out.claim.claim_token.length > 8,
  JSON.stringify(out.claim)?.slice(0, 300));
{
  // The claim must land in the projection under the PLUGIN's identity — not under a
  // default agent, which is the difference between attributable fan-out and a
  // write nobody can trace. (Snapshot taken at claim time by the driver.)
  const snap = out.claimState;
  ok('the claim is persisted with the plugin\'s agent identity',
    snap?.status === 'in_progress' && snap?.claimed_by === 'agent-1' && typeof snap?.claim_token === 'string',
    `claimedId=${out.claim?.task} snapshot=${JSON.stringify(snap)}`);
}
ok('action=check runs the task acceptance checks', out.check?.ok === true, JSON.stringify(out.check)?.slice(0, 300));

// --- the Stop gate -----------------------------------------------------------
// The harness contract is pinned by scripts/test-dsh-stop-gate.mjs; these check that THIS
// plugin uses it correctly and, above all, timidly.
ok('the plugin registers an agent/turn-stopping handler (the gate exists at all)',
  out.hasStopGate === true, `hasStopGate=${out.hasStopGate}`);
ok('a turn ending with an unresolved claim is held open (a steer is issued)',
  out.steersWhileClaimed === 1, `steers=${out.steersWhileClaimed}`);
ok('the steer names the claimed task, so the model knows what to resolve',
  out.steerNamesTheClaimedTask === true);
ok('the gate nudges ONCE per claim and never nags (a second fire does NOT steer)',
  out.steersAfterSecondFire === 1, `steers after second fire=${out.steersAfterSecondFire}`);
ok('an agent holding no claim is never steered',
  out.steersFromUnclaimedAgent === 0, `steers=${out.steersFromUnclaimedAgent}`);
ok('action=record status=done is accepted when the checks pass', out.done?.ok === true,
  JSON.stringify(out.done)?.slice(0, 400));
{
  const rows = readJournal();
  const doneRow = rows.filter((x) => x.status === 'done').at(-1);
  ok('the done row is attributed to the plugin agent, not a default', doneRow?.agent === 'agent-1', JSON.stringify(doneRow));
  ok('the done row proves checks ran (not skipped)', doneRow?.checks === 'passed', JSON.stringify(doneRow));
  ok('the done row carries the delegation provenance the plugin stamped',
    doneRow?.origin_runtime === 'dsh' && doneRow?.origin_session_id === 'sess-1', JSON.stringify(doneRow));
  const st = readState();
  ok('the task ends done in the projection', st.PT1?.status === 'done', JSON.stringify(st.PT1));
}
ok('the gate goes quiet once the claim is resolved (no steer after a done record)',
  out.steersAfterRecord === 1, `steers after record=${out.steersAfterRecord}`);
ok('an unknown action is a clean error, not a crash',
  out.bogus?.ok === false && /unknown action/.test(out.bogus.error || ''), JSON.stringify(out.bogus));
ok('a missing task id is a clean error', out.workerNoTask?.ok === false, JSON.stringify(out.workerNoTask));

ok('the plugin declares only the tool registry as a HARD dependency',
  Array.isArray(out.exportedInject) && out.exportedInject.length === 1 && out.exportedInject[0] === 'tools',
  JSON.stringify(out.exportedInject));
ok('the plugin is ACTIVE with the skill registry ABSENT (the tool still registers)',
  out.toolRegisteredWithSkillsAbsent === true && out.providersBeforeSkills === 0,
  `tool=${out.toolRegisteredWithSkillsAbsent} providers=${out.providersBeforeSkills}`);
ok('the skill registration is DEFERRED, not dropped (a pending injection exists)',
  out.pendingInjectionsBeforeSkills >= 1, String(out.pendingInjectionsBeforeSkills));
ok('the provider registers once the skill registry appears',
  out.providersAfterSkills === 1, `providers=${out.providersAfterSkills}`);

// --- the skill provider exposes the playbook's own skills --------------------
ok('the plugin registers exactly one skill provider, named for its origin',
  Array.isArray(out.providerNames) && out.providerNames.length === 1 && out.providerNames[0] === 'agent-playbook',
  JSON.stringify(out.providerNames));
{
  const list = out.skillList || [];
  ok('the provider lists the playbook\'s skills', list.length >= 1, JSON.stringify(list));
  ok('every skill is namespaced so it cannot shadow a harness skill',
    list.every((s) => s.name.startsWith('playbook-')), JSON.stringify(list.map((s) => s.name)));
  ok('every candidate carries a locator (the provider\'s handle for loading)',
    list.every((s) => s.hasLocator), JSON.stringify(list));
  ok('catalog entries carry no body (bodies load on demand, not on discovery)',
    list.every((s) => s.contentLeaked === false), JSON.stringify(list));
  ok('the provider is labelled as the owning source', list.every((s) => s.provider === 'agent-playbook'), JSON.stringify(list));
}
ok('loading a listed skill returns its body, path and resource base',
  out.skillGet?.hasBody === true && out.skillGet?.path === true && out.skillGet?.resourceBase === 'directory',
  JSON.stringify(out.skillGet));
ok('the loaded body names the skill and its canonical process',
  typeof out.skillGet?.name === 'string' && out.skillGet.name === 'playbook-run-task', JSON.stringify(out.skillGet));
ok('loading a skill whose file is gone returns undefined rather than throwing',
  out.skillGetMissing === undefined || out.skillGetMissing === null, JSON.stringify(out.skillGetMissing));

// --- the injected context reaches the inbox ----------------------------------
if (out.inboxText === null || out.inboxText === undefined) {
  ok('the plugin registers an agent/pre-step hook', false, `driver output: ${r.stdout}\n${r.stderr}`);
} else {
  ok('context is staged on the NEXT-STEP inbox (survives compaction)', out.inboxTarget === 'next-step', String(out.inboxTarget));
  ok('the staged message is source-labelled so the harness can identify it',
    out.inboxSource === 'agent-playbook', String(out.inboxSource));
  ok('the staged block names the playbook', /plugin-idx-test/.test(out.inboxText), out.inboxText.slice(0, 200));
  ok('the staged block states the enforcement rule', /"done" is an exit code/.test(out.inboxText), out.inboxText.slice(0, 400));
  ok('the pre-step hook lets the step continue rather than blocking it',
    out.decisionKind === 'enter' || out.decisionKind === undefined, String(out.decisionKind));

  // --- the newer inject() path, and the observer contract --------------------
  ok('context uses the purpose-built agent.inject() when it exists',
    out.viaInject === 1 && out.injectSource === 'agent-playbook', `viaInject=${out.viaInject} src=${out.injectSource}`);
  ok('the inject() path carries the same block as the fallback path',
    typeof out.injectText === 'string' && /plugin-idx-test/.test(out.injectText), String(out.injectText).slice(0, 200));
  ok('a REJECTED step stays rejected (the hook observes, it does not override a veto)',
    out.rejectedPassthrough === 'reject', String(out.rejectedPassthrough));
  ok('an ABORTED step stages no context (its batch is being torn down)',
    out.abortedStaged === 0, String(out.abortedStaged));
}

// --- 7. the registration path runs on a REAL cordis context -------------------
// The stub above models the contract; this runs the plugin's ACTUAL `apply()` on the real
// cordis package. That is what catches a registration path that only works against a
// convenient fake — here, that the tool registers and that the runtime-declared skill
// dependency is honored by the real DI layer rather than by our stub's generosity.
{
  const harness = harnessDir();
  const cordisEntry = harness
    ? join(harness, 'cordis', 'lib', 'index.js')
    : 'C:/Users/RH/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/cordis/lib/index.js';
  if (!existsSync(cordisEntry)) {
    console.log('  SKIP  cordis unavailable — real-DI assertions skipped');
  } else {
    const probe = `
      const cordis = await import(${JSON.stringify(`file:///${cordisEntry.replace(/\\/g, '/')}`)});
      const plugin = await import(${JSON.stringify(new URL('../dsh-plugin/index.js', import.meta.url).href)});
      const out = { inject: plugin.inject };
      const tools = [];
      const ctx = new cordis.Context();
      ctx.provide('tools', { register: (t) => tools.push(t) });
      ctx.plugin({ name: 'agent-playbook-probe', inject: plugin.inject, apply: (c) => plugin.apply(c, { playbookPath: process.env.PB_ROOT }) });
      await new Promise((r) => setTimeout(r, 500));
      out.toolsRegisteredWithoutSkills = tools.length;
      out.toolName = tools[0]?.name ?? null;
      const providers = [];
      ctx.provide('skills', { registerProvider: (p) => providers.push(p) });
      await new Promise((r) => setTimeout(r, 500));
      out.providersAfterSkills = providers.length;
      out.providerName = providers[0]?.name ?? null;
      console.log('__REAL__' + JSON.stringify(out));
    `;
    const probePath = join(root, 'real-di.mjs');
    writeFileSync(probePath, probe);
    const r = spawnSync(process.execPath, [probePath], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PB_ROOT: root }, timeout: 180_000,
    });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__REAL__'));
    let real = {};
    try { real = JSON.parse(line.slice('__REAL__'.length)); } catch { /* reported below */ }
    ok('the plugin registers its tool on a REAL cordis context (no stub involved)',
      real.toolsRegisteredWithoutSkills === 1 && real.toolName === 'playbook',
      `${JSON.stringify(real)}\n${r.stderr}`.slice(0, 500));
    ok('the skill registry stays a runtime dependency on the real DI layer',
      real.providersAfterSkills === 1 && real.providerName === 'agent-playbook',
      JSON.stringify(real));
  }
}

// --- 8. the Config schema actually works -------------------------------------
// Cordis validates and normalizes a plugin's config through its exported `Config` before
// `apply` runs, so a schema that is merely decorative would silently accept nonsense or
// drop documented defaults. Assert it parses, defaults, and rejects.
{
  const harness = harnessDir();
  if (!harness) {
    console.log('  SKIP  harness packages unavailable — Config assertions skipped');
  } else {
    const probe = `
      const plugin = await import(${JSON.stringify(new URL('../dsh-plugin/index.js', import.meta.url).href)});
      const out = { hasConfig: !!plugin.Config, isSchema: typeof plugin.Config === 'function' };
      try {
        const parsed = plugin.Config({});
        out.emptyInput = JSON.parse(JSON.stringify(parsed));
      } catch (e) { out.emptyError = String(e.message).slice(0, 200); }
      try {
        const parsed = plugin.Config({ maxContextChars: 1234, playbookPath: '/somewhere' });
        out.overrides = { maxContextChars: parsed.maxContextChars, playbookPath: parsed.playbookPath,
          quietWhenIdle: parsed.quietWhenIdle, playbookDir: parsed.playbookDir };
      } catch (e) { out.overrideError = String(e.message).slice(0, 200); }
      try {
        plugin.Config({ maxContextChars: 'not-a-number' });
        out.badAccepted = true;
      } catch { out.badAccepted = false; }
      console.log('__CFG__' + JSON.stringify(out));
    `;
    const probePath = join(root, 'config-probe.mjs');
    writeFileSync(probePath, probe);
    const r = spawnSync(process.execPath, [probePath], {
      cwd: root, encoding: 'utf8', env: { ...process.env, PB_ROOT: root }, timeout: 120_000,
    });
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__CFG__'));
    let cfg = {};
    try { cfg = JSON.parse(line.slice('__CFG__'.length)); } catch { /* reported below */ }
    ok('the plugin exports a Config schema the harness can validate with', cfg.hasConfig === true && cfg.isSchema === true,
      JSON.stringify(cfg) + (r.stderr || '').slice(0, 200));
    ok('an empty config is accepted and filled with the documented defaults',
      cfg.emptyInput?.playbookPath === '' && cfg.emptyInput?.injectContext === true
      && cfg.emptyInput?.quietWhenIdle === true && cfg.emptyInput?.maxContextChars === 4000,
      JSON.stringify(cfg.emptyInput));
    ok('explicit values pass through the schema unchanged',
      cfg.overrides?.maxContextChars === 1234 && cfg.overrides?.playbookPath === '/somewhere',
      JSON.stringify(cfg.overrides));
    ok('a wrong-typed value is REJECTED, not silently coerced',
      cfg.badAccepted === false, String(cfg.badAccepted));
    // The manual merge in apply() must agree with the schema, or the documented defaults
    // and the effective defaults would diverge.
    ok('the schema\'s defaults match the values apply() falls back to (one source of truth)',
      cfg.emptyInput?.playbookDir === '.agents-playbook' && cfg.emptyInput?.commandTimeoutMs === 120000,
      JSON.stringify(cfg.emptyInput));
  }
}

console.log(`\ntest-dsh-plugin-index: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);

