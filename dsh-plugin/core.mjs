// ============================================================================
//  core.mjs — the host-independent half of the DeepSeek Harness integration.
// ----------------------------------------------------------------------------
// Everything here is a pure function or takes its dependencies by injection, so it
// can be unit-tested with plain node and no harness runtime. `index.js` is the thin
// Cordis layer that wires these to ctx.
//
// Division of labour, which is the whole design:
//   ENGINE (Agent-Playbook) owns truth — backlog, claims, journals, acceptance
//     checks, worktrees. It is reached through its CLI so that its exit codes stay
//     the contract and its `process.exit()` refusals can never kill the host.
//   PLUGIN (this package) owns convenience — agent identity, context injection,
//     and model-facing tools that translate intents into `pb` invocations.
//   The plugin NEVER re-implements a gate. If it cannot express something as a
//   `pb` call, the engine does not support it yet.
// ============================================================================

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The engine file that marks a directory as a playbook. */
export const MASTER_FILE = 'playbook.yaml';
export const MASTER_JSON = 'playbook.json';

/** This package's own directory (where the bundled engine lives, when shipped). */
export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The engine the plugin carries with it, if bundled.
 *
 * The plugin ships a copy of the engine so a deployment does not need a second
 * install and cannot drift from the engine it was tested against. It is a FALLBACK:
 * a workspace's own playbook always wins, because that is where the project's truth
 * (backlog, journal) lives.
 */
export function bundledEngine() {
  const root = join(PLUGIN_DIR, 'engine');
  const pb = join(root, 'scripts', 'pb.mjs');
  return existsSync(pb) ? { root, pb } : null;
}

/** Engine version, read from the copy that owns the entry point. */
export function engineVersion(pbPath) {
  try {
    const pkg = JSON.parse(readFileSync(join(pbPath, '..', '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Resolve where the engine should run and what it should operate on.
 *
 * Two distinct things, deliberately kept apart:
 *   - `pbPath`   which ENGINE to execute (workspace copy, else the bundled one);
 *   - `cwd`      which PLAYBOOK the command runs against (always a real workspace
 *                playbook; the bundled engine is never a target).
 *
 * Excluding the bundled directory from discovery matters: since the plugin contains a
 * playbook-shaped tree, an ancestor walk that did not skip it would "discover" the
 * plugin's own vendored copy and operate on that instead of the user's project.
 */
export function resolveEngine({ workspace, explicit, pluginDir = PLUGIN_DIR } = {}) {
  const bundled = bundledEngine();
  const workspaceRoot = findPlaybookRoot({ workspace, explicit, exclude: pluginDir });
  if (workspaceRoot) {
    const wsPb = join(workspaceRoot, 'scripts', 'pb.mjs');
    return {
      cwd: workspaceRoot,
      pbPath: existsSync(wsPb) ? wsPb : (bundled ? bundled.pb : null),
      source: existsSync(wsPb) ? 'workspace' : (bundled ? 'bundled-engine-for-workspace' : null),
      workspace_version: readMasterVersion(workspaceRoot),
      engine_version: existsSync(wsPb) ? engineVersion(wsPb) : (bundled ? engineVersion(bundled.pb) : null),
    };
  }
  if (bundled) {
    return { cwd: null, pbPath: bundled.pb, source: 'bundled-engine', workspace_version: null, engine_version: engineVersion(bundled.pb) };
  }
  return { cwd: null, pbPath: null, source: null, workspace_version: null, engine_version: null };
}

/** The `version` declared by a playbook master, if it parses. */
export function readMasterVersion(root) {
  for (const name of [MASTER_FILE, MASTER_JSON]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, 'utf8');
      if (name === MASTER_JSON) {
        const doc = JSON.parse(text);
        return typeof doc.version === 'string' ? doc.version : null;
      }
      // Avoid depending on a YAML parser here (the plugin ships no runtime deps):
      // the master's version is a top-level scalar in both supported layouts.
      const m = /^version:\s*(.+)$/m.exec(text);
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Well-known nested install locations, in priority order.
 *
 * NAMING RULE — `.agents-playbook` (plural) is canonical; `.agent-playbook` (singular) is a
 * supported legacy alias. The split is not a preference, it is an accident worth recording so
 * nobody re-litigates it: the npm name `agent-playbook` (singular) was already taken by an
 * unrelated package, so the published engine is `agents-playbook` (plural) — and the install
 * directory followed the package name. Some projects were scaffolded before that settled and
 * carry the singular spelling, so both are accepted. New installs always get the plural
 * (`Config.playbookDir`), and nothing new should be written with the singular.
 *
 * `.playbook` and the bare `agent-playbook` are older conventions still in the wild.
 */
export const NESTED_PLAYBOOK_DIRS = ['.agents-playbook', '.agent-playbook', '.playbook', 'agent-playbook'];

/**
 * Find the playbook root.
 *
 * Search order: an explicit path, then the well-known NESTED locations (the engine's
 * own `scaffold` convention puts a playbook at `<workspace>/.agents-playbook`), then
 * the workspace chain upwards (the monorepo case, where a playbook at the repo root
 * serves a package deep inside it).
 *
 * The nested pass is not optional: an upward-only walk cannot see the layout the
 * engine itself recommends, so the plugin would report "no playbook" in exactly the
 * setup its own documentation tells people to create.
 */
export function findPlaybookRoot({ workspace, explicit, exclude } = {}) {
  const excluded = exclude ? resolve(exclude) : null;
  const isExcluded = (c) => !!excluded
    && (resolve(c) === excluded || resolve(c).startsWith(excluded + '\\') || resolve(c).startsWith(excluded + '/'));
  const hasMaster = (c) => existsSync(join(c, MASTER_FILE)) || existsSync(join(c, MASTER_JSON));

  const candidates = [];
  if (explicit) candidates.push(isAbsolute(explicit) ? explicit : resolve(workspace || '.', explicit));
  if (workspace) {
    const ws = resolve(workspace);
    for (const nested of NESTED_PLAYBOOK_DIRS) candidates.push(join(ws, nested));
    let dir = ws;
    while (dir) {
      candidates.push(dir);
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }
  for (const c of candidates) {
    // Never treat the plugin's own vendored engine as the user's playbook.
    if (isExcluded(c)) continue;
    if (hasMaster(c)) return c;
  }
  return null;
}

/**
 * The agent identity a playbook write should carry.
 *
 * This is the piece that makes multi-agent ordering meaningful in a harness: the
 * engine records WHO wrote each row, and a sub-agent must be able to write back
 * without impersonating its parent. The harness knows the session id; the parent
 * chain is supplied by the caller (the tool layer passes the spawning agent's id).
 */
export function identityEnv({ agentId, sessionId, parentAgentId, chain, claimToken, runtime = 'dsh' } = {}) {
  const env = {};
  if (agentId) env.PB_AGENT_ID = String(agentId);
  if (sessionId) env.PB_SESSION_ID = String(sessionId);
  if (parentAgentId) env.PB_PARENT_AGENT_ID = String(parentAgentId);
  // A full delegation chain (root first) lets the engine verify that a descendant
  // is entitled to touch a task its ancestor claimed.
  if (Array.isArray(chain) && chain.length) env.PB_AGENT_CHAIN = chain.join(',');
  else if (parentAgentId && agentId) env.PB_AGENT_CHAIN = [parentAgentId, agentId].join(',');
  // The claim token is the strongest proof; pass it through when the caller has it.
  if (claimToken) env.PB_CLAIM_TOKEN = String(claimToken);
  if (runtime) env.PB_RUNTIME = String(runtime);
  return env;
}

/**
 * Run a `pb` command as a subprocess.
 *
 * Subprocess, not import: every engine command calls `process.exit()` when it
 * refuses (that IS how a gate reports failure), and an in-process call would kill
 * the harness instead of returning an error. Exit codes are the contract.
 *
 * stdout is the machine channel; stderr carries the human explanation. Both are
 * returned so the caller can decide what the model sees.
 */
export function runPb(args, { pbPath, cwd, env = {}, timeoutMs = 120_000 } = {}) {
  if (!pbPath) throw new Error('runPb requires pbPath');
  try {
    const stdout = execFileSync(process.execPath, [pbPath, ...args], {
      cwd: cwd || undefined,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout: stdout || '', stderr: '' };
  } catch (e) {
    return {
      ok: false,
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : '',
      stderr: e.stderr ? String(e.stderr) : (e.message || ''),
      timedOut: e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM',
    };
  }
}

/** Parse a `--json` payload off stdout, tolerating leading/trailing noise. */
export function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through to a bracket scan */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

/** The claim token printed by `pb next --claim`, if any. */
export function parseClaimToken(stdout) {
  const m = /Claim token:\s*([0-9a-f]{8,})/i.exec(String(stdout || ''));
  return m ? m[1] : null;
}

/** The task id a `pb next --claim` run claimed, if any. */
export function parseClaimedTask(stdout) {
  const m = /Claimed \[([^\]]+)\]/.exec(String(stdout || ''));
  return m ? m[1] : null;
}

/**
 * Build the context block injected before an agent step.
 *
 * Goals, in order: keep the North Star and the active loop salient (survives
 * compaction), name the work in hand and its checks, and state the one rule that
 * matters — done is an exit code, not a claim. Deterministic: pure function of the
 * inputs, so it can be asserted in tests and cached by the host if it wants to.
 *
 * THE INERT RULE (debrief 2026-10-13, mechanisms 1-3). This block is the thing that made
 * the loop endless: it was injected every turn and always ended on an imperative, so an
 * instruction-following agent read a STATUS LINE as a PROMPT, answered it, and answering
 * created the next turn. Two consequences are enforced here:
 *
 *   1. When there is nothing to ask for, the block is INERT — it says so in words that
 *      cannot be read as a task, and it carries NO imperative. A banner that asks for
 *      nothing must look like nothing.
 *   2. `status.stop` (the engine's `loop.stop_when` verdict, when the engine provides it)
 *      outranks everything: a green stop means the phase is over and the block is inert
 *      even if a claim is still technically open.
 */
export function buildContextBlock({ status, next = null, task = null, driftWarning = null, maxChars = 4000 } = {}) {
  if (!status) return null;
  const lines = ['[agent-playbook]'];
  if (status.name) lines.push(`playbook: ${status.name}${status.version ? ` v${status.version}` : ''}`);

  const loop = status.loop ? `${status.loop.id}${status.loop.goal ? ` — ${status.loop.goal}` : ''}` : '(none active)';
  lines.push(`loop: ${loop}`);
  if (status.cycle?.goal) lines.push(`cycle goal: ${status.cycle.goal}`);
  if (status.northStar) lines.push(`north star: ${status.northStar}`);

  const counts = status.backlog?.counts || {};
  lines.push(`backlog: ${counts.todo ?? 0} todo · ${counts.in_progress ?? 0} in_progress · ${counts.blocked ?? 0} blocked · ${counts.done ?? 0} done`);

  const claimed = Array.isArray(status.backlog?.in_progress) ? status.backlog.in_progress : [];

  // ---- The terminal state. Green stop => PHASE COMPLETE, and nothing else is said. ----
  const stop = status.stop && typeof status.stop === 'object' ? status.stop : null;
  if (stop?.declared && stop.executable && stop.met) {
    lines.push(`phase: COMPLETE — the declared stop condition exited 0 (stop_action: ${stop.action || 'idle'})`);
    if (stop.command) lines.push(`  $ ${stop.command}`);
    return clampBlock(inertBlock(lines, 'the phase is complete; this is status, not a request'), maxChars);
  }
  // A stop condition that is declared but NOT evaluable is a broken contract, and the
  // agent is the one who can fix it — so unlike a complete phase, this one DOES ask.
  if (stop?.declared && stop.executable === false) {
    lines.push(`⚠ the phase stop condition is not executable: ${stop.command || '(unknown)'}`);
    lines.push('Fix it in playbook.yaml (`loop.stop_when` must be a shell command that exits 0 when the phase goal is met).');
  }

  if (claimed.length) lines.push(`in progress: ${claimed.map((t) => `${t.id} (${t.claimed_by || 'unclaimed'})`).join(', ')}`);

  if (task) {
    lines.push(`task in hand: [${task.id}] ${task.title || ''}`.trim());
    const checks = Array.isArray(task.acceptance_checks) ? task.acceptance_checks : [];
    if (checks.length) {
      lines.push('done means these exit 0:');
      for (const c of checks.slice(0, 10)) lines.push(`  $ ${c}`);
    } else {
      lines.push('done is on your honor — this task has no acceptance_checks');
    }
    if (task.worker?.worktree_path) lines.push(`worker worktree: ${task.worker.worktree_path}`);
  } else if (next?.task) {
    lines.push(`next up: [${next.task.id}] ${next.task.title || ''}`.trim());
    if (next.skill) lines.push(`skill: ${next.skill}${next.skill_file ? ` (${next.skill_file})` : ''}`);
  }

  if (driftWarning) lines.push(`⚠ ${driftWarning}`);
  if (status.memoryPrecedence) lines.push(status.memoryPrecedence);

  // ---- Nothing claimable, nothing in hand: INERT. ----
  // This is the exact state the debrief session was in when it repeated "Holding." dozens
  // of times: the task was done, the backlog was clear, and the banner still ended with
  // "Drive the loop". No imperative is emitted here, on purpose.
  if (!task && !next?.task && !claimed.length) {
    return clampBlock(inertBlock(lines, 'no claimable task and nothing in hand; this is status, not a request'), maxChars);
  }

  lines.push('Rule: "done" is an exit code, not a claim. Record with `pb record` — it re-runs the checks and refuses on failure.');
  lines.push('Drive the loop with the `playbook` tool; re-anchor any time with action=anchor.');

  return clampBlock(lines.join('\n'), maxChars);
}

/** Enforce the character cap. Applied on EVERY return path — an inert block that skipped
 *  the cap would be the one block allowed to grow unbounded, which is backwards: inert
 *  text is the text we most want to keep short.
 *
 *  When the block is an inert `{head, tail}` pair, the TAIL is reserved its space before
 *  the head is truncated. The head is the part that can be cut; the "no action required"
 *  marker is the part that must survive, or truncation would silently restore the original
 *  defect (a banner that reads like a task and never says it is inert). */
function clampBlock(text, maxChars) {
  const cap = Number(maxChars);
  if (!Number.isFinite(cap) || cap <= 0) return text;
  const isPair = text && typeof text === 'object' && typeof text.head === 'string';
  if (!isPair) {
    // A plain (active) block: the ordinary cap, no reserved tail.
    const s = String(text);
    return s.length > cap ? `${s.slice(0, Math.max(0, cap - 24))}\n… (truncated)` : s;
  }
  // An inert block's tail is reserved before the head is cut.
  const tail = text.tail;
  const room = cap - tail.length - 1;
  if (room <= 0) return tail;
  if (text.head.length <= room) return `${text.head}\n${tail}`;
  return `${text.head.slice(0, Math.max(0, room - 16))}\n… (truncated)\n${tail}`;
}

/**
 * Render an INERT block: status, explicitly marked as asking for nothing.
 *
 * The wording is the feature. A status line that ends on an imperative ("Drive the loop",
 * "re-anchor any time") is read as an instruction by an instruction-following agent, and
 * *answering it creates the next turn* — which is how a correct answer turned into dozens
 * of turns. So an inert block names itself as inert, drops every imperative, and tells the
 * reader not to reply.
 *
 * The tail is assembled FIRST and reserved its space. Truncation used to be able to strip
 * it, leaving a header with no marker — i.e. a banner that reads like a task and says
 * nothing about being inert, which is the exact shape of the original defect. A safe tail
 * that can be truncated away is not a safe tail.
 */
function inertBlock(lines, reason) {
  const tail = [
    `no action required — ${reason}.`,
    'Do NOT reply to this banner and do not start another iteration on it; wait for the human.',
  ];
  return { head: lines.join('\n'), tail: tail.join('\n') };
}

/** Scaffold a playbook into `target` from the bundled engine, then hydrate it. */export function scaffoldFromBundle(target, { pluginDir = PLUGIN_DIR, timeoutMs = 120_000 } = {}) {
  const bundled = bundledEngine();
  if (!bundled) return { ok: false, code: null, stdout: '', stderr: '', error: 'no bundled engine in this build' };
  const scaffold = runPb(['scaffold', '--target', target], { pbPath: bundled.pb, cwd: bundled.root, timeoutMs });
  if (!scaffold.ok) return { ...scaffold, engine: bundled.root, target };
  // `scaffold` lays down the engine and the master; `init` hydrates the runtime files
  // (journal, backlog, artifacts). Without it the fresh playbook fails `validate` on
  // files it is expected to create for itself, which is a confusing first experience.
  // Run it with the COPY's engine so the hydrated files belong to the workspace.
  const copiedPb = join(target, 'scripts', 'pb.mjs');
  const init = existsSync(copiedPb)
    ? runPb(['init'], { pbPath: copiedPb, cwd: target, timeoutMs })
    : { ok: false, code: null, stdout: '', stderr: 'the scaffolded tree has no engine entry point' };
  return {
    ok: scaffold.ok && init.ok,
    code: init.ok ? 0 : (init.code ?? scaffold.code),
    stdout: `${scaffold.stdout}${init.stdout}`,
    stderr: `${scaffold.stderr}${init.stderr}`,
    engine: bundled.root,
    target,
    initialized: init.ok,
  };
}

// ============================================================================
//  Playbook skills → harness skills
// ----------------------------------------------------------------------------
// A playbook skill (`skills/<id>/SKILL.md`) is a short how-to that ROUTES to a
// canonical process in `processes/<id>.yaml`. Exposing them to the harness makes the
// project's own procedures loadable the same way its built-in ones are.
//
// Namespacing is deliberate: a harness skill is invoked by slot (`/name`) and a
// playbook skill by path, so a bare playbook id could collide with an unrelated
// harness skill of the same name. Every exposed skill is therefore `playbook-<id>`,
// which keeps the two registries disjoint and makes the origin obvious in the catalog.
// ============================================================================

/** Registry rank: after a project's own `.dsh`/`.agents` skills, before bundled ones. */
export const PLAYBOOK_SKILL_RANK = 400;
export const SKILL_PREFIX = 'playbook-';

/** Parse a skill file: YAML frontmatter (name/description/whenToUse) plus body. */
export function parseSkillFile(text) {
  const src = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
  if (!m) return { frontmatter: {}, body: src.trim() };
  const frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, '');
    if (value) frontmatter[kv[1]] = value;
  }
  return { frontmatter, body: m[2].trim() };
}

/**
 * Body text the model receives when it loads a playbook skill.
 *
 * The routing line is prepended deliberately: a playbook skill that says "follow the
 * process" is useless unless the reader knows WHICH process file, and the file path is
 * what the engine's skills-first routing keys on.
 */
export function renderPlaybookSkillBody({ id, process, file, body }) {
  const lines = [`# Playbook skill: ${id}`];
  lines.push('');
  lines.push('This skill belongs to the workspace playbook. Operate the project through it:');
  lines.push(`- skill file: ${file}`);
  if (process) lines.push(`- canonical process: processes/${process}.yaml — follow it step by step`);
  lines.push('- record work with the `playbook` tool; "done" is an acceptance check exiting 0, not a claim');
  lines.push('');
  lines.push(body || '');
  return lines.join('\n').trim();
}

/**
 * Build the provider's catalog from the engine's resolved catalogs + a file reader.
 *
 * `catalogs` is the engine's `list --json` payload (so mode-local skills are included
 * by the ENGINE's resolution, not re-implemented here). `readFile` is injected so this
 * is testable without touching disk.
 */
export function buildPlaybookSkills({ catalogs, root, readFile }) {
  const skills = Array.isArray(catalogs?.skills) ? catalogs.skills : [];
  const out = [];
  for (const entry of skills) {
    if (!entry?.id || !entry?.file) continue;
    let text = null;
    try { text = readFile(join(root, entry.file)); } catch { continue; } // a listed skill with no file is not exposable
    if (text === null) continue;
    const { frontmatter, body } = parseSkillFile(text);
    const name = `${SKILL_PREFIX}${entry.id}`;
    // A provider must not advertise a name the registry will reject.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) continue;
    out.push({
      name,
      description: frontmatter.description
        || `Playbook skill "${entry.id}"${entry.process ? ` — routes to the ${entry.process} process` : ''}.`,
      whenToUse: frontmatter.whenToUse || undefined,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'custom',
      provider: 'agent-playbook',
      rank: PLAYBOOK_SKILL_RANK,
      path: join(root, entry.file),
      locator: { id: entry.id, file: entry.file, process: entry.process || null },
      metadata: { playbook_root: root, process: entry.process || null },
      // Kept on the candidate so `get()` needs no second read of the index.
      content: renderPlaybookSkillBody({ id: entry.id, process: entry.process, file: entry.file, body }),
    });
  }
  return out;
}

/** Map harness identity onto the engine's agent id, defaulting to the session id. */
export function resolveAgentId({ agentId, sessionId } = {}) {
  return String(agentId || sessionId || 'agent');
}
