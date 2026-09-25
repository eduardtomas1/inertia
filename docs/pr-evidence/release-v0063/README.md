# v0.0.63 release preparation

This preparation integrates main `30d54b56` (#473). The package and lockfile root
versions are already 0.0.63 on main (#467), so this candidate changes only the
changelog and this report.

The curated changelog combines the 0.0.62 and 0.0.63 notes into one 0.0.63
section, grouped as Workspace, Chat references, Conversations and attachments,
and Reliability and privacy. It covers the changes since `v0.0.61`, including
the published `v0.0.62` (peeled commit `3cd51121`), plus #467–#473:

- #467 Restore workspace surfaces and per-chat composer behavior.
- #468 Keep provider re-verification independent of native image release.
- #469 Run long native UI workflows as ordered checks.
- #470 Restore composer frame, input focus, and draft chat references.
- #471 Reference this chat and fit more of every referenced chat.
- #472 Keep the Claude thinking strip readable and mark context compaction.
- #473 Fix the stale running flicker and make Electron CI failures diagnosable.

## Local validation

On the exact candidate (main `30d54b56` plus this changelog), macOS ARM64 with
Node 22.23.2 and a fresh `npm ci`:

- `npm run check:quality` passed: workflow concurrency, 79 migration lineage
  entries, architecture, colour themes, lint and all typechecks.
- `npm test -- --maxWorkers=2` (the CI worker limit) passed 10,055 tests with
  146 platform-dependent skips in 441.5 seconds.
- `npm run build:bundle` passed within the renderer bundle budgets
  (core 2113.4 / 2113.5 KiB, detached chat first load 627.4 / 627.4 KiB).

Each merged PR also passed its own full six-platform CI, and main was green
after each merge before the next one landed.

## Not exercised locally

- README screenshots were not recaptured. The capture script and the Electron
  E2E fixture currently inherit the full user environment, so on a machine with
  real provider CLIs installed they would run provider discovery against them.
  #474 adds a test-mode opt-in that sandboxes discovery; until it merges these
  launches stay on CI. The 0.0.63 changes shown in the README views are either
  transient (thinking strip, compaction while running, the running-state fix)
  or appear only after an interaction (chat reference chips), and the v0.0.62
  screenshots were refreshed on 2026-09-24.
- Local packaging, package smoke and Electron fuse checks were not repeated for
  the same reason. The tag workflow builds, smokes and certifies all six native
  targets and validates checksums and provenance before publishing.

## Publication boundary

The exact reviewed PR head must pass CI, and the resulting main commit must be
fully green before the annotated stable tag `v0.0.63` is created. The tag
workflow then certifies all six native platforms and validates the complete
asset union, checksums and provenance before publishing. Use the curated
changelog text for the public release notes. No tag, public release or asset
replacement is part of this preparation commit.

## Changed files

- `CHANGELOG.md`: one combined 0.0.63 section replacing the separate 0.0.62
  and 0.0.63 sections.
- This release preparation evidence report.
