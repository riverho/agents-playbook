# Agents-Playbook

Current release: **v0.8.0** — the release that makes "finished" something you have to prove:
**versions** with an executable close, an **orchestrator** (`pb tick`) that proposes and never
decides, **`pb state` / `pb graph`** projections with the **Flow room** as an app in this repo
(`pb ui`), human-in-the-loop steering that lands in the journal, and a configurable check runner
in which a killed check is a *non-verdict* rather than a failure. It sits on top of **v0.7.0**'s
**layered planning** with a provably read-only dry run, **human-gated branches** that batch
everything only a person can clear, **multi-agent leases**, complete **worktrees**, crash
recovery, and the **DeepSeek Harness plugin** (`dsh-agents-playbook`). On npm as
[`agents-playbook`](https://www.npmjs.com/package/agents-playbook)
· [what's in it](#whats-in-v080).

> **Done is an exit code, not prose.** The kernel is a `pb record --status done` that re-runs each
> task's `acceptance_checks` (shell commands) and *refuses* on failure. Anchoring, the North Star
> (`north_star`), the cycle brief, and carry-on portability all *support* that verification gate —
> they do not replace it. If a check is tautological, the gate is hollow; see `scripts/check-hollow.mjs`.

A **portable, agent-first playbook**. Drop it into any folder and an agent can run it in a loop
without friction: orient on a master file, pick a task, do the work, prove it with **executable
acceptance checks**, record, and roll the records up into a human-readable report. Everything
lives inside the folder — copy it anywhere and it still works (carry-on).

## Why

Agents lose the thread between sessions, drift from process, and — worst of all — declare work
"done" without proof. This playbook fixes all three with the minimum machinery that actually works:

1. **One master** everything re-anchors to (`playbook.yaml`, the "fixation"), kept salient by
   cheap re-injection (`pb anchor` + runtime hooks), so long context and compaction never lose the plot.
2. **Enforced done.** A task's `acceptance_checks` are shell commands. `pb record --status done`
   runs them and **refuses to record** if any fail. Exit codes keep the loop honest — process
   documents don't.
3. **Durable state on disk** (backlog, append-only journal), so context loss never means work loss.

That's the whole thesis. No specs pipeline, no debt ledger — the playbook earns complexity only
when a real workload demands it. (Layers arrived in v0.7.0 and are held to that bar: they are an
executable plan the claim path enforces, not metadata beside it. See
[what came back differently](#what-was-deliberately-cut--and-what-came-back-differently).)

## What's in v0.8.0

**A version is a claim you have to close with a command.** `pb version new|open|freeze|close|carry|drop|list`
makes a loop a named unit with a goal and **stop checks**. `version close` *runs* those checks and
refuses while work is open: every open card must be carried (`--to next`, keeping its id and history)
or dropped with a reason, and a dropped card stays in history without ever being reported as passed.
Only one version may be open or frozen; a frozen version takes fixes, chores and experiments but no
features. Closing, carrying, dropping and retitling are **person-only** — the engine refuses them
when it sees agent context, because "this version is finished" is not a decision an agent gets to make
alone.

**`pb tick` — an orchestrator that proposes and never decides.** One deterministic pass over the open
version, configured by the master's `orchestrator:` block: it releases claims whose journal has gone
quiet past `stale_claim_minutes`, re-asks open questions on the `reprompt_minutes` schedule, routes
around blocked / waiting / failing work (one `defer` row each), proposes the next card, and proposes
closing once the stop checks pass — writing exactly **one** `tick` row. It never answers a decision,
opens or closes a version, merges, or starts an agent. `--dry-run --json` writes nothing. The host
owns the schedule; the engine owns the pass.

**`pb state` and `pb graph`: the two read-only projections a UI needs.** `state` (schema
`agent-playbook.state.v1`) carries the open version, phase, orchestrator state and last tick, counts,
and `journal_seq` + `change_token` — the token a room polls with, so an unchanged playbook answers
`304` instead of re-rendering. `graph` (schema `agent-playbook.graph.v1`) carries the start/goal
bookends, a node per card with its cycle, provenance, worker truth and a **live** flag, proven edges
(a dependency, or the `origin_task` of a spawn row — a bare claim is drawn dashed, never as the same
ink), `layers[]` with each gate's last **real** result, and the human batch. `--version <name>` renders
a historical version's graph.

**The Flow room is an app in this repo, and it draws the live playbook.**

```bash
pb ui                      # serve the room against the playbook above cwd (→ http://127.0.0.1:4317/)
pb ui --port 4400 --app <dir>
```

`apps/flow-room` renders `pb graph --json` — cards, five kinds of proven edge, the layer view, the
per-card inspector, the state bar, History and versions, and a multi-select steering dock whose
actions land in the journal as ordinary attributed rows. A zero-dependency `server.mjs` serves the
built `dist/` plus `/api/{graph,state,history,task,comment,steer,attach,fork,worker,decide,harness,ask}`.
It also renders as a **DeepSeek Harness panel** (`dsh-plugin/client.js`). The room began as a design
probe in the Wenmei playground; that dependence is **retired** — this repo owns the code,
`PROVENANCE.json` pins the commit it was copied from, and both directions are gated
(`check-app-decoupled.mjs`, `check-wenmei-retired.mjs`; see `docs/flow-room-retirement.md`).

**A person can steer from the record.** `pb comment --task <id> --text "…" --intent
comment|steer|question|finding` appends an attributable note without moving status; `pb attach`
associates a document that must exist; `pb decide --task <id> --option <id> --reason "…"` answers a
`human:` ask in one row. An agent may recommend an option but must not decide in the person's place —
the engine refuses an agent answering its own human gate.

**A killed check is a non-verdict, and the limits are yours to set.** A task's `check_timeout_ms`
beats `PB_CHECK_TIMEOUT_MS`, which beats the documented 600000 ms default; a check killed by the limit
is `TIMEOUT` and an over-printing one is `OUTPUT-LIMIT` (16 MiB, `PB_CHECK_MAX_OUTPUT_BYTES`) — neither
is ever reported as a failed check, and a nonsense limit warns and falls through instead of silently
disabling the bound. Each check runs under a launcher that kills its **whole process tree** before
reporting, and a kill that cannot be confirmed is reported next to the verdict and journalled in one
`check-run` row with no status change.

**`skills/harness-lifecycle/SKILL.md`** is the orchestrator's entry point: the pb data schema, how to
slice a plan by layers, the tick and its human-in-the-loop contract, worker worktrees, and commit/push.

### Also in this release

| Area | What shipped |
| --- | --- |
| **Versions** | `version new\|open\|freeze\|close\|carry\|drop\|list`, `version retitle`, `version migrate` (a reviewable batch; `--apply` is a person's step). A close runs the stop checks and refuses unfinished cards. |
| **Orchestrator** | `pb tick [--dry-run] [--json] [--now <iso>]` + the master's `orchestrator:` block; `max_workers: 0` = propose only. |
| **Projections** | `pb state --json`, `pb graph --json [--version <name>]`, RunCards carrying their own journal rows. |
| **Flow room** | `apps/flow-room` + `pb ui`; `npm run build:app` builds the dist the engine ships (`prepack` refuses a stale or empty app). |
| **Human-in-the-loop** | `pb comment --intent …`, `pb attach`, `pb decide`, `human:` blocks; the person-only (V6) list. |
| **Robustness** | Whole-tree check kills with an honest failure report; `OUTPUT-LIMIT` split from `TIMEOUT`; `worker remove` unlinks links instead of following them; version-lifecycle races closed. |

Full detail in [`CHANGELOG.md`](CHANGELOG.md); release steps in [`RELEASE.md`](RELEASE.md).

## What's in v0.7.0

**Plan the repo, not just the next task.** `dependencies` orders individual tasks; a **layer** is a
named stratum (substrate → data → domain → interface) and may carry a **gate** — a shell command
that must exit 0 before anything in a *higher* layer is claimable. A layer is a **projection of the
dependency graph** (derived as 1 + its deepest dependency), and a declared `layer:` is a
**constraint** `pb validate` enforces, so an edge that silently pushes work deeper is a guardrail
failure rather than a quiet contradiction. A finished layer whose gate is **red** still holds the
layer above: ticking off every task is not the claim that a stratum is sound.

**A dry run that proves it wrote nothing.** `pb plan --layers [--check-gates] [--strict] [--json]`
prints derived layers, per-layer gate state, blockers, the ready set, the derived order and the
critical path. It fingerprints the backlog, journal, state and cycle brief before rendering and
exits 3 if any changed, and it executes no `acceptance_check` — gate commands run only under
`--check-gates`. Exit 2 = structurally invalid (cycle, unknown layer, a layer earlier than its
dependencies) or a checked gate failing; 1 = `--strict` with work open.

**Human-gated branches, batched into one hand-off.** `human: true` on a layer declares a gate only
a person can satisfy — buy the domain, provision the database. It changes reporting and hand-off,
never whether the gate gates. A failing gate blocks **only its own branch** (work at that layer, in
unrelated layers, and unlayered work stay claimable), and every human-gated layer is collected into
a single `WAITING ON A HUMAN` batch naming each gate command and **every** task it holds up.
`pb loop run --auto` reports that batch and ends `Status: stalled` — previously it printed
*"Autonomous run complete"* whenever the only remaining work sat above a red gate, which is an
engine confidently wrong about being finished. Unmarked gates keep exactly their old semantics.

### Fixed

- **A blocked task replayed as `todo`.** The state reconstruction read the `release` *action* before
  a terminal *status*, so every `pb record --status blocked` row replayed as unclaimed work:
  `pb repair-state --check` reported drift on healthy projections, and its suggested `--apply`
  would have resurrected finished blocked work as todo. Pinned by
  `scripts/test-repair-terminal-release.mjs` (RED first).
- **`shellSplit` deleted quotes inside an unquoted token**, so the most ordinary check shape there is
  — `node -e "process.exit(require('fs').existsSync('x')?0:1)"` — reached node as `require(fs)` and
  died with `ERR_INVALID_ARG_TYPE`. A gate that can never go green, sitting under every
  `acceptance_check` *and* every layer gate.
- **A task naming an undeclared layer crashed the planner** instead of reporting the problem.

## What's in v0.6.3

The 0.6.x line turned a single-agent loop into a shared one, then closed the last gap where the
harness only *asked* the agent to verify. Existing single-agent playbooks keep working unchanged —
`pb next --claim`, `pb record` and `acceptance_checks` behave as before.

v0.6.3 is a patch on top: **the entry point caught up to the engine it ships**, and the **OpenCode
adapter became multi-agent**.

- **The entry point now covers modes.** `SKILL.md` was silent about the mode catalog, so its
  skills-first routing rule pointed a literal reader at a path that does not exist for mode-local
  skills (`modes/<mode>/skills/…`). It now documents modes, the autonomous runner (`pb loop run
  --auto`) and flows, and the plugin's real install state; `check-entry-docs.mjs` asserts that
  coverage so it cannot drift silently again.
- **OpenCode adapter — multi-agent identity.** Every shell and plugin heartbeat carries the runtime
  and a stable session-scoped agent id, plus any delegated proof (`PB_AGENT_CHAIN`,
  `PB_CLAIM_TOKEN`); records are attributable and two sessions can share one backlog. Pinned by
  `check-opencode-adapter.mjs`.
- Smaller fixes: `pb help` lists the previously hidden `mode` verb, and the master's cycle brief
  says **five** questions (it said four; the engine ships five).

### Multi-agent leases and attributable writes

The gap this closes: with several agents on one backlog, nothing could say **who wrote first, who
wrote last, or on whose behalf** — fan-out silently overwrote itself, and a sub-agent had to
impersonate its parent to record anything.

- **One serialized transaction for all shared state** — O_EXCL lock, re-read inside the critical
  section, atomic replace. The previous read-modify-write of the whole object discarded concurrent
  writers' changes; proved by mutation, since disabling the lock turns the regression suite red with
  real lost updates.
- **Ordering is recorded, not inferred.** Every journal row carries a monotonic `seq` and its
  writer, and the row and the state touch commit in one transaction — so the two records can never
  disagree about who wrote last.
- **A claim is a lease.** `pb next --claim` mints a **claim token**. A writer proves entitlement three
  ways: it is the holder, it presents the token, or the holder appears in its declared delegation
  chain. A sub-agent therefore records **as itself**, with `ownership: token|chain`.
- **Unproven writes are flagged, not dropped** (`ownership: unproven`) — losing real work is worse
  than an unproven row.
- **Locks break on age only**, never on a liveness probe: a pid probe misreported live holders as
  dead on Windows, letting a waiter steal an active lock. `pb release` returns a claim to the pool;
  `pb unlock --force` is the escape hatch.

→ full detail under [Multi-agent](#multi-agent-claims-are-leases-writes-are-attributable)

### The DeepSeek Harness plugin

[`dsh-plugin/`](dsh-plugin/README.md) brings the loop into the harness: one `playbook` tool
(status / anchor / next / claim / task / check / record / worker / init / unlock / repair), the
playbook's own skills registered as harness skills (`playbook-<id>`), and the constitution — North
Star, active loop, task in hand and **its checks** — staged on the agent's inbox before every step,
so compaction cannot lose the plot.

It **bundles the engine** (one install, no version to keep in step by hand) and **never
re-implements a gate** — every action is a `pb` invocation, run as a subprocess so the exit code
stays the contract and a refusal can never terminate the host.

→ full detail under [DeepSeek Harness plugin](#deepseek-harness-plugin)

### The Stop gate

Everything else in the plugin *asks* the agent to verify. The Stop gate is the first place the
harness **refuses**: when a turn would otherwise close while the agent still holds a claim it never
resolved, the turn is held open and the model is told which task to resolve and how — the project's
own thesis ("done is an enforced exit code") applied one layer up, where the agent cannot simply
decline to cooperate. It is deliberately timid (a claim is reminded about at most once; configurable
via `stopGate`, default `true`).

### Also in this release

| Area | What shipped |
| --- | --- |
| **Worktrees** | Atomic acquisition — one live slot per task — plus `status / exec / verify / merge / remove`; a merge gate that reads the **branch** (missing, dirty, or zero commits ahead ⇒ refused); `record --at <worktree>` for checks that ran in the worker tree. |
| **Session workspace, fixed** | Workspace resolution no longer falls through to `process.cwd()` (the server's launch directory), so a session cannot adopt another project's playbook; when no workspace resolves the plugin refuses instead of guessing. |
| **Plugin self-dependency, fixed** | `dsh-plugin/package.json` no longer lists `dsh-agents-playbook` in its own `dependencies`, and `pack:plugin` refuses a manifest that names the package itself. |
| **Crash recovery** | `pb repair-state --check` (exit 1 on drift, CI-wireable) and `--apply`, which rebuilds the projection from the journal; projection-only fields are preserved, because deleting them would be data loss dressed up as a repair. `pb checkpoint` now reports drift and a journal-ahead-of-projection gap. |
| **Engine as a library** | Importing `scripts/pb.mjs` no longer executes a command — it exports a read-only API (`status`, `tasks`, `task`, `journal`, `validate`, `workerStatus`, `mergeReady`, `claimOwnership`). Mutations stay on the CLI on purpose, since `process.exit()` would kill an in-process host. |
| **Tracked-state guard, fixed** | The guard against committing runtime state was inert on Windows (POSIX redirect under `cmd.exe`, `require` inside an ESM module, separator mismatch) and would have thrown once past that. Now portable — and it fires on this repo. |

Full detail in [`CHANGELOG.md`](CHANGELOG.md); release steps in [`RELEASE.md`](RELEASE.md).

## Layout

```
playbook.yaml      THE MASTER — indexes everything; loop contract; guardrails
SKILL.md           How any agent operates the playbook (read first)
AGENTS.md          Pointer for cross-tool compatibility (CLAUDE.md mirrors it)
                   — gitignored: not in the git repo, but shipped in the npm tarball
scripts/pb.mjs     The loop CLI — every command (see "Command reference")
processes/         Canonical, ordered workflows (+ index.yaml)
skills/            Short "how-to"s that route to processes (+ index.yaml),
                   including skills/harness-lifecycle/ — orchestrating a version
modes/             Persona packs mounted on the invariant floor (+ index in playbook.yaml)
memory/            project-memory.md · backlog.yaml · journal.ndjson · loops · lessons
artifacts/reports/ Generated human-facing rollups
apps/flow-room/    The Flow room — a standalone React app drawing `pb graph --json`
run-flow-room.sh   One-line launcher for the room (`node apps/flow-room/server.mjs`)
dsh-plugin/        DeepSeek Harness plugin (carries its own bundled engine)
```

`AGENTS.md` / `CLAUDE.md` are gitignored, so a git clone won't have them (the npm tarball does ship
`AGENTS.md`); `attic/` is not shipped at all.

## Quick start (in this folder)

```bash
npm install                       # one dependency: js-yaml
node scripts/pb.mjs bootstrap     # first empty install only: seed minimal run-task skill/process
node scripts/pb.mjs status        # orient
node scripts/pb.mjs next --claim  # pick + claim the next task (prints its acceptance checks)
# ...do the work via the skill it names...
node scripts/pb.mjs validate --task T1            # run the task's checks on demand
node scripts/pb.mjs record --task T1 --action execute --status done --notes "did the thing"
#   ^ re-runs the checks; refuses to record done if any fail
node scripts/pb.mjs report        # writes artifacts/reports/report-<date>.md
node scripts/pb.mjs ui            # serve the Flow room for this playbook (→ :4317)
```

There are npm aliases too: `npm run status`, `npm run next`, `npm run validate`, `npm run report`.
Building the app / the plugin bundle: `npm run build:app`, `npm run build:client`,
`npm run build:plugin`.

## Install as a package

The engine ships as a CLI, so you do not have to clone anything. **Run these in the project that
will *use* the playbook — not inside the Agent-Playbook repo itself**, where `agents-playbook` would
become a dependency of itself and npm would helpfully install a second, stale copy.

```bash
npm install agents-playbook          # local → node_modules/.bin/pb
npx --package agents-playbook pb status
npm install -g agents-playbook       # global → `pb` on PATH
```

> ⚠️ **Mind the plural.** The engine is `agents-playbook`. The singular **`agent-playbook` on npm is
> an unrelated package by another author** — `npm install agent-playbook` succeeds and silently
> installs the wrong thing. The DSH plugin is a separate package, `dsh-agents-playbook`.

### The naming rule (and why it is not a preference)

`agents-playbook` — plural — is canonical everywhere the engine controls the name. That is an
accident of the npm registry, not a design choice, and it is recorded here so it stops being
re-litigated: the singular npm name was already taken, so the published engine took the plural,
and the install directory followed it.

| Thing | Name | Notes |
| --- | --- | --- |
| npm engine | `agents-playbook` | plural; the singular is someone else's package |
| Install directory | `.agents-playbook` | plural; what `scaffold` and `action=init` create |
| Legacy install directory | `.agent-playbook` | singular; **still discovered**, so older projects are not orphaned |
| Older conventions | `.playbook`, `agent-playbook` | also still discovered |
| npm plugin | `dsh-agents-playbook` | independent package |
| Project identity | `name:` in `playbook.yaml` | per-project, unrelated to the two above |

Nothing new should be written with the singular spelling; it is supported, not recommended.

Then scaffold it into any repo:

```bash
pb scaffold --target <repo>/.agents-playbook   # copy-don't-clobber
cd <repo>/.agents-playbook && pb bootstrap && pb validate
```

`scaffold` copies the engine (never overwrites, except `pb.mjs` itself). `bootstrap` seeds minimal
process/skill stubs; `init` only creates missing runtime files. Keep it current with `pb update`
(pulls from `update.repo`, preserves `memory/` and `artifacts/`).

## The loop

**orient → select → act → verify → record → report → repeat.** One command per step:

| Step | Command |
| --- | --- |
| Orient | `node scripts/pb.mjs status` |
| Select | `node scripts/pb.mjs next --claim` |
| Act | open `skills/<id>/SKILL.md`, follow `processes/<id>.yaml` |
| Verify | `node scripts/pb.mjs validate` + `validate --task <id>` |
| Record | `node scripts/pb.mjs record ...` (done is enforced) |
| Report | `node scripts/pb.mjs report` |

See `SKILL.md` for the full contract and skills-first routing.

## Done is enforced, not declared

Tasks in `memory/backlog.yaml` carry executable checks:

```yaml
- id: T7
  title: Add a sitemap generator
  status: todo
  skill: run-task
  priority: 1
  acceptance_checks:
    - node scripts/generate-sitemap.mjs --dry-run
    - node scripts/pb.mjs validate
```

Each check runs with `cwd` = the playbook root; exit 0 = pass. `pb record --status done` runs them
all and exits 1 on any failure, telling the agent to fix the work or record `blocked` instead.
`--skip-checks` exists as an escape hatch, but the skip is stamped on the journal entry and
flagged in reports (`⚠checks-skipped`) — it can't be hidden.

A task without checks is verified on the agent's honor only, and `pb next` says so when claiming it.

Tasks may also declare `dependencies: [T1, T2]` — a task isn't claimable until its dependencies
are done.

## Hardening (context-loss survival)

State lives on disk, never only in chat. Two commands keep the playbook in an agent's attention:

- `pb anchor [--brief]` — prints the tiny constitution; cheap enough to re-inject every turn.
- `pb checkpoint [--snapshot]` — heartbeat: re-anchors, detects drift (multiple claims, claimed
  work with no record, red guardrails), and `--snapshot` writes `memory/RESUME.md` for cold resume.

Wire them into runtime hooks so the agent never has to remember (Claude Code example):
`SessionStart` → `pb anchor`, `UserPromptSubmit` → `pb anchor --brief`, `PreCompact` →
`pb checkpoint --snapshot`. See the `harden` skill. An OpenCode adapter already implements the
same contract under `adapters/opencode/`.

## Multi-agent: claims are leases, writes are attributable

N agents can share one backlog. A claim mints a **token**, and a writer proves entitlement three
ways: it IS the holder; it presents the token (`--token` / `PB_CLAIM_TOKEN`); or the holder appears
in its declared delegation chain (`PB_AGENT_CHAIN=root,sub,grand`).

A sub-agent therefore records **as itself** — `agent` + `agent_chain` + `ownership: token|chain` on
the journal row — rather than impersonating its parent, so fan-out stays auditable back to the task
that delegated it. An unproven write is recorded and flagged `ownership: unproven`: losing real work
is worse than an unproven row.

Every shared-state write goes through one serialized transaction (O_EXCL lock + atomic replace) and
each journal row carries a monotonic `seq`, so "who wrote first, who wrote last, and on whose behalf"
is a recorded fact instead of an inference from colliding timestamps. `pb release` returns a claim
to the pool (or sweeps abandoned ones with `--stale <minutes>`); `pb unlock` clears a leaked lock.

**Locking rule:** a lock is only ever broken by **age**, never by probing whether the holder is
alive — `process.kill(pid, 0)` lies across containers, and a wrong guess corrupts state. A lock has
a per-kind stale window, release is token-guarded, and `pb unlock --force` is the explicit escape
hatch when a killed holder outlives its window.

## Worktrees: isolated work, gated merges

```bash
pb worker create <task> --agent <a> --execute   # one live slot per task (atomic)
pb worker status <task> --json                  # ahead / behind / uncommitted / head
pb worker exec   <task> -- <cmd>                # run a command INSIDE the worktree
pb worker verify <task>                         # run the task's checks INSIDE the worktree
pb worker merge  <task> --execute               # gated by merge-ready; refuses unfinished work
pb worker remove <task> --delete-branch --execute
pb record --task <task> --status done --at <worktree>   # record checks that ran in the worker tree
```

The merge gate reads the branch, not just the journal: a worktree that is missing, dirty, or has
**zero commits ahead of its base** cannot be merged, and a verification that has gone stale is
reported rather than trusted. `worker checker` records an independent verdict, and
`worker provider-rate-limit` records a real provider 403/429 cooldown so a throttled worker is
distinguishable from a failing one.

All `worker` subcommands are **dry-run by default**; `--execute` applies.

## Crash recovery

`memory/journal.ndjson` is the append-only record; `memory/backlog-state.json` is a projection of it.
If a state write is lost, the projection is rebuildable:

```bash
pb repair-state --check     # exit 1 on drift (CI-wireable)
pb repair-state --apply     # rebuild from the journal
pb repair-state --strict    # drop projection-only fields instead of preserving them
```

`pb checkpoint` reports drift and a journal-ahead-of-projection gap as warnings, so silent divergence
surfaces at the heartbeat instead of being discovered later.

## DeepSeek Harness plugin

`dsh-plugin/` is a first-party-style harness plugin — [`dsh-agents-playbook`](https://www.npmjs.com/package/dsh-agents-playbook),
published on npm (the 0.6.2 rename to the plural; earlier revisions shipped under the singular
spelling). It exposes one `playbook` tool
(status / anchor / next / claim / task / check / record / worker / init / unlock / repair), registers
the playbook's own skills as harness skills (`playbook-<id>`, including `playbook-harness-lifecycle`),
and stages the constitution — North Star, active loop, task in hand and **its checks** — on the agent's
inbox before each step, so compaction cannot lose the plot. It bundles the engine, so installation is
one step and cannot drift from the engine it was tested against: **the bundle carries pb v0.8.0**, so a
workspace with no playbook of its own still gets versions, `pb tick`, `pb state`/`pb graph` and the
Flow room. It also ships the room as a Harness panel (`dsh.client`, `client.js`).

Two rules define the boundary, and they are the whole design:

- **It never re-implements a gate.** Every action is a `pb` invocation. A second opinion about "done"
  is exactly what this project refuses.
- **It shells out rather than importing.** Every `pb` command reports refusal with `process.exit()`,
  so an in-process call would terminate the *host* instead of returning an error. As a subprocess the
  exit code stays the contract.

The plugin declares `inject = ['tools']` and pulls `skills` at runtime with `ctx.inject`, because
Cordis `inject` is all-or-nothing: a missing declared service means `apply()` never runs at all, and
a plugin that silently vanishes is worse than one that degrades.

## Modes and packs

A **mode** is a persona pack mounted *on* the invariant floor. It injects a `directive` plus style
`principles` through the anchor; it never weakens enforcement. There is no mode that skips
`acceptance_checks`. Resolution order is `task.mode ?? loop.mode ?? default_mode`.

Bundled modes: `coding` (the reference pack; empty directive = inherit the host prompt), `demo`,
`blogwatch`, `fable-5`, `wiki-news`, `attention-research`, `fleet`. `pb list modes` prints the
catalog; `pb pack build <id>` / `pb pack install <file.pbpack>` ship and mount one.

**`fleet`** is the always-on orchestrator persona for a long-lived fleet working one repo. It
serves the person's Flow room (`pb ui --port 4317`), reads the backlog's comment rows every pass
(`pb runcard list --json` / `pb graph --json`), classifies each block by mechanism, and defers
human-in-the-loop work with `pb tick` instead of idling the fleet on a question. Its pack
(`modes/fleet/`) carries `fleet-orchestration` as both a skill and a process; the mode ships no
`scaffold` block by intent — a fleet is driven by `pb tick` over the open version, not by item
scaffolding. The boundary it is written to is the repo plus the version's `stop_checks`; deciding,
closing a version and merging stay person-only.

### Mode packs in practice: conformance-first intake (v0.3.3)

When a project starts from an approved visual design, establish the design contract **before broad
implementation-oriented codebase analysis**. Otherwise, legacy files and nearby examples can
silently redefine the approved design before the agent has a stable reference.

| Approved source | Skill | Source identity |
| --- | --- | --- |
| Pencil mockups via MCP | `$pencil-design-layout-conformance` | Pencil file/frame/node IDs + approved screenshots |
| Canonical HTML mockup | `$html-design-layout-conformance` | HTML entry point + checksum + stable `data-design-id` anchors |

Approve `DESIGN.md` and the Pencil or HTML source, including required viewports and UI states.
Then the intake order is:

1. Invoke the matching conformance skill and create `design-contract.yaml` from the **design
   source only**: provenance, states, viewports, semantic regions, geometry, and tolerances.
2. Analyze the codebase **through that contract**. Inspect only what is needed to map its regions:
   canonical component APIs, deprecated paths, compilable examples, tokens, and the existing test
   harness. Do not mine arbitrary nearby screens to infer the intended design.
3. Complete the component mapping, implement one golden screen, and prove the verification command
   fails on a deliberate layout shift before restoring it.
4. Only after the contract gate passes, implement production screen slices. Each slice must pass
   geometry, screenshot, responsive, applicable interaction, anti-gaming, and human-attestation gates.

For HTML sources, start from
`modes/coding/skills/html-design-layout-conformance/assets/design-contract.template.yaml`; for
Pencil sources, produce the same target-repository artifact with `source.kind: pencil` and stable
Pencil provenance. The adapter processes live under `modes/coding/processes/`.

## Versions, and the phase loop above the task loop

**A version** (`pb version …`) is the unit a release is closed on: a named loop with a goal and
`stop_checks`, closed by running them (`version close`), with every open card explicitly carried or
dropped first. **A phase** (`pb cycle` → `pb reflect`) is the lighter rhythm inside it, and the
**orchestrator** (`pb tick`) is the pass a host runs on a schedule: it releases quiet claims, re-asks
open questions, routes around blocked work, proposes the next card, and proposes closing — never
deciding, closing or merging. `pb state` is the projection to poll (`journal_seq` is the change
token); `pb graph` is the projection to draw.

Closing, carrying, dropping and retitling a version, and applying a `version migrate` batch, are
**person-only**: the engine refuses them from a process carrying agent context. Everything else —
claims, checks, records, comments, worker lifecycles — is an agent's to do, and every one of them is
attributable back to the agent that did it.

## Loop epochs and lessons

Use `pb loop new` to open a durable loop epoch. New `pb record` entries are stamped with the active
`loop_id`, and loop-scoped artifacts live under `artifacts/loops/<loop_id>/`.

Close clean loops with `pb loop close --status done`. Close contaminated runs with
`pb loop close --status failed --reason "..."`; that writes a quarantine artifact and blocks the
next `pb loop new` until a lesson is recorded with `pb learn --loop <id> --source user --notes "..."`.
Promote reusable lessons into project memory, backlog tasks, or skills/processes.

`pb loop run --auto` executes the loop autonomously — claim, run commands, run checks, record
done/blocked, retry failed checks — and stops on blockers, manual tasks, honor-only tasks, or an
empty backlog.

## Guardrails

`node scripts/pb.mjs validate` checks the master + indices parse, every referenced file exists,
skills point to real processes, the backlog (statuses, dependencies, check declarations) and
journal are well-formed. It exits non-zero on failure, so it drops cleanly into CI or a
pre-commit hook. `validate --task <id>` runs one task's acceptance checks.

One trap worth knowing: this repo **git-tracks `memory/`**, including the append-only journal and the
shared-state projection. That is exactly the shared-state hazard the engine warns about — a tracked
projection can be merged, and merging two agents' journals is not a merge anyone can do correctly.
`pb validate` warns about it and `validate --strict` makes it fatal. If you want the strict gate
green, untrack the state that the engine owns:

```bash
git rm -r --cached memory artifacts
```

## Command reference

| Group | Commands |
| --- | --- |
| Loop | `status` · `next --claim` · `record` · `report` · `validate [--task]` |
| Task & plan | `task show <id>` · `plan --goal ".." [--dep …] [--layer …] [--check …]` · `plan --layers [--check-gates]` · `runcard list\|show <id>` |
| Versions | `version new\|open\|freeze\|close\|carry\|drop\|list` · `version retitle` · `version migrate` (freeze/close/carry/drop/retitle/migrate-apply are **person-only**) |
| Orchestrator | `tick [--dry-run] [--json]` · `state [--json]` · `graph [--json] [--version <name>]` |
| Human-in-the-loop | `comment --task <id> --text ".." [--intent …]` · `attach --task <id> --path <file>` · `decide --task <id> --option <id> --reason ".."` |
| Multi-agent | `release --task <id> [--token] \| --stale <min>` · `unlock [--force]` · `repair-state [--check\|--apply]` |
| Worktrees | `worker create\|status\|exec\|verify\|merge\|remove\|checker\|merge-ready\|provider-rate-limit` |
| Loop epochs | `loop new\|status\|run\|close\|quarantine` · `learn` · `learn status` |
| Phase | `cycle [--new] [--edit]` · `reflect` |
| Context | `anchor [--brief]` · `checkpoint [--snapshot]` |
| Processes | `run -- <cmd>` · `ps` · `stop` |
| Packs & modes | `list [processes\|skills\|modes]` · `pack build\|install` |
| Room | `ui [--port N] [--app <dir>]` |
| Lifecycle | `scaffold [--with-ui]` · `init` · `bootstrap` · `update [--check]` · `help` |

Run `node scripts/pb.mjs help` for flags. Statuses: `todo, in_progress, blocked, done`.

## Dependencies

One: [`js-yaml`](https://www.npmjs.com/package/js-yaml). Node >= 18.

## Release status

Being explicit about what is shipped and what is not:

| Artifact | State |
| --- | --- |
| Engine (`agents-playbook`) | **repo** `0.8.0` (unreleased, untagged); **npm latest is `0.7.1`** |
| Git tags | `v0.1.0`, `v0.3`, `v0.3.2`, `v0.6.0`, `v0.6.1`, `v0.6.2`, `v0.6.3`, `v0.7.0`, `v0.7.1` |
| Harness plugin (`dsh-agents-playbook`) | **repo** `0.8.0`; **npm latest is `0.7.1`**. Install `dsh plugin --profile <p> add dsh-agents-playbook@^0.8.0` (needs pnpm; plain `npm install` does **not** enable it) |
| Live in-harness verification | the plugin's tool and skill provider are verified against the real packages; a live session's *authorship* stays a human step |

### Installing an unpublished build into a Harness profile

A version that is not on npm can still be mounted, from the tarball the build produces — the same
shape a `file:` dependency takes in any profile:

```powershell
npm run build:plugin && npm run pack:plugin        # bundle the engine + check the publish set
cd dsh-plugin && npm pack --pack-destination dist  # → dist/dsh-agents-playbook-0.8.0.tgz

# `dsh` ships inside the app (…\dsh\resources\runtime\cli\bin\dsh.cmd); it is not on PATH.
& "<dsh-install>\resources\runtime\cli\bin\dsh.cmd" plugin --profile <profile> `
    add 'file:D:/<repo>/dsh-plugin/dist/dsh-agents-playbook-0.8.0.tgz'
```

`dsh plugin` is a guarded pnpm passthrough: it validates the runtime compatibility gate, rewrites the
profile's `package.json`, and **rolls back** if the plugin is rejected. `dsh.profile.bundles` needs no
edit — a package declaring `dsh.bundle.patch` is appended to the layer stack by name. Reload the
session afterwards (the profile is composed at boot).

## What was deliberately cut — and what came back differently

Earlier versions carried a spec/Work-Map layer (DAG scheduling, gates, waves, debt ledgers).
It was planning metadata the CLI never executed — bureaucracy cosplaying as machinery — and it was
removed. (The `attic/` copy it was moved to is gitignored; it is not in this checkout, and no
command reads it.)

**v0.7.0 reintroduces layers and gates, deliberately unlike the version that was cut.** The
distinction is the whole point:

- The cut layer was a **second source of truth**: a DAG declared beside the backlog that no command
  read, free to drift from the work it described.
- Today's layer is a **projection of the dependency graph** the claim path already enforces. It is
  derived (1 + deepest dependency), and a declared `layer:` is a *constraint* `pb validate` checks —
  so it cannot drift silently; a contradiction is a guardrail failure.
- Its gate is an **executable** shell command on the same gate path as `acceptance_checks`, not
  metadata. Nothing reads a wave, a debt ledger, or a schedule, and none of that returned.

The rule that decided it: planning earns its place only when the CLI *executes* it. Anything
planning-shaped that no exit code depends on is still cut.
