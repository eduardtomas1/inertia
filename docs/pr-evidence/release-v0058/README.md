# v0.0.58 release candidate

## Reviewed inputs

- #417: `b61ce5c86e0100d32b323bfdaf506608468e779e`, merged after its
  complete native matrix passed as main `0cd81711ae410ff828bf26271a369307beb5a67f`.
- #418: `29a0364f405438cd0bf52d47f9292ee9ea800a1b`.
- #420: `7bfa4f8a1cf57eed1f817bd809fcb87373c45e55`.
- #422: `0c171c8735fe2a7199baf12c5adfde3c7817ef1b`.

The release branch preserves the last three PR heads as merge parents so the
combined candidate can receive one complete, up-to-date certification. Their
individual review findings and focused validation are recorded in the adjacent
provider-reverify, usage-and-chat-palette, dependency-pr420 and antigravity-models
evidence directories. All source review threads were resolved at preparation.

The additional PR being prepared by Claude (expected #423) is **not yet included
or reviewed**. This preliminary evidence is not the final release authorization;
the complete candidate still requires review and hosted certification.

## Local integrated validation

macOS ARM64, Node 22.23.2, clean `npm ci`, reviewed lockfile:

- `npm run check`: 871 test files passed, 16 skipped; **9,306 tests passed,
  145 skipped**. Workflow, migration lineage, architecture, generated themes,
  both lint layers, all TypeScript projects, production/private-connect builds
  and renderer bundle limits passed.
- `npm run test:portable`: **102 files and 1,424 tests passed, 9 skipped**.
- Dependency installation/audit: zero vulnerabilities. Generated third-party
  notices contain the updated runtime dependency versions.
- `npm run package:dir`: native ARM64 app packaged with publication disabled.
- `npm run verify:fuses -- release/mac-arm64/Inertia.app`: passed.
- `INERTIA_EXPECTED_ARCH=arm64 npm run test:native-architecture`: passed,
  including the native Claude SDK 0.3.276 executable and native bindings.
- `INERTIA_PACKAGE_SMOKE_EXPECTED_VERSION=0.0.58 npm run test:package-smoke`:
  passed. The packaged runtime became ready, extracted a PDF, retained image
  evidence and exited cleanly with its owned runtime.
- `node scripts/capture-readme-screenshots.mjs`: all seven images recaptured
  through the actual app with isolated demo data. The script now also captures
  message search and Git review, waits for diff content and closed dialogs,
  and uses the current sidebar context menu. Dark/light, split, project picker,
  search and Git layouts were visually inspected.

An earlier scratch checkout shared another worktree's node_modules through a
symlink. Vite rejected the external PDF-worker URL in 11 attachment tests.
Installing dependencies inside the release checkout corrected that setup;
the complete gate above passed without weakening containment or changing the
attachment implementation. The native architecture probe also requires its
explicit architecture environment variable; the recorded passing invocation
includes it.

Logs are under `/tmp/inertia-v0058-{check,portable,notices,package,fuses,native-architecture,package-smoke,screenshots-final}.log`.

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
