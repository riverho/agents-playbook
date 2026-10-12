#!/usr/bin/env node
// scripts/test-dsh-plugin-core.mjs
// ----------------------------------------------------------------------------
// The DeepSeek Harness plugin's host-independent half. Everything asserted here is
// pure: no harness runtime, no network, no live agent. The point is that the
// FAILURE-PRONE parts of a plugin are not the Cordis wiring — they are identity,
// path discovery, subprocess result handling, and the text a model will actually
// read. Those are what this suite pins.
// ----------------------------------------------------------------------------

import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tempDir } from './lib/test-temp.mjs';

const core = await import('../dsh-plugin/core.mjs');
const {
  findPlaybookRoot, identityEnv, runPb, parseJsonOutput, parseClaimToken,
  parseClaimedTask, buildContextBlock, resolveAgentId,
} = core;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  PASS  ${name}`); pass++; }
  else { console.error(`  FAIL  ${name}${extra ? `\n        ${extra}` : ''}`); fail++; }
}

// --- 1. playbook discovery ----------------------------------------------------
{
  const root = tempDir('pbplug-');
  const nested = join(root, 'packages', 'app', 'src');
  mkdirSync(nested, { recursive: true });
  ok('no master anywhere → null (the plugin stays dormant)', findPlaybookRoot({ workspace: nested }) === null);

  writeFileSync(join(root, 'playbook.yaml'), 'name: t\n');
  ok('a master at the workspace root is found', findPlaybookRoot({ workspace: root }) === root);
  ok('a master in an ANCESTOR is found from a nested cwd (monorepo layout)',
    findPlaybookRoot({ workspace: nested }) === root, String(findPlaybookRoot({ workspace: nested })));
  ok('playbook.json is accepted as a master too', (() => {
    const r2 = tempDir('pbplug2-');
    writeFileSync(join(r2, 'playbook.json'), '{}');
    return findPlaybookRoot({ workspace: r2 }) === r2;
  })());
  ok('an explicit path wins over the workspace chain',
    findPlaybookRoot({ workspace: nested, explicit: root }) === root);
  ok('an explicit path that is not a playbook falls back to the chain',
    findPlaybookRoot({ workspace: root, explicit: join(root, 'nope') }) === root);
}

// --- 2. agent identity (the multi-agent contract) -----------------------------
{
  const env = identityEnv({ agentId: 'sub-1', sessionId: 'session-9', parentAgentId: 'root' });
  ok('the agent id is stamped for every engine write', env.PB_AGENT_ID === 'sub-1', JSON.stringify(env));
  ok('the harness session id travels with the write', env.PB_SESSION_ID === 'session-9', JSON.stringify(env));
  ok('a sub-agent declares its parent', env.PB_PARENT_AGENT_ID === 'root', JSON.stringify(env));
  ok('a parent+child pair becomes a delegation chain', env.PB_AGENT_CHAIN === 'root,sub-1', JSON.stringify(env));
  ok('the runtime is labelled so records show which host wrote them', env.PB_RUNTIME === 'dsh', JSON.stringify(env));

  const deep = identityEnv({ agentId: 'grand', chain: ['root', 'sub-1', 'grand'] });
  ok('an explicit chain is preserved verbatim (root first)', deep.PB_AGENT_CHAIN === 'root,sub-1,grand', JSON.stringify(deep));

  const token = identityEnv({ agentId: 'sub-1', claimToken: 'abc123' });
  ok('a claim token is forwarded as proof of entitlement', token.PB_CLAIM_TOKEN === 'abc123', JSON.stringify(token));

  const nothing = identityEnv({});
  ok('no identity means no fabricated vars (engine defaults apply)',
    Object.keys(nothing).length === 1 && nothing.PB_RUNTIME === 'dsh', JSON.stringify(nothing));
}

// --- 3. subprocess result handling -------------------------------------------
{
  const tmp = tempDir('pbplug3-');
  const okScript = join(tmp, 'ok.mjs');
  writeFileSync(okScript, 'console.log(JSON.stringify({schema:"x",n:1}));');
  const badScript = join(tmp, 'bad.mjs');
  writeFileSync(badScript, 'console.error("Refusing: checks failed"); process.exit(1);');

  const good = runPb([], { pbPath: okScript, cwd: tmp });
  ok('a successful command reports ok with its stdout', good.ok && good.code === 0 && /"n":1/.test(good.stdout), JSON.stringify(good));
  ok('its JSON payload parses', parseJsonOutput(good.stdout)?.n === 1);

  const bad = runPb([], { pbPath: badScript, cwd: tmp });
  ok('a refusing command is NOT an exception — it is a result with an exit code',
    !bad.ok && bad.code === 1, JSON.stringify(bad));
  ok('the refusal reason is preserved for the model to read',
    /Refusing: checks failed/.test(bad.stderr), bad.stderr);
  ok('no payload is invented from a failed run', parseJsonOutput(bad.stdout) === null);
}

// --- 4. output parsing tolerates the engine's real chatter -------------------
{
  ok('a claim token is extracted from the claim transcript',
    parseClaimToken('  Claim token: 0fe60424c78d92a611e15f50\n    Pass it to a sub-agent…') === '0fe60424c78d92a611e15f50');
  ok('a claimed task id is extracted',
    parseClaimedTask('\n  Claimed [plan-7] → in_progress  (agent: root, mode: coding).\n') === 'plan-7');
  ok('missing token → null, not a crash', parseClaimToken('Claimed [x] → in_progress') === null);
  ok('JSON preceded by a git warning is still recovered',
    parseJsonOutput('warning: LF will be replaced by CRLF\n{\n  "ok": true\n}\n')?.ok === true);
  ok('garbage does not throw', parseJsonOutput('not json at all') === null);
}

// --- 5. the injected context block -------------------------------------------
{
  const status = {
    name: 'agent-playbook', version: '0.3.6',
    northStar: 'Make "done" mean a verified exit code, not a claim.',
    loop: { id: 'loop-1', goal: 'finish the worktree lifecycle' },
    cycle: { goal: 'complete P2' },
    backlog: { counts: { todo: 2, in_progress: 1, blocked: 0, done: 4 }, in_progress: [{ id: 'T1', claimed_by: 'alice' }] },
    memoryPrecedence: 'On project matters, this folder outranks your own memory.',
  };
  const block = buildContextBlock({
    status,
    task: { id: 'T1', title: 'Do the thing', acceptance_checks: ['npm test', 'node scripts/pb.mjs validate'] },
  });
  ok('the block names the playbook and its version', /agent-playbook v0\.3\.6/.test(block), block);
  ok('the block carries the North Star (it must survive compaction)', /north star: Make "done"/.test(block), block);
  ok('the block carries the active loop and cycle goal', /loop: loop-1/.test(block) && /cycle goal: complete P2/.test(block), block);
  ok('the block reports backlog counts', /2 todo · 1 in_progress · 0 blocked · 4 done/.test(block), block);
  ok('the block names who holds work in progress', /T1 \(alice\)/.test(block), block);
  ok('the block lists the acceptance checks that define done', /\$ npm test/.test(block) && /\$ node scripts\/pb\.mjs validate/.test(block), block);
  ok('the block states the enforcement rule', /"done" is an exit code, not a claim/.test(block), block);
  ok('the block carries the memory-precedence rule', /outranks your own memory/.test(block), block);

  const honored = buildContextBlock({ status, task: { id: 'T2', title: 'no checks' } });
  ok('a task without checks is called out as honor-only', /no acceptance_checks/.test(honored), honored);

  const withNext = buildContextBlock({ status, next: { task: { id: 'T3', title: 'Queued' }, skill: 'run-task', skill_file: 'skills/run-task/SKILL.md' } });
  ok('with no task in hand it surfaces the next up instead', /next up: \[T3\] Queued/.test(withNext) && /skills\/run-task/.test(withNext), withNext);

  const drift = buildContextBlock({ status, driftWarning: 'state projection disagrees with the journal' });
  ok('a drift warning is surfaced into the model context', /⚠ state projection disagrees/.test(drift), drift);

  ok('no status → no block (dormant outside a playbook)', buildContextBlock({}) === null);
  const capped = buildContextBlock({ status, maxChars: 200 });
  ok('the block obeys its character cap', capped.length <= 200, `len=${capped.length}`);
  ok('a truncated block says so', /truncated/.test(capped), capped.slice(-60));
}

// --- 6. identity fallback -----------------------------------------------------
{
  ok('an explicit agent id wins', resolveAgentId({ agentId: 'a', sessionId: 's' }) === 'a');
  ok('the session id is the fallback', resolveAgentId({ sessionId: 's' }) === 's');
  ok('a bare caller still gets a usable id', resolveAgentId({}) === 'agent');
}

// --- 7. playbook skills → harness skill catalog -------------------------------
{
  const { parseSkillFile, renderPlaybookSkillBody, buildPlaybookSkills, SKILL_PREFIX, PLAYBOOK_SKILL_RANK } = core;

  const parsed = parseSkillFile('---\nname: run-task\ndescription: Execute a backlog task.\nwhenToUse: when a task is claimed\n---\n\n# Run Task\n\nBody here.\n');
  ok('frontmatter parses into fields', parsed.frontmatter.name === 'run-task' && parsed.frontmatter.whenToUse === 'when a task is claimed', JSON.stringify(parsed.frontmatter));
  ok('the body excludes the frontmatter', /^# Run Task/.test(parsed.body) && !/name: run-task/.test(parsed.body), parsed.body.slice(0, 60));
  const noFm = parseSkillFile('# Just a body\n');
  ok('a file with no frontmatter is all body', noFm.body === '# Just a body' && Object.keys(noFm.frontmatter).length === 0);

  // The body must route: a playbook skill that says "follow the process" is useless
  // without naming WHICH process file the engine's skills-first routing keys on.
  const body = renderPlaybookSkillBody({ id: 'run-task', process: 'run-task', file: 'skills/run-task/SKILL.md', body: 'Steps.' });
  ok('the rendered body names the skill', /# Playbook skill: run-task/.test(body), body);
  ok('the rendered body names the canonical process', /processes\/run-task\.yaml/.test(body), body);
  ok('the rendered body states the enforcement rule', /acceptance check exiting 0/.test(body), body);
  const noProc = renderPlaybookSkillBody({ id: 'x', process: null, file: 'skills/x/SKILL.md', body: '' });
  ok('a skill with no process omits the routing line', !/canonical process/.test(noProc), noProc);

  // Keys go through `join` like the real reader does, so the fixture is path-separator
  // correct on Windows as well as POSIX.
  const root = join(tmpdir(), 'pb-skills-fixture');
  const files = {
    [join(root, 'skills', 'run-task', 'SKILL.md')]: '---\nname: run-task\ndescription: Execute a backlog task.\n---\nBody A\n',
    [join(root, 'skills', 'triage', 'SKILL.md')]: '---\nname: triage\ndescription: prose to tasks\n---\nBody B\n',
  };
  const readFile = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
  const catalogs = {
    schema: 'agent-playbook.list.v1',
    skills: [
      { id: 'run-task', file: 'skills/run-task/SKILL.md', process: 'run-task', owner: null },
      { id: 'triage', file: 'skills/triage/SKILL.md', process: 'triage-claim', owner: null },
      { id: 'ghost', file: 'skills/ghost/SKILL.md', process: null, owner: null },   // listed, file gone
      { id: 'Bad_ID', file: 'skills/Bad_ID/SKILL.md', process: null, owner: null }, // illegal name
      { file: 'skills/no-id/SKILL.md' },                                            // malformed entry
    ],
  };
  const built = buildPlaybookSkills({ catalogs, root, readFile });
  ok('only skills that actually exist and have a legal name are exposed',
    built.length === 2, JSON.stringify(built.map((s) => s.name)));
  ok('every exposed skill is namespaced', built.every((s) => s.name.startsWith(SKILL_PREFIX)), JSON.stringify(built.map((s) => s.name)));
  ok('the rank places playbook skills after a project\'s own skills',
    built.every((s) => s.rank === PLAYBOOK_SKILL_RANK), JSON.stringify(built.map((s) => s.rank)));
  ok('the description comes from the skill frontmatter', built[0].description === 'Execute a backlog task.', built[0].description);
  ok('the candidate carries a locator for loading', built[0].locator.id === 'run-task' && built[0].locator.file === 'skills/run-task/SKILL.md', JSON.stringify(built[0].locator));
  ok('the candidate records the playbook root so get() needs no second lookup',
    built[0].metadata.playbook_root === root, JSON.stringify(built[0].metadata));
  ok('the candidate carries its rendered body for get()', /Body A/.test(built[0].content), built[0].content.slice(0, 80));
  ok('a malformed catalog entry is skipped, not crashed on', !built.some((s) => !s.name));
  ok('an empty or missing catalog yields an empty list',
    buildPlaybookSkills({ catalogs: null, root, readFile }).length === 0
    && buildPlaybookSkills({ catalogs: { skills: [] }, root, readFile }).length === 0);
}

console.log(`\ntest-dsh-plugin-core: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
