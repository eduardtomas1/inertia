# v0.0.65 release preparation

This preparation integrates main `5d51f21e` (#528). It bumps the package and
lockfile root versions from 0.0.64 to 0.0.65, adds the curated 0.0.65
changelog section, refreshes eight README views for the new Help button and
review hint, and adds this report. The v0.0.65 tag is placed on the merge commit
of #541, the release batch, which also records the batch in the changelog and
in this report.

The changelog groups the release as New, Chats keep their provider, Providers,
Agent Browser, and Reliability and safety. It covers every change since
`v0.0.64` (peeled commit `a8499929`):

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
- #536 Deliver follow-ups sent while the provider turn is still starting.
- #537 Record #536 in the v0.0.65 release notes and evidence.
- #538 Raise the macOS ARM64 release build budget to 75 minutes. The release
  budgets in #541 supersede it; macOS ARM64 keeps 75 minutes.
- #540 Clear guide transition timers on unmount and unmount before resetting
  the QR mock.
- #541 Consolidate the v0.0.65 batch: agent Browser, tool contracts, reviewed
  screenshots, provider context, custom colours, and CI fixes. It carries the
  following, with the fixes from its review:
  - #531 Fix Browser tool contracts across provider transports.
  - #532 Add reviewed Linux screenshots without accessibility prerequisites.
  - #533 Keep a chat's provider context across provider updates and lost
    sessions.
  - #534 Make the agent Browser usable off screen, on ordinary pages, and
    with exact tools.
  - #535 Add custom colors for light and dark appearances.
  - #539 Give every release build room above its measured duration. It was
    not merged on its own; its budgets are part of #541.
  - `fix/unit-timing-flakes`: two unit tests that a loaded runner could fail,
    a terminal rename check and a cancellation check.
  - `fix/auxiliary-termination-diagnostics`: a provider shutdown error that
    names each unconfirmed process tree and why.
  - `fix/language-aware-files-flake`: two Electron specs; one waits for the
    Files Git scan, the other builds its attachment fixture before its test
    starts.

## Local validation

On the preparation's candidate (main `5d51f21e` plus this preparation), macOS
ARM64 with Node 22.23.2 and a fresh `npm ci`. Each command ran on its own:

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
address. The CI run on `5d51f21e` (36682952652) passed on its first attempt.

## First release attempt and #536

The first release attempt ran from `cb93b1f5`, this preparation on main (run
36690014523). Its macOS ARM64 build failed in the display-sensitive Electron
end-to-end step, in `tests/e2e/image-follow-up-regression.spec.ts`: an image
sent into a running turn was refused because Codex had not yet reported the
turn running. That was a real product defect, and #536 fixes it. The rerun of
that build reached its 50-minute job budget and was cancelled by GitHub, and
nothing was published. Windows ARM64 also reached its 100-minute budget in
both attempts of that run (100.3 and 100.4 minutes); GitHub cancelled it
during the isolated end-to-end step in the first attempt and during the
destructive runtime-recovery tests in the second. The unpublished tag moves
to the merge commit of #541 before any publication.

#536 changes only server-side follow-up delivery, in three `src/server` files.
It does not touch the renderer, and the renderer bundle is byte-identical. Its
PR CI passed in runs 36711528031 (attempt 4) and 36724750393, and the local
spec loops described in its PR body passed. The local validation above and the
packaging below ran before #536, on `5d51f21e` and `d0e62178` plus this
preparation.

The CI run on main `8b8e9283` (#536), 36729398902, passed on its first
attempt, and the CI run on main `6f042930` (#537), 36735439834, passed on its
first attempt.

## Second release attempt and the macOS ARM64 budget

The second attempt ran from `6f042930` (run 36736016085). Its macOS ARM64
build passed the display-sensitive end-to-end step, including the spec that
failed the first attempt, and was then cancelled by GitHub at the job's
50-minute budget while 102 of 126 isolated end-to-end specs had run. That
budget dates from #168; the build took 44 to 48 minutes in the v0.0.61 to
v0.0.64 releases and the larger v0.0.65 suite needs more. Only macOS x64 and
both Linux builds passed. Windows x64 (65.3 minutes, in the isolated
end-to-end step) and Windows ARM64 (65.2 minutes, in the Windows unit suite)
were still running and were cancelled with the run, and nothing was
published. The budget is now 75 minutes (#538), in line with the other
platforms, and the tag moves to the merge commit of #541 before any
publication.

## Third release attempt and the remaining budgets

The third attempt ran from `de221d8c` (run 36752772316). macOS ARM64 passed
in 49 minutes under its new budget, and both Linux builds passed. Windows x64
was cancelled by GitHub at its 75-minute budget during the isolated end-to-end
step, and the run was cancelled because it could no longer publish. macOS x64
(74.2 minutes, still in the isolated end-to-end step after starting 11 minutes
late) and Windows ARM64 (78.0 minutes, in the display-sensitive end-to-end
step) were cancelled with the run. In the v0.0.64 release Windows x64 took 72
of its 75 minutes, Windows ARM64 97 of its 100 and macOS x64 72 of its 85, so
those budgets had no room for the larger suite either. The budgets are now
macOS x64 100 (from 85), Windows x64 100 and Windows ARM64 130 minutes; macOS
ARM64 stays at 75 and the Linux budgets are unchanged. #539 proposed this
change and #541 carries it. The tag moves to the merge commit of #541 before
any publication.

## Release batch (#541)

#541 merges #531, #532, #533, #534 and #535 onto main `58cbf572` (#540), with
the fixes from its review, the release budgets from #539 and the three fix
branches listed above. Schema 84 (`turn-session-recovery`, from #533) and
schema 85 (`custom-appearance-colors`, from #535) are new, unreleased
migrations.

The renderer bundle budgets were measured against a build of main `58cbf572`
on the same machine. Each budget that the batch exceeds is main's cap plus the
exact growth; the new deferred screenshot review closure has its own ceiling:

| Closure | Main (bytes) | Main cap | Batch (bytes) | Batch cap |
| --- | ---: | ---: | ---: | ---: |
| core | 2,213,166 | 2,213,240 | 2,226,045 | 2,226,119 |
| main workbench first load | 851,481 | 851,496 | 853,542 | 853,557 |
| detached chat first load | 658,031 | 658,114 | 660,072 | 660,155 |
| settings | 65,624 | 66,435 | 68,586 | 69,397 |
| deferred snapshot settings | 5,012 | 5,324 | 5,898 | 6,210 |
| deferred terminal | 26,616 | 26,712 | 26,775 | 26,871 |
| deferred screenshot review | none | none | 7,313 | 7,372 |

Every other closure stays within main's cap and keeps it.

On `0b08a7d2`, the batch with these caps before its changelog and evidence
commits, on macOS ARM64 with Node 22.23.2 and a fresh `npm ci`, each command
ran on its own and passed:

- `npm run check:quality`: 85 migration lineage entries, architecture (1,295
  source files), colour themes, lint and all typechecks.
- `npm test`: 11,799 tests passed with 149 skips in 1,062 files (17 skipped),
  with no unhandled errors.
- `npm run build:bundle`, within the budgets above.
- `npm run test:portable`: 2,161 tests passed with 10 skips in 140 files (1
  skipped).
- `npm run test:windows-codex`: 4 tests passed, with the 4 native Windows
  tests skipped on macOS.
- `npm run test:lifecycle-repeat -- --iterations 2`: 275 tests in 8 files
  passed in both repetitions, classified stable-pass.

## Packaging and README views

The packaging and the first README-view capture below ran on main `d0e62178`
plus this preparation, before #528, #536 and #541 merged. #528 changes only
the Codex App Server adapter, its tests and documentation, so it does not
affect the package layout, fuses or signing. Neither was repeated for #541.
Its own evidence is its pull-request CI, with the unit, Electron and
packaging jobs of all six platforms, and main's CI run on its merge commit;
both are linked from #541.
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

A fresh `screenshots:readme` capture on main `5d51f21e` plus this preparation,
before #536 and #541 merged, replaced the eight committed views that show the Help button, including the
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
Local packaging and README-view captures were not repeated for #541, and the
README views were not recaptured for its visible changes.

## Publication boundary

The exact reviewed head of #541 must pass CI, and its merge commit on main
must be fully green before the annotated stable tag `v0.0.65` is placed on
that merge commit; the tag moves there before any publication. The tag
workflow then certifies all six native platforms and validates the complete
asset union, checksums and provenance before publishing. Use the curated
changelog text for the public release notes. No tag, public release or asset
replacement is part of this preparation commit or of #541.

## Changed files

- `package.json` and `package-lock.json`: root version 0.0.65.
- `CHANGELOG.md`: the curated 0.0.65 section.
- `docs/screenshots/`: the eight refreshed README views.
- This release preparation evidence report.

#541 adds the batch to the 0.0.65 changelog section and updates this report.
