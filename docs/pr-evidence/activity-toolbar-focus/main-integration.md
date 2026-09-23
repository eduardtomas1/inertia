# PR #457 integration with reviewed main

This records validation at `a0e20dbd`, before the subsequent
[pending-attachment and availability follow-up](attachment-pending-admission.md).

## Exact integration

On 2026-09-23, an ordinary, conflict-free merge combined PR head
`86ee569222714dca46dd09ae33cb5a52682d3367` with reviewed main
`558395da97498dd06201d7e5802b446272afd56c` (Working indicator, #454).
The merge commit is `f75e7bface59b95d1c5535efce631e1ca6f49a3a`, with those exact
parents. Its tree, `373092fdf2abb89ea0cad63149fa5a831b0610ef`, matches the
coordinator's independent merge preview. No conflict resolution or additional
source fix was required; no unmerged PR code was copied.

All nine existing PR source/test files are byte-for-byte unchanged from
`86ee5692`. Bundle budgets, build configuration, notice generator, package
manifest, and lockfile are identical to reviewed main. The existing installed
dependency graph was reused. This follow-up adds only evidence documentation
after the merge.

## Integrated local validation

Node 22.23.2, Electron 44.4.3, macOS ARM64:

| Check | Result |
| --- | --- |
| Focused unit/DOM/integration tests | 245 passed across 15 files; one native Windows case skipped; 8.62 s |
| Build and license generation (`npm run build:packaged`) | Passed, including production and Private Connect bundles and unchanged reviewed budgets |
| Isolated native toolbar/transcript/Working indicator cohort | Seven passed with two workers; 22.5 s |
| Display-sensitive native image follow-up | One passed with one worker; 16.8 s |
| Single final Node 22 `npm run check` | Passed: 9,767 tests across 906 files, plus seven subprocess tests; 146 platform tests and 16 files skipped; 115.01 s test phase |

Workflow concurrency, all 78 immutable migration entries, architecture, color
generation, lint, every typecheck, production/Private Connect builds, and
bundle gates passed. Measured JavaScript: workbench first load 806.8 / 808.1 KiB,
detached first load 618.6 / 618.8 KiB, core 2,100.7 / 2,102.3 KiB, deferred orb
21.3 / 22.0 KiB. No budget was raised by this PR or its integration.

The focused set covers workspace-panel opening focus and cleanup, composer
lifecycle/attachments, transcript anchors, both input-diagnostic helpers,
Windows installer-smoke output transport, Working indicator rendering/live
phases/settings, composite settings updates, migrations, detached runtime
authority, and packaged license/notice generation.

The native toolbar test preserves its original immediate navigation assertions
at 1440 × 920 and 420 × 760. Both transcript cases pass, including the completed
answer with its bounded diagnostic observer. All four Working indicator cases
pass: Classic defaults; keyboard selection and live chat updates; Automatic
chat/sidebar phase synchronization and reduced motion; settings restoration
after restart. The image case preserves exact image digests and queued/steered/
later follow-up assertions after durable attachment storage fills. All fixture
teardowns completed successfully.

The generated `THIRD_PARTY_NOTICES.txt` contains the vendored thinking-orbs
section and both required copyright holders. Packaging configuration and
native dependencies are unchanged. The new deferred orb chunk is exercised by
the native scenarios and checked by the bundle gate. No additional local
package, ZIP, or DMG smoke was warranted for this conflict-free integration;
earlier package results below are explicitly historical.

Local logs:

- `/tmp/inertia-pr457-integration-focused.log`
- `/tmp/inertia-pr457-integration-build.log`
- `/tmp/inertia-pr457-integration-native-isolated.log`
- `/tmp/inertia-pr457-integration-native-image.log`
- `/tmp/inertia-pr457-integration-check.log`

## Historical evidence and unresolved causes

These integrated results supersede old-base validation counts, not the limits
of the earlier diagnosis:

- `9846a221`: the focus fix's earlier 118 focused tests, toolbar/image native
  checks, ARM architecture, ad-hoc packaging/fuses, unpacked/ZIP/DMG smokes, and
  release asset/checksum checks passed. Those package results were not rerun
  on this integrated tree.
- `c1ceb4e4`: eight diagnostic tests, the actual Electron observer/sampler
  controls, a five-case native neighbor cohort, and the 9,690-test full gate
  were old-base results. See [input diagnostic evidence](anchor-input-diagnostics.md).
- `86ee5692`: 22 focused Windows-smoke tests and the 9,692-test full gate were
  old-base results. See [Windows query evidence](windows-process-query-diagnostics.md).

Three hosted causes remain unresolved: the [Intel DMG startup failure](https://github.com/eduardtomas1/inertia/actions/runs/35777810305/job/106915918696),
the [macOS ARM Send/window-destruction failure](https://github.com/eduardtomas1/inertia/actions/runs/35820397561/job/107050957549),
and the [Windows install-root query timeout](https://github.com/eduardtomas1/inertia/actions/runs/35824739433/job/107064228955).
The local passes do not establish their causes or prove them fixed. The input
observer and Windows phase markers improve bounded failure evidence; their
remaining ambiguity is documented in the linked reports. Existing deadlines,
assertions, process ownership, containment checks, and output limits remain
unchanged. No workflow, GPU, shutdown, discovery, or installed-guard workaround
was introduced.

Native Intel/Windows/Linux, PowerShell 5/CIM, signed installers, live providers,
and the full hosted workload were not exercised locally. No provider protocol
or platform discovery implementation changed. Hosted CI evaluation and PR
merge remain the coordinator's responsibility; this integration run did not
poll or rerun CI.
