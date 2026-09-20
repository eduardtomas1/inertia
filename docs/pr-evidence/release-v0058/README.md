# v0.0.58 release candidate

## Reviewed inputs

- #417: `b61ce5c86e0100d32b323bfdaf506608468e779e`, merged after its
  complete native matrix passed as main `0cd81711ae410ff828bf26271a369307beb5a67f`.
- #418: `29a0364f405438cd0bf52d47f9292ee9ea800a1b`.
- #420: `7bfa4f8a1cf57eed1f817bd809fcb87373c45e55`.
- #422: `0c171c8735fe2a7199baf12c5adfde3c7817ef1b`.
- #423: `a73735453357b98dabca7b470b6b791cc3a56bcd`, with the release review
  corrections below.

The release branch preserves the last four PR heads as merge parents so the
combined candidate can receive one complete, up-to-date certification. Their
individual review findings and focused validation are recorded in the adjacent
provider-reverify, usage-and-chat-palette, dependency-pr420 and antigravity-models
evidence directories. All source review threads were resolved at preparation.

## Sidebar aurora review

Reviewed all 14 changed files in #423: palette generation and declarations,
sidebar integration and native titlebar geometry, CSS stacking/tiling, the
coarse animation scheduler, background/reduced-motion behavior, and unit/DOM/
Electron coverage. No provider, persistence or privileged boundary changes.

- The initial Linux and Windows CI jobs failed at `coreJavaScript`, before
  native E2E, because the new scheduler was not accounted for. Identical-
  dependency production builds of the combined candidate before and after
  #423 measure **722 added core JavaScript bytes**, **552 palette CSS bytes**
  and **62 entry CSS bytes**. Initial JavaScript routes are unchanged.
  `aurora-renderer-bundle.json` records every closure. Only the first two
  budgets grow, by their exact measured additions; entry CSS already fits.
  The palette retains #418's LF rule rather than budgeting Windows CRLF.
- The original contrast test allowed 3:1 for stacked light behind 14–15.5 px
  clickable text and omitted the second wash and hover tint. The stronger
  test reproduces five failing dark themes on the original strengths.
  Reduce the dark strengths while preserving the animation design. Both
  washes, every light and the native/platform hover tints must now retain
  **at least 4.5:1**; the worst conservative bound is **4.57:1**. All ten
  palette/appearance combinations pass.
- The existing 125 ms scheduler stays paused while unfocused, hidden,
  reduced-motion or a closed mobile drawer. It resumes existing animation
  times and reacquires cancelled/recreated CSS animations. No React state
  update is driven per frame; decoration remains inert and below the brand.
- Focused palette, motion and scheduler coverage: **97 tests passed**.
  These validate deterministic behavior; the Windows CPU measurements in
  `BACKGROUND_RENDERER.md` remain the author's measurements of the original
  artwork, not a new cross-platform performance claim.

Individual #418, #420 and #422 native matrices are green, including merge-ready.
The complete candidate still requires hosted certification before merge and
an exact-tag native release build before publication.

## Local integrated validation

macOS ARM64, Node 22.23.2, clean `npm ci`, reviewed lockfile:

- `VITEST_MAX_WORKERS=2 npm run check`: 873 test files passed, 16 skipped; **9,338 tests passed,
  145 skipped**. Workflow, migration lineage, architecture, generated themes,
  both lint layers, all TypeScript projects, production/private-connect builds
  and renderer bundle limits passed.
- `npm run test:portable`: **102 files and 1,424 tests passed, 9 skipped**.
  This ran on the combined provider/dependency changes before the renderer-only
  aurora merge; provider code and its dependency graph are unchanged since.
- Dependency installation/audit: zero vulnerabilities. Generated third-party
  notices contain the updated runtime dependency versions.
- `npm run check:quality` passed again after the final E2E fixture prerequisite.
- `npm run package:dir`: final native ARM64 app packaged with publication disabled.
- `npm run verify:fuses -- release/mac-arm64/Inertia.app`: passed.
- `INERTIA_EXPECTED_ARCH=arm64 npm run test:native-architecture`: passed,
  including the native Claude SDK 0.3.276 executable and native bindings.
- `INERTIA_PACKAGE_SMOKE_EXPECTED_VERSION=0.0.58 npm run test:package-smoke`:
  passed again on the final app. The packaged runtime became ready in 992 ms,
  extracted a PDF, retained image evidence and exited cleanly with its owned
  runtime (392 ms shutdown, exit 0).
- `node scripts/capture-readme-screenshots.mjs`: all seven images recaptured
  after the aurora changes through the actual app with isolated demo data. The script now also captures
  message search and Git review, waits for diff content and closed dialogs,
  and uses the current sidebar context menu. Dark/light, split, project picker,
  search and Git layouts were visually inspected.

The first final local gate used Vitest's unrestricted default worker count and
hit two 10-second `git update-ref` deadlines while seeding 1,000-branch fixtures.
Both affected files passed unchanged with two workers (71 tests). The complete
gate then passed with the same two-worker bound used by macOS CI, without
altering test assertions, timeouts or production Git behavior. The native brand
scenario explicitly sets no-reduced-motion before asserting motion, then
separately checks reduced-motion cancellation. Its native titlebar geometry,
brand hit target and reduced-motion checks passed on macOS ARM64.

The three real-focus background scenarios could not restore native focus on
this local host. A native session query reported `CGSSessionScreenIsLocked=Yes`;
Electron reported the surviving window visible but neither it nor its web
contents focused. Closing the temporary window first and explicitly activating
the app did not change that result. Those speculative fixture edits were
removed. The existing native-focus assertions and #423's animation assertions
remain intact and required by the hosted display-sensitive matrix. Local
results do not claim unlocked-desktop focus/resume coverage.

An earlier scratch checkout shared another worktree's node_modules through a
symlink. Vite rejected the external PDF-worker URL in 11 attachment tests.
Installing dependencies inside the release checkout corrected that setup;
the complete gate above passed without weakening containment or changing the
attachment implementation. The native architecture probe also requires its
explicit architecture environment variable; the recorded passing invocation
includes it.

Logs are under `/tmp/inertia-v0058-*`, including `final-check-two-workers.log`,
`git-focus.log`, `portable.log`, `aurora-e2e.log`, package/fuse/smoke and screenshot
logs. The original unrestricted failures are retained in `final-check.log`.

## Integrated CI follow-up: fetch settlement

The first candidate CI run (`35473877153`) reached native packaging and desktop
coverage. Linux ARM64 passed its AppImage checks and 70 of 71 display-sensitive
scenarios, including native Linux Snapshots and the three real-focus background
scenarios. The remaining failure was the pre-existing tracking-branch scenario:
it clicked Fetch and required the busy indicator to clear in 15 seconds before
performing its branch switch. Its recorded runtime remained ready and connected,
with no renderer errors. The later branch switch already had a separate bounded
backend observer, but the initial fetch did not.

A controlled native regression held one fixture-owned remote-tracking ref lock
for 20 seconds, within Git's configured lock-wait bound. The original scenario
failed its 15-second UI check even though its observed real Fetch returned
`git.action` successfully after 20.634 seconds. With the fix, the same delay
returned successfully after 19.853 seconds and the complete scenario passed,
including the exact upstream and repaired fetch-mapping assertions. The delay
and diagnostic probes were then removed; they are not application or CI code.

Reuse the existing passive branch-switch observer for the exact scoped Fetch
request in this scenario. It matches command type, project, conversation,
repository and request ID, allows at most 60 seconds after admission, rejects
explicit errors or malformed results, and then retains the normal 15-second
UI assertion. The scenario's existing 120-second overall deadline is unchanged.
No product deadline, repository guard, cleanup boundary, UI assertion or retry
policy changed. The observer's 13 focused tests cover wrong ownership/type,
stale replies, delayed success, errors, missing admission/settlement and cleanup.
All seven native Git workflow scenarios then passed without the injected delay
on macOS ARM64 (1.5 minutes). The full two-worker Node 22 gate passed again:
**9,341 tests passed, 145 skipped**, with quality, types, both builds and bundle
limits passing (`/tmp/inertia-v0058-post-ci-check.log`).

Evidence: `/tmp/inertia-v0058-fetch-delay-negative.log`,
`fetch-delay-positive.log`, `fetch-observer-tests.log`, and the downloaded
Linux ARM64 CI trace. Hosted validation must pass again on the corrected head.

## Remaining certification and release integrity

Live authenticated Antigravity discovery was unavailable locally. Its catalog,
failure, cancellation and selection behavior use deterministic fixtures based
on the official CLI format. Linux, Windows and macOS Intel require their hosted
native gates; no cross-platform result is inferred from this Mac.

Version changes are limited to the three root version fields in package.json
and package-lock.json. The curated changelog covers changes since v0.0.57;
the older v0.0.56 entry remains explicitly unpublished.

No release tag has been created. The observed annotated tag objects remain:

- v0.0.55: `a3a38863d0b8c89f7046f407efd7e1955d9ee1c9`
- v0.0.56: `8751fb986c9afc8ad6a70530edba0622b143848e`
- v0.0.57: `6c016eb12efbbfbb3dbd9fd788ac3a05a4fcd044`

The final new tag must name the exact certified release commit once. Existing
tags and published assets remain immutable. Native packaging, installed-upgrade
smoke, fuses, asset-union checks, checksums and provenance remain required by
the existing release workflow.
