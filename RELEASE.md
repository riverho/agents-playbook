# Release checklist — two tracks

The engine and the DeepSeek Harness plugin ship from this one repository. The plugin
**bundles** the engine, so a deployment does one install and cannot drift from the engine
it was tested against. That is why both carry the same version and why a build script —
not a hand copy — produces the bundle.

| Track | Artifact | Where |
|---|---|---|
| GitHub (Open Source) | this repository | `github.com/riverho/agents-playbook` |
| npm — engine | `agents-playbook@<version>` | `npmjs.com/package/agents-playbook` |
| npm — DSH plugin | `dsh-agents-playbook@<version>` | `npmjs.com/package/dsh-agents-playbook` |

## 1. Bump the version, in three places

The version is the only thing tying the pair together, so it is checked rather than
trusted:

- `playbook.yaml` — `version:`
- `package.json` — `"version"`
- `dsh-plugin/package.json` — `"version"` (must equal the engine's; `pack:plugin` refuses otherwise)

```bash
npm run check:version
```

## 2. Green before shipping

```bash
npm test                      # engine + plugin suites
node scripts/pb.mjs validate  # structural guardrails
node scripts/pb.mjs repair-state --check   # projection agrees with the journal
```

The plugin suites skip honestly when their prerequisites are absent, so a green run that
contains a `SKIP` line means those assertions did **not** run. To run them:

```bash
npm run build:plugin                          # the bundle suites need the bundle
DSH_PACKAGES=<path to a @deepseek-ai directory> npm test   # the index suite needs the harness
```

Suite totals: engine 29+28+22+15+12+4+5 concurrency/worktree/recovery/API/attribution
assertions; plugin 57 (core) + 31 (bundle) + 15 (profile composition) + 29 (entry against
the real harness) + 14 (the packed tarball).

## 3. Build and verify the plugin tarball

```bash
npm run build:plugin          # bundle the engine into dsh-plugin/engine/ (generated)
npm run pack:plugin           # build + manifest checks + npm pack --dry-run
```

`pack:plugin` fails unless the bundle is complete, self-validating, free of this
repository's own state, and actually present in the tarball's file list. It also refuses
a version mismatch between the plugin and the engine it carries.

## 4. Human-only steps

These leave the machine and are not run automatically:

```bash
# GitHub
git add -A && git commit -m "release: <version>"
git push origin main
git tag v<version> && git push origin v<version>

# npm — engine
npm publish                    # from the repository root

# npm — DSH plugin (requires the build from step 3)
cd dsh-plugin && npm publish
```

`dsh-plugin/engine/` is generated and gitignored; it is created by step 3 and is only ever
shipped inside the tarball.

The plugin is published **unscoped** (`dsh-agents-playbook`), so `npm publish` needs no
`--access` flag — unscoped packages are public by default. It is deliberately NOT under a
scope: the earlier `@riverho/...` name was unpublishable from this account (the `@riverho`
npm scope belongs to a different npm user, and npm answers a publish you may not make with
`404`, not `403`). Do not "tidy" it back into a scope without checking `npm org ls <scope>`
first — that listing shows the org's MEMBERS, so `someone - owner` means that user owns it,
not that you do.

## 5. After publishing

- `npm view agents-playbook version` and `npm view dsh-agents-playbook version`
  must both equal `<version>`.
- Install the plugin into a profile and confirm `playbook action=status` orients and
  `playbook action=init` scaffolds a workspace playbook — that is the end-to-end proof the
  bundle is intact.

### Publishing is ASYNC — a missing version is not a failure

npm now answers a publish with `202 Accepted` and processes it in the background. The command
exits `0` with `info ok` while the version is **still invisible** to `npm view` and 404s if
fetched by exact version. The log says so, in one line that is easy to miss:

```
notice Your package is being processed and may take a few minutes to become available.
http fetch PUT 202 https://registry.npmjs.org/<pkg>
verbose exit 0
info ok
```

Measured on v0.6.0: roughly **3.5 minutes** from PUT to `npm view` seeing it. So before
concluding a release failed — and burning another browser 2FA round — check the log's exit
status first, then wait. `npm view <pkg> versions` (plural) is the reliable read while the
`latest` dist-tag is still settling.

### Upgrading a profile needs an explicit range

A profile installs with a caret range, and **`^0.6.1` does not include `0.7.0`** — for `0.x`,
caret is restricted to the same minor. So `dsh plugin --profile <p> add <pkg>` reports
"Lockfile is up to date, resolution step is skipped" and changes nothing. Move the range
explicitly:

```bash
dsh plugin --profile <profile> add dsh-agents-playbook@^<version>
```

pnpm may also record a `minimumReleaseAgeExclude` entry for a just-published version: that is
its supply-chain guard noting a deliberate exception, not an error.

### The same 0.x caret trap blocks the INSTALL, not just the upgrade

A plugin's `@deepseek-ai/dsh*` peer ranges are checked against the **runtime** version
(`evaluatePluginCompatibility` in `@deepseek-ai/dsh-app-boot`), not against the peer package's own
version, and the check only looks at peers named `@deepseek-ai/dsh` or `@deepseek-ai/dsh-*`
(`@deepseek-ai/cordis` and `schemastery` are not gated at all). `^0.1.5-rc.2` therefore means
`>=0.1.5-rc.2 <0.2.0`, and dsh `0.2.0-rc.2` is rejected before anything installs:

```
dsh: installation rejected: Plugin dsh-agents-playbook@0.7.0 is incompatible with dsh 0.2.0-rc.2:
peerDependencies {"@deepseek-ai/dsh-llm":"^0.1.5-rc.2", ...}
```

Declare the intended span explicitly (`>=0.1.5-rc.2 <0.3.0`) rather than a caret on a 0.x line.
If a build still has to ship with a stale range, the runtime offers an exact-version exemption,
stored per profile in `compatibility.json` and matched on an exact runtime version:

```bash
dsh plugin --profile <profile> allow-version <pkg>@<version> --dsh-version <exact> --accept-risk
dsh plugin --profile <profile> version-exemptions
dsh plugin --profile <profile> revoke-version <pkg>@<version> --dsh-version <exact>
```

Grant it only after checking that the APIs the plugin calls still exist in the running runtime:
the exemption suppresses the gate, it does not make the plugin compatible.

## What the release does NOT claim

- The plugin has not been exercised inside a **live** harness session. Four layers are
  verified instead, and the gap is deliberate rather than overlooked:
  1. `test-dsh-plugin-core.mjs` — host-independent logic (identity, discovery, subprocess
     results, context rendering, skill catalog) with plain node.
  2. `test-dsh-plugin-profile.mjs` — the plugin is mounted ON TOP OF A REAL PROFILE via the
     `--patch` overlay and the composed tree is read back, proving the loader accepts the
     patch shape (a rejected patch is a silent no-op) and that every API the plugin calls
     (`SkillRegistry.registerProvider`, `defineTool`, `createUserMessage`) exists in the
     shipped packages.
  3. `test-dsh-plugin-index.mjs` — the module loads against the real harness packages with a
     stub `ctx`; its tool runs against a real playbook; the skill provider is driven
     list → pick → load.
  4. `test-dsh-plugin-published.mjs` — the real tarball is packed, extracted as npm would
     install it, and used to bootstrap a workspace playbook that validates and orients.
  What none of these prove is that a **live session** behaves well — whether the injected
  context actually helps a model, whether the tool's results read well in practice. That is
  step 5 and stays a human step on purpose: a plugin that loads is not a plugin that is
  useful.
- `--dump-config` composes the profile tree without importing the plugin modules, so the
  profile suite proves composition. Package resolution depends on the launcher's module
  fallback, which is why the plugin ships its engine rather than relying on a resolvable
  engine install.
- Multi-worker safety uses a single-machine file-lock model (O_EXCL lock + atomic replace,
  age-based stale breaking). It is not a distributed lock: two machines sharing a network
  path is unsupported and untested.
- Playbook skills are exposed to the harness, but mode-local skills are included only through
  the engine's own resolution — if a mode is not the active default, its skills are not in
  the catalog.
