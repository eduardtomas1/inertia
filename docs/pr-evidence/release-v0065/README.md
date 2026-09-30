# v0.0.65 release preparation

This preparation integrates main `5d51f21e` (#528). It bumps the package and
lockfile root versions from 0.0.64 to 0.0.65, adds the curated 0.0.65
changelog section, refreshes eight README views for this release's visible
changes, and adds this report.

The changelog groups the release as New, Chats keep their provider, Providers,
and Reliability and safety. It covers every change since `v0.0.64` (peeled
commit `a8499929`):

- #511 Take reader control before checking the oldest paged history turn.
- #510 Wait on observable state instead of fixed sleeps in tests.
- #513 deps: bump oxlint-tsgolint in the development-patch-and-minor group.
- #512 deps: bump lucide-react in the production-patch-and-minor group.
- #514 Keep active-turn follow-up images when turn detail lags the snapshot.
- #505 Match Git paths literally and parse diff hunks by their line counts.
- #519 Fix Codex updates for separate npm prefixes and explain maintenance
  limits.
- #500 Keep app update install, handoff, and rollback from getting stuck.
- #522 Remove the timing races behind intermittent hosted-runner failures.
- #507 Fix provider adapter lifecycle, redaction, and Windows shim audit
  findings.
- #520 Recover stalled macOS GPU helpers before every frame-dependent E2E
  action.
- #523 Require two frameless probes before GPU recovery and make recovery
  specs deterministic.
- #508 Harden database recovery, vault recovery, and main-process file safety.
- #506 Harden main-process IPC boundaries and architecture checks.
- #524 Settle five intermittent test and benchmark failures at their cause.
- #525 Send the OpenCode prompt only after the event subscription is accepted.
- #501 Stop runtime admission, spawn-failure and Windows tree-kill lifecycle
  leaks.
- #529 Consolidate eleven reviewed PRs: audit fixes, provider isolation, and
  four features. It carries:
  - #526 Wait for a sent stop to be observed before confirming a terminal
    tree.
  - #527 Wait for the documented ready state in two Electron specs.
  - #503 Fix settings keyboard access, dialog focus, and main preload surface.
  - #509 Keep composer attachments and draft transfers consistent, and
    stabilise app shell renders.
  - #504 Keep workspace panel drafts, errors, bounds, and terminals stable
    across refreshes.
  - #502 Keep the response timeline stable across streaming and surface copy
    failures.
  - #518 Restore provider isolation for established chats.
  - #515 Choose the project for a new chat from the command palette.
  - #517 Play a sound when a task ends, with your own named sounds.
  - #516 Let the mascot follow a chosen chat and show richer context.
  - #521 Add an in-app Help window built from the welcome guide.
- #528 Support Codex 0.159.0 and GPT-6.1 Sol.

## Local validation

On the exact candidate (main `5d51f21e` plus this preparation), macOS ARM64
with Node 22.23.2 and a fresh `npm ci`. Each command ran on its own:

- `npm run check:quality` passed: workflow concurrency, 83 migration lineage
  entries, architecture (1,278 source files), colour themes, lint and all
  typechecks.
- `npm test -- --maxWorkers=2` (the CI worker limit) ran with provider
  discovery confined to an empty directory, so no installed provider CLI could
  run. 11,436 tests passed with 149 platform-dependent skips in 1,035 files
  (17 skipped), in 469.2 seconds, with no unhandled errors. The one failure,
  `tests/server/providers.test.ts` "resolves and reuses an absolute command
  path and its discovered environment", needs real PATH discovery and passes
  in CI; it is the same expected failure recorded for v0.0.64.
- `npm run build:bundle` passed within the renderer bundle budgets (core
  2,213,166 / 2,213,240 bytes, main workbench first load 851,481 / 851,496
  bytes, detached chat first load 658,031 / 658,114 bytes).
- `npm run test:portable` passed: 2,073 tests with 10 skips in 134 files (1
  skipped).
- `npm run test:windows-codex` passed: 4 tests, with the 4 native Windows
  tests skipped on macOS.

The same five commands also passed on main `d0e62178` plus this preparation
before #528 merged, with the same single expected unit failure.

Every main commit from `v0.0.64` to `d0e62178` has a successful CI run, and
the CI run on `d0e62178` (36676108875) passed on its first attempt. Several
earlier main commits passed only on a rerun; the intermittent failures behind
those reruns are what #510, #511, #520, #522, #523, #524, #526 and #527
address. The CI run on `5d51f21e` was still in progress when this report was
written.

## Packaging and README views

The packaging below ran on main `d0e62178` plus this preparation, before #528
merged. #528 changes only the Codex App Server adapter, its tests and
documentation, so it does not affect the package layout, fuses or signing.
macOS ARM64, with the stable release configuration
(`INERTIA_RELEASE_PLATFORM=macos-arm64`, `INERTIA_RELEASE_CHANNEL=stable`) and
no signing credentials:

- `test:native-architecture` passed for darwin/arm64 (Claude manifest 0.3.283).
- `build:packaged` then `package:release:mac` built `Inertia-0.0.65-arm64.dmg`
  and `Inertia-0.0.65-arm64-mac.zip`.
- `verify:fuses` passed for `release/mac-arm64/Inertia.app`.
- `test:package-smoke` passed: runtime observed, PDF extraction and image
  retention verified, launch to ready 2,505 ms, clean exit.
- `test:release-container-smoke` passed for both the ZIP (launch to ready
  2,276 ms) and the DMG (3,150 ms), each with a clean exit.
- `codesign --verify --deep --strict` reported the app valid on disk and
  satisfying its designated requirement. These local packages use ad-hoc
  signing; Developer ID signing and notarization were not exercised.
- `screenshots:readme` captured all nine README views. Unlike v0.0.64, the
  captures differ from the committed images:
  - Eight views show the new **Help** button (#521) in the sidebar footer:
    add project, dark, Git workflow, goals, light, message search, project
    picker and split workspace. In each, 289 to 400 of 5.2 million pixels
    differ by over 32 levels, apart from the Git workflow view.
  - The Git workflow view's review hint now also mentions Shift+Enter (#504).
  - In a first capture on `d0e62178`, the two message search results swapped
    places. Both fixture messages share one timestamp, so their order follows
    random fixture ids; message search itself is unchanged since `v0.0.64`.
  - The image preview view differs only in the file size of the freshly
    captured image it previews.

## README views refreshed

A fresh `screenshots:readme` capture on main `5d51f21e` plus this preparation
replaced the eight committed views that show the Help button, including the
Git workflow view with its new review hint. In that capture the message search
results kept their committed order, so that view differs only by the Help
button. The image preview view is kept as committed, because its only
difference is the recaptured file size. Every image the README references
still exists.

These launches run with `NODE_ENV=test`, where the runtime starts with
providers disabled, so no provider CLI is discovered or executed.

## Not exercised

Windows and Linux packaging, installers and container smokes, macOS x64,
Developer ID signing, notarization, Windows Authenticode signing, and any real
authenticated provider. The tag workflow certifies all six native platforms.

## Publication boundary

The exact reviewed PR head must pass CI, and the resulting main commit must be
fully green before the annotated stable tag `v0.0.65` is created. The tag
workflow then certifies all six native platforms and validates the complete
asset union, checksums and provenance before publishing. Use the curated
changelog text for the public release notes. No tag, public release or asset
replacement is part of this preparation commit.

## Changed files

- `package.json` and `package-lock.json`: root version 0.0.65.
- `CHANGELOG.md`: the curated 0.0.65 section.
- `docs/screenshots/`: the eight refreshed README views.
- This release preparation evidence report.
