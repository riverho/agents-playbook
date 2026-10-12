---
name: harness-lifecycle
description: Drive agents through the playbook's full lifecycle as of v0.8 — versions, the layered plan, the graph (Flow) room, human-in-the-loop, worker worktrees, and commit/push — without breaking the data schema or a person-only decision.
---

# Harness lifecycle (v0.8)

Canonical process: `processes/harness-lifecycle.yaml`

Use this skill when you **orchestrate** a version rather than execute one card. That
means planning a version's work, keeping a fleet of agents inside the contract,
watching the Flow room, answering or escalating to the person, managing worktrees, and
landing the result. To execute a single card, use `run-task`.

The rule underneath everything: **done is enforced, not declared.** A card is done
when `pb record --status done` re-ran its `acceptance_checks` and they exited 0.
Nothing else counts as done: not prose, not a green UI, not a checker's opinion.

---

## 1. Follow the current pb data schema

Every surface is versioned. Read the schema, never guess it. Write only through `pb`.

| Store / surface | Who writes it | Schema / shape |
|---|---|---|
| `memory/journal.ndjson` | **only** `pb` (append-only; never hand-edit) | one row per event: `seq` (total order), `ts`, `task`, `loop_id`, `agent`, `agent_id`, `action`, `status`, `ownership` (`token` / `chain` / `unproven` / `decision`), `agent_chain`, `notes` |
| `memory/backlog-state.json` | `pb` (a projection; `pb repair-state` rebuilds it from the journal) | per task: status, claim, `claim_token`, worker, checker |
| `memory/backlog.yaml` | `pb plan` (a person may edit task text) | task: `id`, `title`, `status`, `skill`, `mode`, `priority`, `layer`, `dependencies`, `acceptance_checks`, `check_timeout_ms`, `manual`, `human`, `version`, `kind` |
| `memory/loops.yaml` | `pb version …` / `pb loop …` | a version = a loop with `version`, `title`, `goal`, `stop`, `stop_checks`, `state` (`draft` → `open` → `frozen` → `closing` → `closed`), `retitles` |
| `pb graph --json` | read-only | `agent-playbook.graph.v1`: `start`, `goal`, `layers[]`, `nodes[]` (`cycle`, `claim`, `worker`, `checker`, `merge_ready`, `live`, `human`, `disposition`, `journal`), `edges[]` (dep inverted, spawn, hil), `human` batch |
| `pb state --json` | read-only | `agent-playbook.state.v1`: open version, phase, orchestrator state + last tick, counts, `journal_seq` / `change_token` |

**Before acting, every agent must:**
1. Run `pb anchor --brief` and `pb status`, and read `SKILL.md` and `memory/project-memory.md`.
2. Run `pb validate` and confirm it passes. A red validate means the data is wrong, so stop and fix it before planning anything.
3. Carry its identity on every shell: `PB_AGENT_ID`, plus `PB_CLAIM_TOKEN`
   (from `next --claim`) or `PB_AGENT_CHAIN=lead,worker` when it writes for another
   agent. A write the engine cannot attribute is stamped `ownership: unproven` and
   flagged, so attribute every write.

**Never:**
- hand-edit the journal;
- write `backlog-state.json` directly;
- invent a status (the only statuses are `todo`, `in_progress`, `blocked` and `done`);
- record done with `--skip-checks` unless a person tells you to (it is stamped on the row and flagged in reports).

The engine's refusals are the schema talking. A V-rule message (`V1`–`V7`) names the
rule and the fix. Read it and do what it says. Never route around it.

---

## 2. Slice the plan by layers, and verify it

Layers are the version's strata. `playbook.yaml` `layers:` declares each one as
`{id, name, about, gate}`. Nothing in a higher layer is claimable while a lower layer's
gate fails.

**Slicing rules**
- **L0, substrate:** state, locks, claims, the journal, gate machinery.
- **L1, surfaces:** the CLI, JSON, the plugin and adapters.
- **L2, orchestration:** flows, modes, autonomous runs, release and cross-repo work.
- A card's layer is **derived** as 1 + its deepest dependency. A declared `layer:` is a constraint, and `pb validate` rejects a card declared earlier than its dependencies.
- Declare dependencies **at birth**:
  `pb plan --goal ".." --dep <id> [--dep <id>] --layer <id> --check "<cmd>"`.
  `pb plan` refuses any card that would make the plan invalid. That includes a problem
  that lands on another card, such as an existing card that already depends on this id.
  A refusal writes nothing.
- Every card gets **executable** checks (`--check`, repeatable). A card with no checks
  is "done on your honor"; `pb validate --strict` treats that as fatal.
- A card only a person can close is `--manual`. Give it a `human:` block (`question`,
  `options[{id,label,effect}]`, `recommended`, `recommended_by`) so the room can ask it.
- Card kinds are `feature`, `fix`, `chore` and `experiment`. A frozen version accepts no features.

**Verify the slice before anyone claims a card:**
```bash
node scripts/pb.mjs validate                 # structure: layers, deps, human blocks, versions
node scripts/pb.mjs plan --layers --json     # dry run: derived layers, claimable now, order, critical path
node scripts/pb.mjs plan --layers --check-gates   # runs gates; prints the WAITING ON A HUMAN batch
node scripts/pb.mjs graph --json             # what the room will draw
```
For `plan --layers`, exit 2 means the plan is structurally invalid (a cycle, an
unknown layer, or a card earlier than its dependency). Fix that before dispatching.

---

## 3. Orchestrator notes: help the person during an agent run

The orchestrator **proposes**. It never decides, closes or merges.

**Tick on the cadence** (`orchestrator:` in `playbook.yaml`, e.g. `every_minutes: 15`):
```bash
node scripts/pb.mjs tick --dry-run     # read what it would release / ask / defer / choose
node scripts/pb.mjs tick               # one pass, exactly one tick row
```
Each tick does the following:
- releases claims quiet longer than `stale_claim_minutes`;
- asks open questions again on the `reprompt_minutes` schedule;
- routes around blocked, waiting and failing cards, writing one defer row each;
- proposes the next card and proposes closing when the stop checks pass.

**Read the room's messages regularly.** Do it on every tick and before every claim.
A person writes to agents from the Flow room ("Ask the agent", steer, comment), and those
messages land in the journal as `action: comment` rows with an `intent`
(`comment`, `steer`, `question` or `finding`).
```bash
node scripts/pb.mjs runcard show <id> --json   # a card's ordered thread
node scripts/pb.mjs status                     # recent journal, incl. comments
```
- **A `question`:** answer it on the same card:
  `pb comment --task <id> --text "Answer to seq N: …"`.
  If it asks for a lifecycle action, give the person the exact command (see below).
- **A `steer`:** treat it as a change to the plan. Re-plan, or record `blocked`, citing the seq.
- **A manual card / `human:` ask:** it waits for `pb decide --task <id> --option <id> --reason ".."`.
  That is one row and moves no status. An agent may recommend an option but must
  not decide in the person's place.

**Opening, blocking and closing cards (agent-allowed):**
- **Open:** `pb next --claim` mints a claim token. Hold one card in progress per agent.
- **Progress:** the room shows a card as *live*, with its stage flashing and an aura,
  only while its claim is held and a journal row is under 15 minutes old. Post
  `pb comment` or record steps as you go, so the person can see the work moving.
- **Block:** `pb record --task <id> --action <a> --status blocked --notes "why + what unblocks it"`.
- **Done:** `pb record --task <id> --action <a> --status done --notes ".."`. It re-runs the checks and refuses if they fail.
- **Give a claim back:** `pb release --task <id>`.

**Person-only (V6). Never run these from an agent; hand the person the command:**
`pb version freeze | close | carry | drop | retitle | release-operation`
and `pb version migrate --apply`. The engine refuses them when it sees any agent context
(`PB_RUNTIME`, `PB_SESSION_ID`, `PB_AGENT_CHAIN`, `PB_PARENT_AGENT_ID`, `PB_CLAIM_TOKEN`).
Write the request as a ready-to-run line, for example:
`node scripts/pb.mjs version drop <id> --reason "<why>"`.

**Version lifecycle at a glance**

| Stage | Command | Who runs it |
|---|---|---|
| Stage the next version | `version new --draft --name vX --goal .. --stop-check ..` | agent |
| Open it | `version open --name vX` | agent |
| Work its cards | | agents |
| Freeze it (fixes only) | `version freeze` | person |
| Carry or drop the open cards | `version carry <task> --to next`, `version drop <task> --reason ..` | person |
| Close it (stop checks must pass) | `version close` | person |

A closed version is read-only. To follow up on its work, fork a new card into the open version.

---

## 4. Worktree / branch management

Use a worker worktree for any card that runs in parallel with others, or is risky.
Every `worker` subcommand is a **dry run until `--execute`**.
```bash
pb worker create <task> --agent <name> --execute   # one winner per slot: branch agent/<task>-<agent>, sibling dir
pb worker status <task>                            # ahead / behind / uncommitted
pb worker exec <task> -- <cmd>                     # run IN the worktree
pb worker verify <task>                            # the card's checks, IN the worktree
pb worker checker <task> --verdict pass|risk|block --notes ".."   # an INDEPENDENT verdict
pb worker merge-ready <task>                       # exit-1 gate: status + checks + checker + freshness
pb worker merge <task> --execute                   # git merge --no-ff, only when merge-ready
pb worker remove <task> --delete-branch --execute  # tear down; unlinks links, never follows them
```
**Rules**
- **The checker is independent.** It is a separate agent or a person, never the author.
  Merge only after its verdict is `pass` and `merge-ready` exits 0.
- **Never junction or symlink `node_modules` into a worktree or fixture.** Copy it. A
  recursive delete that follows a link once emptied the real `node_modules`.
  `worker remove` unlinks links before deleting anything, and refuses rather than follow one.
- **Leave other agents' worktrees alone.** Leave a worktree you did not create for its
  owner, even if it looks stale. Report it instead.
- **Provider limits:** when a provider returns 403 or 429, run
  `pb worker provider-rate-limit <task> --provider <p> --retry-after <d>`. A cooldown
  is advisory: it shows on the card and does not block the merge gate.
- **A crashed worker that holds a version operation** is cleared by a person:
  `pb version release-operation --pid <pid> --reason ..`.

---

## 5. Commit and push

**Commit after each card, once its record is done:**
- Stage **only that card's files**. Use `git add <paths>`, never `git add -A`.
  `memory/` and `artifacts/` are runtime state and are gitignored. Never commit them.
- Run the gates before committing:
  - `pb validate`;
  - the card's checks (already run by `record --status done`);
  - anything the card touched:
    - `npm test` (run it in PowerShell on Windows; Git Bash's `tar` breaks the plugin pack test);
    - `node scripts/check-flow-room-app.mjs` for room changes, which builds and drives a real browser.
- If you changed a bundled file (`SKILL.md`, `AGENTS.md`, `playbook.yaml`, `README.md`,
  `INSTALL.md` or `scripts/pb.mjs`), run `npm run build:plugin`, so the plugin
  doesn't ship stale behaviour.
- If you edited a pinned room file, re-record it:
  `node scripts/check-app-source-provenance.mjs --record-edit <rel> --reason "<prior reason>; <new>"`.
- **Message:** start with the area (`pb:`, `room:`, `tests:`, `package:`). Say what the
  defect was and what the fix is, name the card id and the record seq, and say which
  test pins it (and that the old code fails that test).
- **One card, one commit.** When a file mixes two cards' changes, stage the hunks
  separately (`git apply --cached` on a filtered diff), or commit the cards in order.

**Push only when a person asks.**
- A push publishes. It is outward-facing and hard to undo.
- **Never** force-push, never push straight to a release branch, and never delete a
  remote branch on your own initiative.
- To release, use the `release` skill (`processes/release.yaml`): bump, tag, push,
  publish. The engine and the plugin are two separate release tracks (`RELEASE.md`).

---

## The loop, as an orchestrator runs it

```
orient    pb anchor --brief · pb status · pb validate · read the room's new comments
plan      pb plan --goal .. --dep .. --layer .. --check .. · pb plan --layers --json
dispatch  pb tick --dry-run → pb tick · pb next --claim (or pb worker create --execute)
watch     every tick: comments / questions / steers · stale claims · the human batch
land      record done (checks run) → checker pass → merge-ready → merge → remove → commit
close     hand the person: version carry/drop … · version close
report    pb report · pb reflect --notes ".."
```
