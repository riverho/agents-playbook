# Flow room — the dependence direction, retired

**Status:** retired 2026-10-11 by `plan-20261010-016`. Gate: `scripts/check-wenmei-retired.mjs`.

## What moved

The Flow room was built in the **Wenmei playground** (`wenmei/app_design`) as a design probe
(`plan-20261009-005`), then extracted into this repo as a first-level app at **`apps/flow-room`**
(`plan-20261010-011`), pinned to Wenmei commit **`33fdcea43af6a47df6d40028e749118ca61a0dea`** and
proved file-by-file by `scripts/check-app-source-provenance.mjs`.

## The rule, and which way it runs

**One way only.** This repo owns the room:

- `apps/flow-room` is the source of truth for the room's code. It builds, renders, is served by
  `pb ui`, ships inside the engine tarball, and renders as a panel in the Harness.
- **This repo never reads the Wenmei tree** — not at build time, not at run time, not in tests.
  `scripts/check-app-decoupled.mjs` proves the module graph; `check-wenmei-retired.mjs` proves the
  resolution graph (imports, requires, package dependencies, configured paths).
- **Wenmei never feeds the room.** The playground keeps a frozen copy for its own stage so that
  project keeps working, and that copy is marked retired in
  `app_design/TOMBSTONE.md`. Room features and room fixes belong here; a fix made only in the
  playground is a divergence, not a contribution.

The extraction deliberately **copied** the room's comments that name Wenmei ("copied, not depended
on: this app has no Wenmei import and no Wenmei runtime") and the fixture that records the
historical worktree paths. Those are provenance: they are why the copy can be audited years from
now. Retiring the dependence is not the same as deleting the history, and this gate fails on
**resolution**, never on vocabulary.

## Why this is worth a gate

Three ways the direction silently reverses, each of which has already been seen somewhere in this
repo's history:

1. Someone fixes a room bug in the playground because that is where they first saw it. The copy
   diverges, and the next person cannot tell which one ships.
2. A pin is recorded against a path that later stops existing — the original
   `PROVENANCE.json` named `…\Wenmei\wenmei\.worktrees\graph-room`, a worker worktree that was
   de-registered once it merged. The pin still *looked* auditable while pointing at nothing.
3. A convenience import reaches back into the other checkout, and the app stops being portable
   without anyone noticing.

## What the gate checks

| # | Assertion |
| --- | --- |
| 1 | No shipped file **resolves** a Wenmei path: no import, require, package dependency or configured path. Fixture data that *records* historical paths is counted and reported, not ignored. |
| 2 | `PROVENANCE.json` pins a full commit sha, names a source repo **that still exists**, does not point at a worktree, and records file hashes. |
| 3 | The playground carries `app_design/TOMBSTONE.md` naming `apps/flow-room`, this repo, the pinned commit and the direction. When no Wenmei checkout is reachable this **skips and says so** — an unreachable source must never read as a pass. |
| 4 | This record exists (the direction is written down where the room is maintained, not only asserted in a check). |

Unset `PB_FLOW_SOURCE` to point assertion 3 at a different checkout.
