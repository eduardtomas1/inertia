# v0.0.64 release preparation

This preparation integrates main `877aa4e6` (#498). It bumps the package and
lockfile root versions from 0.0.63 to 0.0.64, adds the curated 0.0.64
changelog section, and adds this report.

The changelog groups the release as Provider sign-in and status,
Conversations and history, Attachments and storage, and Reliability. It covers
every change since `v0.0.63` (peeled commit `12b0ded6`):

- #474 Confine test-mode provider discovery to the fixture bin directory.
- #476 Remove redundant composer source tests and indicator E2E checks.
- #477 Fix text and log attachment decoding, previews, and delivery.
- #478 Keep rejected first-send drafts current and tolerate layout storage
  failures.
- #479 Manage global attachment storage and raise bounded disk capacity.
- #480 Consolidate dependency updates and refresh Kimi icon.
- #488 Fix audit findings across providers, queues, history, and CI.
- #490 Keep Chromium profile setup from stalling macOS exit.
- #491 Measure snapshot tile geometry after its entry animations settle.
- #492 Load paged history before sampling the long-conversation benchmark.
- #493 Take reader control before scrolling paged history in E2E specs.
- #494 Fix Browser shutdown crash after the owner window closes.
- #495 Unblock Claude Stop when an SDK message read hangs.
- #496 Fix provider sign-in input, honest provider checks, offline history,
  and macOS GPU-stall closes.
- #497 Let the discovery benchmark wait for bounded provider-check retries.
- #498 Polish provider, queue, history, and plan behaviour from the
  pre-release audits.

## Local validation

On the exact candidate (main `877aa4e6` plus this preparation), macOS ARM64
with Node 22.23.2 and a fresh `npm ci`:

- `npm run check:quality` passed: workflow concurrency, 82 migration lineage
  entries, architecture, colour themes, lint and all typechecks.
- `npm test -- --maxWorkers=2` (the CI worker limit) ran with provider
  discovery confined to an empty directory, so no installed provider CLI could
  run. 10,386 tests passed with 147 platform-dependent skips in 554.7 seconds.
  The one failure, `tests/server/providers.test.ts` "resolves and reuses an
  absolute command path and its discovered environment", needs real PATH
  discovery and passes in CI.
- `npm run build:bundle` passed within the renderer bundle budgets (core
  2128.5 / 2128.6 KiB, main workbench first load 820.9 / 821.0 KiB, detached
  chat first load 635.0 / 635.1 KiB).

Each merged PR also passed its own full six-platform CI. Main was red only
between #496 and #497, which fixed the Linux discovery benchmark that #496's
bounded retries outlasted.

## Packaging and README views

On the same candidate, macOS ARM64, with the stable release configuration
(`INERTIA_RELEASE_PLATFORM=macos-arm64`, `INERTIA_RELEASE_CHANNEL=stable`) and
no signing credentials:

- `test:native-architecture` passed for darwin/arm64 (Claude manifest 0.3.283).
- `build:packaged` then `package:release:mac` built `Inertia-0.0.64-arm64.dmg`
  and `Inertia-0.0.64-arm64-mac.zip`.
- `verify:fuses` passed for `release/mac-arm64/Inertia.app`.
- `test:package-smoke` passed: runtime observed, PDF extraction and image
  retention verified, launch to ready 2,690 ms, clean exit.
- `test:release-container-smoke` passed for both the ZIP and the DMG.
- `codesign --verify --deep --strict` reported the app valid on disk and
  satisfying its designated requirement. These local packages use ad-hoc
  signing; Developer ID signing and notarization were not exercised.
- `screenshots:readme` captured all nine README views. Compared with the
  committed images, at most 450 of 5.2 million pixels differ in any view, and
  no more than two differ by over 32 levels, so the README screenshots are
  unchanged by this release.

These launches run with `NODE_ENV=test`, where the runtime starts with
providers disabled, so no provider CLI is discovered or executed.

## Publication boundary

The exact reviewed PR head must pass CI, and the resulting main commit must be
fully green before the annotated stable tag `v0.0.64` is created. The tag
workflow then certifies all six native platforms and validates the complete
asset union, checksums and provenance before publishing. Use the curated
changelog text for the public release notes. No tag, public release or asset
replacement is part of this preparation commit.

## Changed files

- `package.json` and `package-lock.json`: root version 0.0.64.
- `CHANGELOG.md`: the curated 0.0.64 section.
- This release preparation evidence report.
