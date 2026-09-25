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

## Packaging and README views

On the same main commit, macOS ARM64, with the stable release configuration
(`INERTIA_RELEASE_PLATFORM=macos-arm64`, `INERTIA_RELEASE_CHANNEL=stable`):

- `test:native-architecture` passed for darwin/arm64 (Claude manifest 0.3.276).
- `package:release:mac` built `Inertia-0.0.63-arm64.dmg` and
  `Inertia-0.0.63-arm64-mac.zip`.
- `verify:fuses` passed for `release/mac-arm64/Inertia.app`.
- `test:package-smoke` passed: runtime observed, PDF extraction and image
  retention verified, launch to ready 2,573 ms, clean exit.
- `test:release-container-smoke` passed for both the ZIP and the DMG.
- `codesign --verify --deep --strict` reported the app valid on disk and
  satisfying its designated requirement. These local packages use ad-hoc
  signing; Developer ID signing and notarization were not exercised.
- `screenshots:readme` captured all nine README views. Compared with the
  committed v0.0.62 images, no pixel differs by more than the anti-aliasing
  threshold, so the README screenshots are unchanged by this release.

These launches run with `NODE_ENV=test`, where the runtime starts with
providers disabled, so no provider CLI is discovered or executed.

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
