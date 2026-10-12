# Changelog

Both tracks are versioned together: the plugin bundles the engine, so a shared version
makes the pair identifiable. `npm run check:version` guards the engine's own
`package.json` ↔ `playbook.yaml` agreement, and `npm run pack:plugin` refuses to build a
tarball whose plugin version differs from the engine it carries.

## 0.8.0 — versions you have to close, an orchestrator that only proposes, and the Flow room as a real app

Minor. New lifecycle surface (versions), a new scheduling surface (`pb tick`), and the graph UI
moved out of another project's playground and into this repo. A playbook that never calls
`pb version` keeps the legacy loop workflow unchanged.

### Added

- **Versions, with an executable close.** `pb version new|open|freeze|close|carry|drop|list`
  (plus `version retitle` and `version migrate`) turn a loop into a named unit with a goal and
  **stop checks**. `version close` runs those checks and refuses while work is open: every open
  card must be carried (`--to next`, keeping its id and history) or dropped with a reason, and
  dropped cards stay in history without ever being reported as passed. Only one version may be
  open or frozen, a frozen version accepts fixes, chores and experiments but no features, and a
  closed version is read-only. Closing, carrying, dropping and retitling are **person-only**
  (V6): the engine refuses them when it sees agent context (`PB_RUNTIME`, `PB_SESSION_ID`,
  `PB_AGENT_CHAIN`, `PB_PARENT_AGENT_ID`, `PB_CLAIM_TOKEN`), because "this version is finished"
  is a decision no agent gets to make on its own. `version migrate` writes a reviewable batch
  that turns a pre-version loop into a closed version and opens the next — `--apply` is a
  person's step.
- **An orchestrator that proposes and never decides: `pb tick`.** One deterministic pass over
  the open version, configured by the master's `orchestrator:` block (`every_minutes`,
  `max_workers: 0`, `stale_claim_minutes`, `reprompt_minutes`, `paused`). It releases claims
  whose journal has gone quiet, re-asks open questions on the `reprompt_minutes` schedule,
  routes around blocked / waiting / failing work (one `defer` row each), proposes the next card,
  and proposes closing once the stop checks pass — writing exactly **one** `tick` row. It never
  answers a decision, opens or closes a version, merges, or starts an agent. `--dry-run --json`
  shows the plan and writes nothing; `paused: true` stops it. The host owns the schedule; the
  engine owns the pass.
- **`pb state --json` — the projection a room polls.** Schema `agent-playbook.state.v1`: the open
  version, the phase, orchestrator state and last tick, counts (`todo` / `in_progress` / `blocked`
  / `done` / `needs_you` / `stale`), and `journal_seq` + `change_token` — the token a UI polls
  with, so an unchanged playbook answers `304` instead of re-rendering.
- **The Flow room is an app in this repo** — `apps/flow-room`, served by `pb ui [--port N]
  [--app <dir>]` (or `run-flow-room.sh`). It draws the **live** `pb graph --json` of the playbook
  above the working directory: the start card, the backlog as cards, five kinds of proven edge,
  the human batch, the cycle-stop card, a per-card inspector and a multi-select steering dock. A
  zero-dependency `server.mjs` serves the built `dist/` plus
  `/api/{graph,state,history,task,comment,steer,attach,fork,worker,decide,harness,ask}`, so
  steering from the room lands in the journal as an ordinary attributed row. It also renders as a
  DeepSeek Harness panel (`dsh-plugin/client.js`). The room was built in the Wenmei playground as
  a design probe; the dependence is **retired** — `apps/flow-room` is the source of truth,
  `PROVENANCE.json` pins the commit it was copied from, `check-app-decoupled.mjs` proves the
  module graph and `check-wenmei-retired.mjs` proves the resolution graph. `docs/flow-room-retirement.md`
  records the direction and the honest limits of the gate.
- **`pb graph --json` (schema `agent-playbook.graph.v1`) grew up.** `layers[]` now carries each
  layer's gate and its last **real** result, each node carries a `live` flag (a held claim plus a
  journal row under 15 minutes old), and `--version <name>` renders a historical version's graph.
  RunCards carry their own ordered journal rows, so a card's steering thread needs no second
  store; an edge says whether it is `proven` (a dependency, or the `origin_task` of a spawn row)
  or a bare claim to draw dashed.
- **Steering a person can perform from the record.** `pb comment --task <id> --text "…"
  --intent comment|steer|question|finding` appends a note without moving status; `pb attach`
  associates a document that must EXIST; `pb decide --task <id> --option <id> --reason "…"`
  answers a `human:` ask in one row. An agent may recommend an option but must not decide in the
  person's place — the engine refuses an agent answering its own human gate.
- **`skills/harness-lifecycle/SKILL.md`** (→ `processes/harness-lifecycle.yaml`): how to
  orchestrate a version rather than execute one card — the pb data schema, the layer-sliced plan,
  the tick and its human-in-the-loop contract, worker worktrees, and commit/push.
- **Check limits are configurable and their outcomes are distinct.** A task's `check_timeout_ms`
  beats `PB_CHECK_TIMEOUT_MS`, which beats the documented 600000 ms default; a killed check is
  `TIMEOUT` and an over-printing one is `OUTPUT-LIMIT` — neither is ever reported as a failed
  check, and a nonsense limit warns and falls through instead of disabling the bound. Layer gates
  run through the same launcher with their own shorter budget.

### Fixed

- **A killed check's whole process tree is killed — and a kill that fails is no longer silent.**
  The engine used to kill only its own child, so on Windows the `cmd.exe` shim died while the
  real check lived on and could write after the engine had declared "no verdict". Each check now
  runs under a launcher that enforces the time and output bounds itself and kills the tree before
  reporting. When that kill cannot be confirmed, the console warns next to the verdict and the
  fact is journalled in one `check-run` row with **no status change** — previously a leaked
  process was invisible. Pinned by `scripts/test-timeout-kills-tree.mjs` and
  `scripts/test-kill-failure-reported.mjs`.
- **`ENOBUFS` was misreported as a timeout, and `timeout: 0` disabled the limit entirely.**
  A full pipe is now its own outcome (`OUTPUT-LIMIT`, 16 MiB, `PB_CHECK_MAX_OUTPUT_BYTES`) and a
  numeric limit that cannot be used warns and falls through to the next source, because Node
  reads `0` as "never time out". Pinned by `scripts/test-check-runner-limits.mjs`.
- **`pb worker remove` could empty the real `node_modules`.** Teardown followed a junction or
  symlink out of the worktree and deleted the target's contents; project-memory rule 27 records
  the incident. Removal now `lstat`s the tree, unlinks every link **as a link**, and refuses
  (naming the path, deleting nothing) rather than follow one. Pinned by
  `scripts/test-worker-remove-links.mjs`.
- **`pb attach` could corrupt a JSON backlog**, and `pb plan --dep` accepted a card that broke
  another card's ordering (including one it landed on only indirectly). Both are refused before
  anything is written; pinned by `scripts/test-room-write-primitives.mjs` and
  `scripts/test-plan-linkage.mjs`.
- **`pb scaffold` silently accepted flags it did not read** (`--goal` looked accepted and did
  nothing), and `pb-daily-monitor.mjs --help` performed a REAL iteration — it adopted whatever
  loop was active and scaffolded work into it. A `--help` is a read; unknown flags refuse.
  Pinned by `scripts/test-scaffold-lifecycle.mjs` and `scripts/test-daily-monitor-help-inert.mjs`.
- **Version lifecycle races.** A claim could move under a lifecycle change, and worker effects
  could commit unserialized; both are refused/serialized now, with long worker operations on a
  tracked lease so other agents can still record. Pinned by `scripts/test-version-races.mjs`.
- **A test asserted the contract the engine had already improved.** `test-check-timeout.mjs`
  required that a refused `record --status done` write NO journal row, which is true only when
  the check's process tree is confirmed dead. On a machine where `taskkill /T /F` cannot prove it
  (measured on Windows: exit 128, "The operation attempted is not supported"), the engine
  correctly journals its one `check-run` trace — so a correct refusal was reported as a red
  suite. The assertion now pins both worlds: a refusal never changes a task's status, and the
  `check-run` trace appears **exactly** when the console warned the kill was unconfirmed.

## 0.7.1 — the peer range that locked the plugin out, and a gate that had stopped checking

Patch. No engine behaviour changes; the playbook surface is identical to 0.7.0.

### Fixed

- **The plugin could not be installed into any profile on dsh `0.2.0-rc.2`.** Its three
  `@deepseek-ai/dsh*` peers were caret ranges on a `0.x` line — `^0.1.5-rc.2` means
  `>=0.1.5-rc.2 <0.2.0`, the same 0.x caret trap this repository already documents for profile
  upgrades — and the runtime's compatibility gate compares those ranges against the **runtime**
  version, not against the peer package's own version. So the install stopped with

      dsh: installation rejected: Plugin dsh-agents-playbook@0.7.0 is incompatible with dsh 0.2.0-rc.2:
      peerDependencies {"@deepseek-ai/dsh-llm":"^0.1.5-rc.2", ...}

  The three ranges now span the supported lines explicitly (`>=0.1.5-rc.2 <0.3.0`), which
  satisfies both `0.1.5-rc.2` and `0.2.0-rc.2`. Every API the plugin actually calls still exists
  in the 0.2.0-rc.2 runtime — `defineTool` (dsh-tools), `createUserMessage` (dsh-llm), the
  `agent/pre-step` and `agent/turn-stopping` hooks, `workspaceRegistry`, `skills.registerProvider`,
  `agent.steer()` — so this was a stale declaration, not a real incompatibility. The range is
  declaration only: profiles run with `autoInstallPeers: false`, so the harness supplies those
  peers and nothing is installed from the range.
- **`pack:plugin` had stopped checking whether the tarball carries the engine.** npm 11 answers
  `npm pack --json` with an array; npm 12 answers with an object keyed by package name. The gate
  read `parsed[0]`, so under npm 12 it fell through to a branch that printed the raw output and
  exited 0 — a green result from a check that had quietly stopped running. The shape is now
  decoded in one place (`scripts/lib/npm-pack.mjs`), and an unrecognized result is a hard failure
  instead of a pass. The identical assumption aborted `test-dsh-plugin-published.mjs` — loudly,
  which is how the silent one was found. Pinned by `scripts/test-npm-pack-shape.mjs` (11
  assertions), which is mostly about the failure path: the happy path never noticed.
- `package-lock.json` now carries the released version; the 0.7.0 release commit left it at 0.6.2.

## 0.7.0 — layered planning, human-gated branches, and two gates that could not be trusted

Minor. New planning surface; existing playbooks that declare no `layers` behave exactly as before.

### Added

- **Layered planning (`layers:` in the master, `layer:` on a task).** `dependencies` orders
  individual tasks; a layer is a named stratum (substrate → data → domain → interface) and may
  carry a **gate** — a shell command that must exit 0 before anything in a *higher* layer is
  claimable. A task's layer is **derived** from its dependencies (1 + its deepest dependency) and
  a declared `layer:` is a **constraint** `pb validate` enforces, so an edge that silently pushes
  work deeper fails the guardrail instead of quietly contradicting the declaration. A finished
  layer whose gate is red still holds the layer above: ticking off every task is not the claim
  that a stratum is sound. Tasks with no `layer:` are unconstrained in both directions, so layers
  can be adopted incrementally.
- **`pb plan --layers [--check-gates] [--strict] [--json]` — a dry run.** Reports derived layers,
  per-layer gate state, group *and* gate blockers, the ready set, the derived order and the
  critical path. It executes no `acceptance_check`, and it fingerprints the backlog, journal,
  state and cycle brief before rendering and exits 3 if any of them changed — the dry run proves
  its own read-only-ness rather than promising it. Gate commands run only under `--check-gates`;
  exit 2 = structurally invalid (cycle, unknown layer, a layer earlier than its dependencies) or
  a checked gate failing; 1 = `--strict` with work open. An **unverified** gate blocks a claim
  rather than being assumed green, and enforcement covers all three selection paths (`pb next`,
  the host payload, `pb loop run --auto`).
- Gate results are memoized **per planning pass** and cleared between plans, because keying the
  memo by command text alone let one playbook's verdict leak into another's tree.
- **Human-gated layers (`human: true`), and one batch instead of stop-and-go.** Some gates only a
  person can satisfy — buy the domain, provision the database, issue the credential. Declaring
  `human: true` changes reporting and hand-off, never whether the gate gates. A failing gate now
  blocks only its own branch (work *at* that layer, in unrelated layers, and unlayered work stay
  claimable), `pb plan --layers --check-gates` collects every human-gated layer into one
  `WAITING ON A HUMAN` batch — each gate command plus every task it holds up — and
  `pb loop run --auto` reports that batch and ends `Status: stalled` instead of printing
  "Autonomous run complete." while whole layers sit behind a red gate. That last part was the
  real defect: gate-blocked work is filtered out of `claimable`, so the run was confidently wrong
  about being finished. Pinned by `scripts/test-human-gates.mjs` (26 assertions), including that an
  **unmarked** gate keeps exactly its previous semantics.

### Fixed

- **A blocked task replayed as `todo`, so the drift alarm blamed healthy state.** The state
  reconstruction read the `release` *action* before a terminal *status*, so every
  `pb record --status blocked` row was replayed as unclaimed work. `pb repair-state --check`
  reported drift on healthy projections, and its suggested `--apply` "repair" would have
  resurrected finished blocked work as todo. A terminal status now wins over the release action.
  Pinned by `scripts/test-repair-terminal-release.mjs` (RED first: 5 of 9 assertions failed on the
  old code).
- **`shellSplit` deleted quotes inside an unquoted token**, so the most ordinary check shape there
  is — `node -e "process.exit(require('fs').existsSync('x')?0:1)"` — reached node as
  `require(fs)` and died with `ERR_INVALID_ARG_TYPE`. That is a gate which can never go green, and
  it sat under every `acceptance_check` *and* every layer gate. A quote is now syntax only where a
  word begins; empty quoted arguments are preserved; the divergence from POSIX concatenation is
  documented and pinned by `scripts/test-shell-split-quotes.mjs`.
- **A task naming an undeclared layer crashed the planner** with a `TypeError` on an undefined
  bucket instead of reporting the problem. It is now a plan problem and a `pb validate` failure.

## 0.6.3 — the entry point catches up, and the OpenCode adapter goes multi-agent

Patch. No engine gate behaviour changed.

### Added

- **OpenCode adapter — multi-agent identity.** Every shell and every plugin heartbeat now carries
  `PB_ROOT`, `PB_RUNTIME=opencode`, a stable session-scoped `PB_AGENT_ID`, `PB_SESSION_ID`, and any
  delegated `PB_AGENT_CHAIN` / `PB_PARENT_AGENT_ID` / `PB_CLAIM_TOKEN` the launcher set. Records are
  attributable to the session instead of an anonymous `agent`, so two OpenCode sessions can share one
  backlog without impersonating each other. The adapter never mints a claim token. Pinned by the new
  `multi` part of `check-opencode-adapter.mjs`, now wired into `npm test`.

### Fixed

- **The entry point now describes the engine that ships.** `SKILL.md` was silent about **modes** (the
  catalog, `pb mode show`, and mode-local skills under `modes/<mode>/skills/…`), so its skills-first
  routing rule sent a literal reader to a path that does not exist for mode-local skills. It now
  documents modes, the autonomous runner (`pb loop run --auto`), flows (`pb-flow.mjs` / `flows/`), and
  the harness plugin's real install state. `scripts/check-entry-docs.mjs` asserts mode/orchestrator
  coverage, so the entry point cannot drift silently again.
- **`pb help` lists the `mode` verb**, which existed in the dispatcher but was undocumented (only
  `list modes` was shown).
- **The master said the cycle brief had "four" questions**; the engine ships five. Corrected, with a
  master/entry/engine agreement check in `check-entry-docs.mjs`.

## 0.6.2 — the plugin takes the plural name

Patch. No engine behaviour changed.

### Changed

- **The npm plugin is `dsh-agents-playbook` (plural).** The previous singular spelling is
  retired; the rename makes the plugin agree with the engine (`agents-playbook`) and the repository. The
  `name` in `dsh-plugin/package.json`, the mounted row in `dsh-plugin/cordis.patch.yml`, every
  install instruction, and the self-dependency guard all move together. Publishing the new
  name is a fresh package — the old one is not a upgrade target, so profiles install
  `dsh-agents-playbook@^0.6.2` explicitly.
- The self-dependency guard and the bundle/version checks are unchanged: they compare against
  whatever `name` the manifest declares, so the rename cannot smuggle a self-reference back in.

## 0.6.1 — the repository takes the plural name

Patch. No engine behaviour changed.

### Changed

- **The GitHub repository is `agents-playbook` (plural).** It was renamed from the singular
  spelling to match the npm engine and the install directory the naming rule had already
  settled on, so every repository URL — `package.json`, `dsh-plugin/package.json`, the
  plugin README, the blogwatch pack source, `RELEASE.md` — and the `pb update` default now
  point at `github.com/riverho/agents-playbook`. The singular URL redirects, but the recorded
  name is the honest one.
- **The README is English-only.** The 繁體中文 half duplicated the English content section
  for section; it is removed so there is one source to keep current.

## 0.6.0 — the right workspace, no self-dependency, and the Stop gate

Minor, not patch: alongside two defect fixes that 0.5.1 shipped, this release adds the first
mechanism that **enforces** the loop instead of asking the agent to honour it. The fixes alone
would have been a patch; the Stop gate changes default turn behaviour, so the pair moves the
minor. Both defects were invisible in the source tree, which is the only reason they got out.

### Fixed

- **The plugin depended on ITSELF.** `dsh-plugin/package.json` listed `dsh-agents-playbook` in
  its own `dependencies` — what running `npm install dsh-agents-playbook` from inside
  `dsh-plugin/` leaves behind. 0.5.1 published with it. It is not fatal (npm resolves a
  self-range to the installed copy, so there is no nested copy and the plugin loads), but every
  consumer resolved the plugin against itself. Removed — and `pack:plugin` now **refuses** to
  build a manifest whose `dependencies`, `devDependencies` or `optionalDependencies` names the
  package itself, because nothing about the source tree looks wrong when this happens. Proven
  by mutation: restoring the self-dependency fails the gate with the offending package named.

- **A session could adopt an unrelated project's playbook.** Workspace resolution was
  `agent?.session?.cwd || agent?.cwd || process.cwd()`. `session.cwd` is optional
  session-creation metadata and is unset in a live session, so it fell through to
  `process.cwd()` — the DSH **server's** launch directory, not the session's workspace. Every
  session that server hosted then inherited whichever project the server happened to start in:
  a session whose workspace was one project reported another's `status`, and `action=init`
  scaffolded a playbook *into that other project*. The workspace now comes from
  `ctx.workspaceRegistry` (session id → owned directory); `process.cwd()` is gone from both the
  tool and the skill provider; and when no workspace resolves the plugin **refuses**
  (`unknown workspace`) instead of guessing. `scripts/test-dsh-plugin-workspace.mjs` pins it,
  built so `process.cwd()` points at a *different* playbook than the registry — reverting the
  fix turns it red, reporting the wrong project by name.

- **The legacy singular install directory is discoverable again.** Projects scaffolded before
  the spelling settled carry `.agent-playbook`; discovery knew only `.agents-playbook`,
  `.playbook` and `agent-playbook`, so those playbooks were invisible to the plugin. Two
  projects in this workspace were affected and have been migrated to the plural.

### Documented

- The naming rule, at the point of use (`NESTED_PLAYBOOK_DIRS`) and in the README, in both
  languages: `agents-playbook` (plural) is canonical *because the singular npm name was already
  taken*, so the published engine took the plural and the install directory followed;
  `.agent-playbook` (singular) is a supported legacy alias, not a second convention. Recording
  the reason is the point — it keeps being re-litigated as if it were a preference.
- The plugin README states which workspace the plugin uses and what it does when it cannot
  resolve one.

### Added — the Stop gate: the runtime now enforces what the loop only asked for

Everything else in the plugin *asks* the agent to verify. This is the first place the harness
**refuses**: when a turn would otherwise close while the agent still holds a claim it never
resolved, the turn is held open and the model is told which task to resolve and how. It is the
project's own thesis — "done is an enforced exit code" — applied one layer up, where the agent
cannot simply decline to cooperate.

It rests on `agent/turn-stopping`, which fires as a turn would otherwise close; a handler that
calls `agent.steer()` keeps it open (the loop re-tests `inbox.nextStep.length === 0` *after* the
dispatch, so steering — not the dispatch — is what buys another step). The contract is pinned by
`scripts/test-dsh-stop-gate.mjs`, which drives the REAL dispatch machinery rather than a stub and
includes a negative control; the loop behaviour was confirmed in a live headless session, where
fire 1 steered and fire 2 arrived for the same turn with the model answering the steer text.

It is deliberately **timid**, because the harness documents the opposite failure — a handler that
blocks unconditionally force-continues *every* step. A given claim is reminded about at most
**once**, the session caps the total, and the steer text says so. Configurable via `stopGate`
(default `true`); `false` makes the loop advisory again.

## 0.5.1 — the plugin's first published revision

Patch. 0.5.0 published the plugin to npm for the first time (as `dsh-agents-playbook`, matching
the engine's unscoped convention); 0.5.1 carries the corrections that first publication
surfaced. No engine behaviour changed.

### Fixed

- **The plugin is `dsh-agents-playbook`, unscoped.** The earlier `@riverho/dsh-agents-playbook`
  name could not be published from this account at all: the `@riverho` npm scope belongs to a
  different npm user, and npm answers a publish you may not make with `404`, not `403`. Verified
  by `npm org ls` — that command lists an org's MEMBERS, so `someone - owner` means that user
  owns the scope, not that you do. `dsh-plugin/package.json` and the `name` in
  `dsh-plugin/cordis.patch.yml` (the row the loader mounts by) move together.
- **The plugin suites no longer hardcode the install path.** They place the package at
  `node_modules/<pluginPkg.name>`, which is the correct layout for a scoped and an unscoped
  name alike, so a future rename cannot silently relocate the package under test.
- **js-yaml 4.2.0 → 4.3.2** (advisory: quadratic CPU consumption via `!!omap` resolution,
  merge-key chains, and `maxTotalMergeKeys` on empty merge sources). In range for the existing
  `^4.1.0` declaration, so no manifest change.

### Documentation

- The plugin's install instruction is now the one command it actually is:
  `dsh plugin --profile <profile> add dsh-agents-playbook`. `dsh plugin` forwards to pnpm inside
  the profile and then reconciles `dsh.profile.bundles`, appending any dependency whose package
  declares `dsh.bundle.patch` — so there is no bundle list to edit by hand. The manual route is
  kept as the alternative.
- README marks the plugin **published** (both languages) instead of "not on npm yet", and warns
  that the engine is `agents-playbook` (plural) while the singular `agent-playbook` on npm is an
  unrelated package by another author.
- `RELEASE.md` records why the plugin is deliberately unscoped, so it is not "tidied" back into
  a scope that cannot publish.
- `CHANGELOG.md`, `SKILL.md` and `memory/project-memory.md` follow the rename.

### Known, deliberately not fixed

- The bundle cache in `scripts/pack-dsh-plugin.mjs` is version-based: editing an engine file
  without bumping the version ships a stale bundle silently. This release was rebuilt with
  `--force` for exactly that reason.

## 0.5.0 — multi-agent leases, complete worktrees, crash recovery, DSH plugin

Minor, not patch: the release adds a multi-agent coordination model and a harness
integration. Existing single-agent playbooks keep working unchanged — `pb next --claim`,
`pb record`, and `acceptance_checks` behave as before.

> **Numbering note.** 0.4.0 was already used upstream for the tracked-state trap guard
> (`87153a1`/`16ed043`), which is unrelated to this work. This release carries that guard
> forward and takes the next minor.

### Inherited and fixed: the tracked-state trap guard

The guard (runtime state committed to git gets reverted by merges, silently erasing
records) shipped with two defects that made it inert or fatal, both fixed here:

- `execSync('git rev-parse --show-toplevel 2>/dev/null')` — the redirection is POSIX shell
  syntax, so under `cmd.exe` the command always failed and the guard returned early. It
  **never fired on Windows**, which is where it was needed. Now `execFileSync` with stdio
  options: no shell, no redirect, portable.
- `require('child_process')` inside an ESM module, where `require` is undefined — past the
  first defect it would have thrown a `ReferenceError` out of `pb validate`. The top-level
  import was already there.
- The path comparison now normalises separators: git reports the toplevel with forward
  slashes while `resolve` yields backslashes on Windows, so a raw comparison concluded
  "outside the repo" and disabled the guard.

Verified against this repository: `pb validate` now warns, `pb validate --strict` exits 1,
and the "rows newer than the last commit" branch is correctly silent (the journal's newest
row predates its last commit).

### Multi-agent safety (`scripts/pb.mjs`, `scripts/test-concurrency-state.mjs`)

- **One serialized transaction for all shared state.** Every write to
  `backlog-state.json` takes an O_EXCL lock, re-reads inside the critical section, and
  replaces the file atomically. The previous read-modify-write of the whole object
  silently discarded concurrent writers' changes — proved by mutation: disabling the lock
  turns the regression suite red with real lost updates.
- **Ordering is a recorded fact.** Each journal row carries a monotonic `seq` and the
  writer; the journal row and the state touch commit in one transaction, so the two
  records can never disagree about who wrote last.
- **A claim is a lease.** `pb next --claim` mints a claim token. A writer proves
  entitlement three ways — it is the holder, it presents the token, or the holder appears
  in its declared delegation chain (`PB_AGENT_CHAIN`). A sub-agent records as **itself**,
  with `ownership: token|chain` on the row.
- **Unproven writes are flagged, not dropped** (`ownership: unproven`): losing real work
  is worse than an unproven row.
- `pb release` returns a claim to the pool (`--stale <minutes>` sweeps abandoned ones).
- **Locks break on age only, never on a liveness probe.** A pid probe misreported live
  holders as dead on Windows, letting a waiter steal an active lock — the exact
  corruption the layer exists to prevent. Release is token-guarded; per-lock stale
  windows; `pb unlock [--force]` is the explicit escape hatch.

### Worktrees (`pb worker …`, `scripts/test-worker-worktree.mjs`)

- Atomic slot acquisition: **one live slot per task**, so two agents cannot both open a
  worker for the same task and leave an orphan worktree.
- `worker status` (ahead/behind/uncommitted/head), `worker exec -- <cmd>`,
  `worker verify` (runs the task's checks **inside** the worktree), and `worker merge`
  behind the merge gate.
- The merge gate reads the **branch**, not just the journal: a worktree that is missing,
  dirty, or has zero commits ahead of its base cannot be merged; a stale verification is
  reported rather than trusted.
- `pb record --status done --at <worktree>` records checks that ran in the worker tree,
  closing the ordering hole where a worker-only artifact could not be recorded honestly.

### Crash recovery (`pb repair-state`, `scripts/test-repair-state.mjs`)

- The journal is the record; `backlog-state.json` is a projection. `--check` exits 1 on
  drift (CI-wireable), `--apply` rebuilds, `--strict` drops what the journal cannot
  justify. Scoped to the current backlog, and projection-only fields (worker/checker/
  provider) are **preserved** — deleting them would be data loss dressed up as a repair.
- `pb checkpoint` reports drift and a journal-ahead-of-projection gap as warnings.

### Engine as a library (`scripts/test-engine-api.mjs`)

- Importing `scripts/pb.mjs` no longer runs a command; it exports a **read-only** API
  (`status`, `tasks`, `task`, `journal`, `validate`, `workerStatus`, `mergeReady`,
  `claimOwnership`) plus resolved paths. Mutations stay on the CLI on purpose: every
  command reports refusal with `process.exit()`, which would kill an in-process host.

### DeepSeek Harness plugin (`dsh-plugin/`, `dsh-agents-playbook`)

- One `playbook` tool — `status / anchor / next / claim / task / check / record / worker /
  init / unlock / repair` — plus context injection that stages the North Star, active
  loop, task in hand and **its acceptance checks** on the agent inbox each step, so
  compaction cannot lose the plot. Injection prefers `agent.inject()` (the API built for
  model-facing context, which queues without waking the driver) and falls back to
  `inbox.append('next-step', …)` when that member is absent. The pre-step hook is an
  observer: a rejected step stays rejected, and an aborted step stages nothing.
- Registers the playbook's own skills as harness skills, namespaced `playbook-<id>` so
  they cannot shadow an unrelated harness skill. The catalog comes from the ENGINE's own
  resolution (`pb list skills --json`), so mode-local skills are included without
  re-implementing anything; bodies load on demand and are prefixed with the process file
  the engine's skills-first routing keys on.
- `pb list skills|modes --json` added to the engine so a host consumes the resolved
  catalogs as data instead of parsing a human table.
- Stamps `PB_AGENT_ID` / `PB_SESSION_ID` / `PB_PARENT_AGENT_ID` / `PB_AGENT_CHAIN` /
  `PB_CLAIM_TOKEN` / `PB_RUNTIME` on every engine call, which is what makes fan-out
  attributable.
- **Bundles the engine**, so installation is one step and cannot drift from the engine it
  was tested against. `action=init` scaffolds and hydrates a workspace playbook from it;
  the workspace copy then takes over (self-hosting). A workspace playbook always wins over
  the bundle, and the bundle is never a target.
- Shells out rather than importing, so the engine's exit codes remain the contract and a
  refusal can never terminate the host.
- The skill registry is a **runtime** dependency (`ctx.inject`), not a declared one: cordis
  refuses to activate a plugin at all while any declared `inject` entry is missing, so
  declaring `skills` would have made the whole plugin — tool included — vanish silently in a
  profile that ships tools without skills.

### Fixed

- `test-pack-build` / `test-pack-roundtrip` asserted on LF-only output and on a
  comment-sensitive line regex; both failed on Windows/after comment changes and were
  passing for the wrong reasons.
- `git worktree add` and `git merge` wrote human chatter to stdout, corrupting `--json`
  payloads — surfaced as the consumer's parse error, not the writer's bug.

### Verified before publishing

- `test-dsh-plugin-resolution.mjs`: package **resolution** from a profile-shaped directory —
  the plugin, its entry, its `core` subpath and every declared peer resolve; the plugin module
  imports; and the engine copy it scaffolds finds `js-yaml` by walking up the project, which is
  what makes a scaffolded playbook runnable.
- `test-dsh-plugin-profile.mjs`: the plugin is mounted on top of a **real profile** through the
  `--patch` overlay and the composed tree read back — proving the loader accepts the patch
  shape (a rejected patch is a silent no-op), that the composed config matches the plugin's
  declared defaults, and that every API the plugin calls (`SkillRegistry.registerProvider`,
  `defineTool`, `createUserMessage`) exists in the shipped harness packages.
- `test-dsh-plugin-published.mjs`: the real tarball is packed, extracted as npm would
  install it, and used to scaffold + hydrate a workspace playbook that validates and
  orients. This catches packaging mistakes a source-tree suite structurally cannot —
  a path that only resolves because we are in the repo root, a file excluded by `files`,
  a build step that did not run.
- `test-dsh-plugin-index.mjs`: the module loads against the **real** harness packages and
  its tool is executed against a real playbook, with the skill provider driven through a
  stub `ctx` (list → pick → load).
- `test-auto-attribution.mjs`: the autonomous runner's rows are proven, not merely
  attributed — and an unentitled write is still flagged, so the flag keeps its meaning.
