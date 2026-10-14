---
description: Entry point for operating the Agent-Playbook loop. Teaches agents to orient on playbook.yaml, select tasks, follow skills/processes, verify with executable checks, record, and report.
---

# Playbook Skill — read this first

This is the entry point for **any** agent working in this folder. It teaches you how to operate the playbook so every agent behaves the same way and the work loops without friction.

> The master is `playbook.yaml`. It is the fixation — the single anchor everything points back to. If anything here disagrees with `playbook.yaml`, the master wins.

## Startup (do this every session)

1. Read `playbook.yaml` — the master: index, loop contract, guardrails, paths.
2. Read `memory/project-memory.md` — durable operating rules and project facts.
3. Run `node scripts/pb.mjs status` — orient on backlog + recent journal + guardrail state.

(First time on a fresh clone, run `npm install` once, then `node scripts/pb.mjs bootstrap`.
Use `node scripts/pb.mjs init` only to hydrate missing runtime files.)

## The loop (one command per step)

Repeat this until the backlog is clear:

| Step | What | Command |
| --- | --- | --- |
| 1. Orient | Re-anchor + snapshot state | `node scripts/pb.mjs status` |
| 2. Select | Pick + claim the next task | `node scripts/pb.mjs next --claim` — refuses if there's no active loop or the cycle brief is missing/stale; `--force` overrides. **Mints a claim token** — keep it. |
| 3. Act | Follow the skill → process | open `skills/<skill>/SKILL.md`, then `processes/<process>.yaml` |
| 4. Verify | Structure + the task's checks | `node scripts/pb.mjs validate` then `validate --task <id>` |
| 5. Record | Log the outcome (enforced) | `node scripts/pb.mjs record --task <id> --action <a> --status <done\|blocked> --notes "..."` |
| 6. Report | Roll up for humans | `node scripts/pb.mjs report` |

Then go back to step 1.

## Done is enforced, not declared

A task's `acceptance_checks` are **shell commands** (cwd = playbook root, exit 0 = pass).
`pb next` prints them when you claim; `pb validate --task <id>` runs them on demand;
`pb record --status done` re-runs them and **refuses to record** if any fail.

> **Paths are relative to the playbook root** — the folder containing `playbook.yaml`,
> not the outer workspace. If the playbook is installed at `.agents-playbook/`, write
> `Test-Path artifacts/X.md`, **not** `Test-Path .agents-playbook/artifacts/X.md` (that
> resolves to `.agents-playbook/.agents-playbook/...` and fails on a file that exists).
> `pb validate --task <id>` warns when a check names the playbook folder.

- If checks fail: fix the work, or record `--status blocked` with notes on what's needed.
- `--skip-checks` exists as an escape hatch, but the skip is stamped on the journal entry
  and flagged in reports. Don't use it to fake green.
- A task without checks is verified on your honor only. When you write a task, give it
  executable checks whenever possible — exit codes, not prose.

### Acceptance-check timeouts

Every check runs under a bounded limit, because a check that hangs must not hang the loop —
but a limit that is too tight is worse than useless: it turns a GREEN suite into a refusal.
The limit is **not** a verdict, and the engine never reports it as one:

```
  TIMEOUT  node scripts/slow-suite.mjs
        timed out after 400ms (limit 400ms from task check_timeout_ms, override with
        check_timeout_ms on the task or PB_CHECK_TIMEOUT_MS) — this is NOT a failing check.
```

Resolution order, most specific first:

| Source | Where | Notes |
| --- | --- | --- |
| `check_timeout_ms` on the task | `memory/backlog.yaml` | the command's own budget; wins over everything |
| `PB_CHECK_TIMEOUT_MS` | the environment | machine / CI override |
| default | — | The default is 600000 ms (10 minutes). |

The default is deliberately **bounded and generous**: several times this repo's full `npm test`,
so a busy machine cannot kill a green suite, while a genuine hang still surfaces inside the
iteration that started it. (The engine deliberately does **not** quote a duration: the figure
that used to live here — `~142 s` — was measured in a *different* repo and was inherited into a
recommendation before anyone checked it. Time your own suite rather than trusting a number in a
doc; see `lesson-20261013-006`.) A nonsense value (zero,
negative, non-numeric) is never allowed to disable the limit — it warns and falls through to
the next source.

A killed check is recorded as `checks: timed-out` with a `check_timeouts` list (command,
limit, elapsed, source), so "why did this block?" is answerable from the journal. When
`pb record --status done` hits a timeout it refuses **without writing a row**, exactly as
it does for a red check — neither one is a `done`.

**A timer kill and a full pipe are different events.** A check that exits 0 but prints more
than the runner captures is **not** a timeout and not a failure — it is `OUTPUT-LIMIT`
(the exit code was never read, so there is no verdict):

```
  OUTPUT-LIMIT  node scripts/very-chatty.mjs
        the check produced more output than the runner accepts (limit 16777216 bytes,
        override with PB_CHECK_MAX_OUTPUT_BYTES) — the exit code was never read, so this
        is NOT a failing check.
```

The capture bound is **16 MiB** by default and overridable with `PB_CHECK_MAX_OUTPUT_BYTES`,
so a legitimately chatty green check still records. A full pipe must never be read as a timer
kill (`ENOBUFS` also sets `SIGTERM`, which is how that mistake happened once).

**A kill takes the whole process tree.** Each check runs under a small launcher built into
`pb.mjs` that enforces the time and output limits itself and, when one is crossed, kills the
check's entire tree (`taskkill /T /F` on Windows, a process-group kill on POSIX) before the
engine reports `TIMEOUT` or `OUTPUT-LIMIT`. Before this, a kill reached only the engine's
direct child: on Windows the `cmd.exe` shim died and the real check kept running, so work
could land after the engine had declared no verdict. `scripts/test-timeout-kills-tree.mjs`
pins it; the POSIX branch is written but unverified on the Windows machine that built it.
The output bound counts stdout and stderr **together**, as it always did. What the kill cannot
reach: a process the check deliberately detaches (`start /b`, a daemon) after its parent has
exited is outside any tree `taskkill /T` can walk. A kill that fails is reported next to the
verdict — `WARNING: the check's process tree could NOT be killed (…)` under TIMEOUT or
OUTPUT-LIMIT — because the check may still be running; stop its processes before trusting the
next run (`scripts/test-kill-failure-reported.mjs`). An autonomous run journals it in the row's
`check_timeouts`; a refused `record` writes one `check-run` row (no status change) saying so.
`PB_TASKKILL` is for tests and unusual installs only: it must name a `taskkill.exe` (anything
else is ignored) and replaces `%SystemRoot%\System32\taskkill.exe`. Layer gates run through the
same launcher, with their own limit: `gate_timeout_ms` on the layer, then
`layer_gate_timeout_ms` in the master, then `PB_GATE_TIMEOUT_MS`, else 120 s (gates run inside every claim, so the default stays short); a gate past it is TIMEOUT —
not a pass, never a failure. Each check costs one extra Node process (about 0.1 s).

**The same contract covers mode checks, which are a different list with their own budget.**
`pb mode check` and `validate --mode` run a mode's `kind:check` principles — usually the whole
suite, `npm test` — under a limit resolved as: `check_timeout_ms` on the principle, then the
mode's `mode_check_timeout_ms`, then `PB_MODE_CHECK_TIMEOUT_MS`, then `PB_CHECK_TIMEOUT_MS`,
then the same 600000 ms default. A killed principle prints `TIMEOUT` and an over-printing one
`OUTPUT-LIMIT`; both are **non-verdicts**, never "FAILED", and both still exit non-zero
because the mode is unverified.

This matters because the limits are separate on purpose — raising a task's check budget must
not silently move the mode's — and because it was not always true: mode checks kept a
hard-coded 120000 ms, so a green `npm test` that outran 120 s was printed as
`FAIL  [tests_green] npm test`, indistinguishable from a red suite. `evalLayerGate` (layer
gates) still carries that old hard-coded limit and the same misclassification; it is filed,
not fixed — so a slow or chatty **green** gate can still be reported as a failing one, and a
failing gate partitions every stratum above it.

Invalid limits are refused from **both** sources — `0`, negatives, booleans (`true` parses
as a number in the old coercion) and non-numeric values all warn and fall through, because
`timeout: 0` means "never time out" to Node and would silently disable the guarantee. An
explicitly huge limit is honoured but warned about, since a hang then stays hidden. When a
refusal mixes a real failure with a limit-shaped outcome, the message names both and says
which is which — a failure is never called "not a failed check".

## Working with other agents

One backlog is shared. `pb next --claim` gives you a task **and a claim token** — that token is
your proof that you are entitled to write the result. Three ways to be entitled:

| You are | How you prove it |
| --- | --- |
| the holder | you are the agent that claimed it |
| acting for the holder | pass `--token <claim-token>` (or set `PB_CLAIM_TOKEN`) |
| a descendant of the holder | declare `PB_AGENT_CHAIN=root,sub,grand` |

**A sub-agent writes as ITSELF**, with `ownership: token|chain` on its journal row — never as its
parent. That is what keeps fan-out auditable back to the task that delegated it. A write you cannot
prove entitlement for is **recorded and flagged `ownership: unproven`**: losing real work is worse
than an unproven row, so it is never silently dropped and never silently allowed.

```bash
# delegate: hand the token to a sub-agent so it can record on your behalf
PB_AGENT_ID=sub-1 PB_PARENT_AGENT_ID=you PB_CLAIM_TOKEN=<token> node scripts/pb.mjs record ...
```

- `pb release --task <id>` returns a claim to the pool; `--stale <minutes>` sweeps abandoned ones.
- Every shared-state write is serialized (a lock plus an atomic replace), and each journal row
  carries a monotonic `seq`, so "who wrote first, who wrote last, on whose behalf" is a **recorded
  fact**, not an inference from colliding timestamps.
- `pb unlock [--force]` clears a leaked lock. Locks are only auto-broken by age, never by a
  liveness probe — a lock held too long costs latency, a lock broken too early costs data.

### The orchestrator tick (for a harness that runs the schedule)

The host owns the schedule; the engine owns the pass. A harness that keeps a playbook moving calls
`node scripts/pb.mjs tick` on its own timer (the `orchestrator:` block's `every_minutes`, 15 by
default) and reads `pb state --json` for what the room shows. One tick, over the open version:
releases claims whose journal has been quiet past `stale_claim_minutes`, asks open questions
(re-asked at `reprompt_minutes`), routes around blocked / waiting / failing work (a `defer` row
each), **proposes** the next task, checks the end goal and **proposes** closing — and writes
exactly one `tick` row. It never answers a decision, opens or closes a version, merges, or plans
work; it starts no agents (`max_workers` is read, but starting work from a tick is not enabled
until spending is decided). `paused: true` stops it; `--dry-run --json` shows the plan and
writes nothing.

```yaml
orchestrator:            # in playbook.yaml — absent means "No orchestrator scheduled"
  every_minutes: 15
  max_workers: 0
  stale_claim_minutes: 30
  reprompt_minutes: [60, 240, 1440]
  paused: false
```

## Steering notes and the graph projection

Two surfaces exist for a person (or a UI) watching the backlog:

- **`pb comment --task <id> --text "..."`** appends `action: comment` to the journal with the writer,
  the claim ownership and the delegation chain. It is a *note*, not a status change: the row replays
  as a non-event, so `pb repair-state --check` still finds no drift and the task's status is
  untouched. An unentitled writer is still recorded, flagged `ownership: unproven`, like every
  other write.
- **`pb graph --json`** (schema `agent-playbook.graph.v1`) is the one read-only projection a graph UI
  needs. `start`/`goal` are bookends composed from the loop epoch and the cycle brief; each node is
  composed from the RunCard + `task show` + the state projection, so a node's status **never** comes
  from `status:` in `backlog.yaml` (on disk that field is stale for every task). Edges name their
  evidence: `proven: true` is a fact the records show, `proven: false` is a claim to draw dashed.
  It never writes and **never executes a layer gate** — a declared `human: true` gate whose state is
  unknown is listed under `unevaluated_gates`, not folded into the human batch as if it were closed.
  RunCards also carry their own `journal` rows, so a card's steering thread needs no second store.

**An edge is born with the task, not added later.** `pb plan --dep <task-id>` (repeatable)
declares a task's dependencies at creation, so the order the claim path enforces and the
edges that `pb plan --layers` / `pb graph` draw exist at the first render:

```bash
pb plan --goal "wire the adapter" --check "npm test" --dep plan-20261010-001   # repeat --dep to add more
```

An unknown id, a self-dependency, a duplicate, or a `--dep`/`--layer` pair that `pb validate`
would reject is refused **before anything is written** — `plan` cannot create a task that turns
the guardrail red. A task planned while this agent is executing another also gets an
`action: spawn` journal row carrying `origin_task: <the task in flight>`; `pb graph` turns that
into a task→task `spawn` edge (`proven: true`, `evidence: 'spawn'`) instead of hanging the new
card off `start`. A bare claim stays a claim (`proven: false`, `evidence: 'claim'`) — the two
are never the same ink.

**`docs:` on a task** associates the documents a human needs in order to judge it:

```yaml
  - id: plan-20261009-004
    docs: [artifacts/graph-flow-ui/DESIGN.md]
```

`pb validate` requires every entry to exist relative to the playbook root and **fails** (not warns)
when one does not — a design that moves breaks the build loudly instead of vanishing from the card.

## Isolated work in a worktree

When the work should not touch the root checkout — long refactors, risky edits, or several agents
at once — give the task a git worktree:

```bash
pb worker create <task> --agent <a> --execute   # one live slot per task (atomic: one winner)
pb worker status <task> --json                  # ahead / behind / uncommitted / head
pb worker exec   <task> -- <cmd>                # run a command INSIDE the worktree
pb worker verify <task>                         # run the task's checks INSIDE the worktree
pb record --task <task> --status done --at <worktree>   # record a done whose checks ran there
pb worker merge  <task> --execute               # gated by merge-ready; refuses unfinished work
pb worker remove <task> --delete-branch --execute
```

The merge gate reads the **branch**, not just the journal: a worktree that is missing, dirty, or
has **zero commits ahead of its base** cannot be merged, and a verification that has gone stale is
reported rather than trusted. Record the outcome with `--at <worktree>` so the checks that certify
the work are the ones that ran on the isolated branch.

**Never link a shared tree into a worktree.** Do not put a junction or symlink at
`<worktree>/node_modules` pointing at the root checkout (or at any other shared directory). A
worker worktree is temporary; the thing it points at is not. This is not hypothetical: a teardown
of a worktree whose `node_modules` was a junction to the root checkout's `node_modules` followed the
link and emptied the root's `node_modules` to zero entries. To give a worktree its dependencies,
use one of these instead, in this order:

```bash
cp -r <root>/node_modules <worktree>/node_modules   # a REAL copy (small: the engine needs js-yaml)
npm install --prefix <worktree>                     # per-worktree install, if the registry is reachable
NODE_PATH=<root>/node_modules pb worker verify <task>   # point at the root's modules without linking
```

`pb worker remove --execute` is link-safe as a backstop: it walks the tree with `lstat` and removes
every junction/symlink **as a link** (`rmdir` for a junction or directory symlink, `unlink` for a
file symlink) before git deletes anything, and it **refuses** — naming the path and deleting
nothing — if a link cannot be removed or if the worktree path itself is a link. That is a
backstop, not permission: a copied tree has no link to get wrong in the first place.

## State recovery

`memory/journal.ndjson` is the append-only record; `memory/backlog-state.json` is a **projection**
of it. If a write is lost, rebuild the view instead of guessing:

```bash
pb repair-state --check    # exit 1 on drift (CI-wireable)
pb repair-state --apply    # rebuild from the journal
pb checkpoint              # heartbeat: reports drift and a lost write as warnings
```

## Skills-first routing

1. `pb next` tells you which `skill` a task uses and which **mode** is active.
2. Open that skill. Engine skills live at `skills/<id>/SKILL.md`; **mode-local** skills live at
   `modes/<mode>/skills/<id>/SKILL.md`. Either file points to a canonical process in `processes/`.
   Do not assume the `skills/` prefix — `pb mode show` prints the path.
3. Follow the process steps. Only improvise when **no** skill fits.
4. If you had to improvise something reusable, **write a new skill + process** and add them to
   `skills/index.yaml` and `processes/index.yaml` (or the mode's own index). That is how the
   playbook learns.

## Modes (streamline sets)

A **mode** is a persona plus a skill/process pack mounted on the invariant floor. Resolution is
`task.mode ?? loop.mode ?? default_mode` (see `playbook.yaml`); the default is `coding`. Modes ride
ON enforcement — none skips `acceptance_checks`.

- `pb list modes` — the catalog (`modes/index.yaml`), one line each.
- `pb mode show <id>` — a mode's resolved skill+process pairs, plus its directive and principles.
- `pb mode` — the active mode (no argument).

Engine skills are global; mode-local skills are contributed only while their mode is active. A task
can name its own mode, so the same backlog can carry coding work and a monitoring run side by side.

### Out-of-scope capture (the default)

Never fix out-of-scope work inline: that breaks the smallest-change rule and un-scopes the diff.
Always capture it, then finish the claimed task as scoped:
- For defects and concrete work, create a new `todo` in `memory/backlog.yaml` through the triage
  skill: reproduce first and give it an executable acceptance check that is RED before / GREEN after.
- For a missing skill, process, or mode capability, log a `pending` proposal using the orchestrator's
  gap → proposal pattern; build it in a separate loop.
Out-of-scope observations are never silently dropped and never silently acted on.

## Guardrails (lightweight)

- `pb validate` must stay green. It checks that the master, indices, and every referenced file
  exist and parse; that skills point to real processes; that backlog statuses, dependencies,
  and journal JSON are well-formed.
- Record every iteration with `pb record` — no silent work. Never hand-edit `memory/journal.ndjson`.
- One task `in_progress` at a time. Stay inside this folder.

## Agent-first, human-second

You work against machine records:
- **Backlog** (`memory/backlog.yaml`) — what to do.
- **Journal** (`memory/journal.ndjson`) — what happened (append-only, via `pb record`).

Humans read the rollups you generate with `pb report` in `artifacts/reports/`. The journal is the
source; the report is the artifact. Keep doing the work in the loop and the reports take care of themselves.

## Adding to the playbook

- **New task** → add an item to `memory/backlog.yaml`, with executable `acceptance_checks`.
- **New repeatable workflow** → add `processes/<id>.yaml` + register in `processes/index.yaml`,
  then `skills/<id>/SKILL.md` + register in `skills/index.yaml`.
- **New durable fact** → add a numbered rule to `memory/project-memory.md`.
- Run `pb validate` after any change.


## Running inside the DeepSeek Harness

`dsh-plugin/` carries the harness integration (`dsh-agents-playbook`). It bundles its own
engine, so a deployment installs the plugin and scaffolds a playbook from it — no second install and
no version to keep in step:

```
playbook action=init        # scaffold + hydrate .agents-playbook/ from the bundled engine
playbook action=status      # orient
playbook action=claim       # take the next task (returns the claim token)
playbook action=worker      # worktree lifecycle (create/status/exec/verify/merge/remove)
```

The `playbook` tool drives exactly the commands on this page; it never re-implements a gate, and it
stamps your agent identity (`PB_AGENT_ID`, `PB_SESSION_ID`, `PB_AGENT_CHAIN`) so multi-agent writes
stay attributable. The playbook's own skills are exposed to the harness as `playbook-<id>`.

> **Install state (mind the plural).** The plugin is the separate npm package
> `dsh-agents-playbook`; installing it needs **pnpm** (`dsh plugin --profile <p> add
> dsh-agents-playbook@^0.6.2`) — a plain `npm install` does not enable it. At v0.6.2 the plural
> package is **not yet published** (0.6.0 shipped under the old singular spelling), so pin
> `@^0.6.2` only once the release is on npm. `README.md` → "What's shipped" is the current state.

## Layered planning (plan the repo, not just the next feature)

`dependencies: [ids]` orders individual tasks — declare them at creation with
`pb plan --dep <id>` (repeatable) instead of hand-editing the backlog afterwards.
**Layers** are how you plan a whole repo:
a layer is a named stratum (substrate → data → domain → interface), and a layer may carry a
**gate** — a shell command that must pass before anything above it may start.

```yaml
# playbook.yaml
layers:
  - {id: L0, name: substrate, gate: "npm test"}
  - {id: L1, name: data}
  - {id: L2, name: domain, gate: "node scripts/check-domain.mjs"}
```

```yaml
# memory/backlog.yaml
- id: split-store
  title: Extract the persistence port
  layer: L1
```

Two rules keep layers from becoming a second, lying source of truth:

1. **A layer is a projection of the dependency graph.** Each task's depth is *derived*
   (1 + its deepest dependency), never trusted from the declaration.
2. **A declared `layer:` is a constraint.** A task may not sit in an earlier layer than
   something it depends on. Adding an edge that silently pushes work deeper becomes a
   `pb validate` failure instead of a quiet contradiction.

**The dry run:**

```bash
pb plan --layers                  # derived layers, gates, blockers, ready set, order, critical path
pb plan --layers --check-gates    # also RUN each gate command (opt-in)
pb plan --layers --json           # machine-readable, for a UI
```

A dry run **writes nothing and executes no acceptance check** — it fingerprints the backlog,
journal, state and cycle brief before rendering and refuses (exit 3) if any of them changed.
Exit codes: `0` = sound plan, `2` = structurally invalid (cycle, unknown layer, a layer earlier
than its dependencies) **or a checked gate is failing**, `1` = `--strict` and work remains.

**Gates are enforced, not advisory.** `pb next --claim` and `pb loop run --auto` refuse a task
whose lower layer's gate fails, and an **unverified** gate blocks too (run `--check-gates` to
verify it) — an unevaluated gate is not a passed gate. Layers are a hard partition: there is no
switch that relaxes it, because the ordering *is* the claim the plan makes. Tasks with no
`layer:` are unconstrained in both directions — no gate holds them back and they hold nothing
back — so layers can be adopted incrementally. `--force` is the one-off escape hatch, and it is
recorded on the journal row.

> A finished layer whose gate is **red** still holds the layer above. Ticking off every task is
> not the same claim as "this stratum is sound", and the gate is what makes the difference.

### Human-gated layers, and the batch you answer once

Some gates never go green on their own: buy the domain, provision the database, issue the
credential. Declare that so the engine stops treating it as a failure to retry:

```yaml
layers:
  - {id: L0, name: infra, human: true, gate: "curl -fsS $APP_URL/health && psql -c 'select 1' -h $DB_HOST"}
  - {id: L1, name: data}
```

`human: true` changes **reporting and hand-off, never whether the gate gates** — the layer above is
still blocked. What it buys you:

- **A failing gate blocks only its branch.** Work *at* the gated layer, in unrelated layers, and
  unlayered work all stay claimable. The tree does not freeze.
- **Every human question is collected into one batch.** `pb plan --layers --check-gates` prints a
  `WAITING ON A HUMAN` section naming each gate, the command that must pass, and **every** task it
  blocks — so one hand-off answers all of them instead of the loop stopping at the first.
- **The run no longer lies about finishing.** `pb loop run --auto` used to print *"Autonomous run
  complete"* when the only work left sat above a red gate. It now names the blocked tasks, prints
  the human batch, and ends `Status: stalled` — never `done`.

The intended shape: run `--check-gates` **before** opening the loop to get the full blocker set,
have the human clear it in one pass, re-run to confirm the gates are green, and only then let the
autonomous run work. Provisioning blockers get batched; judgment blockers still surface mid-loop,
and no pre-loop command can enumerate those. The blocker vocabulary is exactly what you modelled as
`dependencies` + gates — an unmodelled requirement is invisible, and the plan will look confident.

## The phase loop (cycle → reflect)

The task loop above runs *inside* a larger phase loop. The **North Star** (`north_star` in
`playbook.yaml`) is the invariant goal, re-injected every turn by `pb anchor`. Each phase also has a
changing **cycle goal**:

- **Open a phase:** `pb cycle --new` writes `memory/cycle.md` — five questions (goal, foreseen and
  prior challenges, stop condition, and any conflict with your own memory). `pb anchor` re-injects the
  goal and stop condition every turn.
- **Close a phase:** `pb reflect` reviews what was recorded `done` since the last reflection against
  the North Star and records it. `pb checkpoint` warns on a missing/stale brief or on N tasks done
  without a `pb reflect`.
- **Enforced, not just warned:** `pb next --claim` refuses to claim a task if there's no active loop,
  no cycle brief, the brief's Q5 (memory-conflict check) is still the unfilled placeholder, or the
  brief was left stale by a later `pb reflect`. Fix the precondition, or override with `--force`
  (not recommended — it claims despite the gap).

**Memory precedence:** on project matters this folder (`north_star` + `memory/`) outranks your own or
host memory. Host memory is the past; the playbook is the present and future. On conflict, surface it
— never silently follow host memory.

## The stop condition (the loop's other half)

The loop contract above says how to **keep going**. Without a matching instruction for how to
**stop**, a loop cannot finish — it can only run out of work, and "no work" is not something the
injected banner used to say. Give the loop a terminal state:

```yaml
# playbook.yaml
loop:
  stop_when: "node scripts/check-phase-stop.mjs"   # exit 0 = the phase's goal is met
  stop_action: idle          # idle | report | close-cycle | ask-human
```

`stop_when` is an **executable command**, exactly like a task's `acceptance_checks`: cwd =
playbook root, exit 0 = done. It is optional — but if you declare it, a **prose** value is a
`pb validate` **failure**, not a warning. An unenforceable condition is the same as no
condition, which is the defect this exists to prevent.

```bash
pb stop-check            # run it and print the verdict; exit 0 = met, 1 = not met, 2 = not declared/not executable
pb stop-check --json     # the same verdict, machine-readable (schema agent-playbook.stop.v1)
pb stop-check --cached   # accept a verdict already computed for the current journal seq
pb checkpoint            # now reports PHASE COMPLETE instead of drift when the stop check is green
```

**The verdict is cached, keyed on the journal `seq`.** A stop condition is usually a real gate —
this repo's runs the whole test suite — while `pb status --json` feeds the harness's *per-step*
context injection and `pb anchor --brief` is injected every turn. Running a six-minute suite on
every step would make the harness unusable, so `status` and `anchor` reuse a cached verdict and
recompute it the moment any journal row is appended: **the verdict may lag the work, but never
lags the record.** `pb stop-check` without `--cached` always runs the gate, because a person
asking wants the truth now. The cache lives at `memory/.stop-check-cache.json` (runtime state,
inside the gitignored `memory/`).

**Completion is a NEGATIVE signal, and the banner respects it.** `pb anchor --brief` has three
shapes, and which one appears matters more than what it says:

| Posture | When | The banner |
| --- | --- | --- |
| `complete` | the stop check exits 0 | `PHASE COMPLETE` — **no action required**, do not reply |
| `idle` | nothing claimable, nothing in hand | `NO ACTION REQUIRED` — **no action required**, do not reply |
| `active` | there is work | the loop instructions, as before |

The two inert shapes carry **no imperative at all**. This is deliberate and load-bearing: a
status line that ends with an instruction ("Drive the loop…", "re-anchor any time") is read as a
**task** by an instruction-following agent, and answering it *creates the next turn*. That is how
one injected line became dozens of turns in one session — the loop had no observable "done", so
there was always one more piece of text to consume. If you are an agent reading an inert banner:
**do nothing.** It is status, not a request.

The harness integration enforces the same rule from its side: the injected context block is inert
under the same conditions, drops every imperative when it is, and carries a
`max_turns_without_progress` backstop (default 3) measured on the journal `seq` — after N turns
that record nothing new, injection stops and says so once.

## Loop epochs and learning

For scoped work, open a durable epoch with `node scripts/pb.mjs loop new --goal "..." --stop "..."`.
New records are stamped with the active `loop_id`; long-running commands should use
`node scripts/pb.mjs run -- <command>` so logs and PIDs are tied to that loop.

- **Continuing** (default): the new loop inherits the existing backlog as-is — use this when the
  remaining `todo` tasks still match the current repo state.
- **Ground-up** (`loop new --fresh`): use this when the backlog is stale relative to disk (e.g. it
  assumes earlier "done" tasks/artifacts that no longer exist, or paths that moved). `--fresh`
  archives the current backlog to the new loop's artifacts dir (nothing is lost) and resets
  `memory/backlog.yaml` to empty, so old tasks can't be silently claimed under the new loop. Add
  tasks that reflect the current repo state afterward.
- Clean close: `node scripts/pb.mjs loop close --status done`.
- Contaminated close: `node scripts/pb.mjs loop close --status failed --reason "..."`.
- Smarter next loop: after a failed loop, record user/agent reflection with
  `node scripts/pb.mjs learn --loop <id> --source user --notes "..."` before opening the next loop.

### Running the loop without a human

- **Autonomous:** `node scripts/pb.mjs loop run --auto` claims, executes, runs each task's checks,
  and records `done`/`blocked` on its own (retrying red checks). It stops on blockers, `manual`
  tasks, honor-only tasks, or an empty backlog — it never grants a pass a check did not earn.
- **Flows (multi-mode pipelines):** `node scripts/pb-flow.mjs --flow <id>` runs `flows/<id>.yaml`
  steps in order — one epoch, fail-fast — handing off through explicit artifact dirs. The monitoring
  scaffold driver is `node scripts/pb-daily-monitor.mjs --mode <id>` (default `default_monitor_mode`,
  declared in `playbook.yaml`).

### Optional versions

Versions use the existing loop store and journal. A playbook that never calls `pb version`
retains the legacy loop workflow.

```bash
pb version new --name v1 --goal "..." --stop-check "node scripts/check-goal.mjs"
pb plan --goal "..." --kind feature --check "..."
pb version freeze
pb plan --goal "..." --kind fix --check "..."
pb version new --draft --name v2 --goal "..." --stop-check "..."
pb version carry <task-id> --to next
pb version drop <task-id> --reason "..."
pb version close
pb version open --name v2
pb version list --json
```

Only one version may be open or frozen. A draft stages the destination for explicit
carry-over without opening another version. `--to next` requires exactly one draft;
name it explicitly when several drafts exist. Carry keeps the card ID/history and writes
source and destination rows with distinct sequence numbers. A held claim must be released
before carry/drop. Dropped cards remain in history, excluded from selection; dropping never
pretends their checks passed.

Versioned tasks are stamped at birth. Follow-ups inherit their parent's version; a frozen
version accepts fixes, chores and experiments, but no features. Closed versions permit
comments and reflections, with other writes refused. Closing executes every stop check,
refuses unfinished cards without explicit carry/drop, and refuses live tracked processes.
The close snapshot retains carried-out cards so the historical version does not lose them.

Versioned worker Git/state operations serialize with lifecycle changes. Long worker exec and
verification operations use tracked process leases instead of holding the state lock: other
agents can still record, while close/carry/drop wait for the operation to finish. If a worker
process crashes before releasing its lease, inspect and stop its process tree, then use
`pb version release-operation --pid <pid> --reason "<confirmed cleanup>"` from a human CLI.
The engine never silently discards an unfinished operation based on a liveness probe.

When versions are in use, use `pb version close` instead of `pb loop close`; the latter
cannot bypass the version checks. New/open seeds the normal cycle brief: answer its memory
conflict question before planning or claiming. The host still owns scheduling and human
decisions; these commands do not schedule themselves.

Promote reusable lessons into `memory/project-memory.md`, backlog tasks with acceptance checks, or
new/updated skills and processes. Keep raw details in `memory/lessons.ndjson`.
