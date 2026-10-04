# v0.0.66 release preparation

This preparation integrates main `070aa5a7` (#562). It bumps the package and
lockfile root versions from 0.0.65 to 0.0.66, adds the curated 0.0.66
changelog section and adds this report. No README view changed, so no image is
replaced. No application behaviour, dependency graph, migration, release
workflow or gate limit changes.

The changelog groups the release as New, Chats and attachments, Providers, and
Reliability and safety. It covers every change since `v0.0.65` (peeled commit
`2364d768`):

- #542 Add native editing menus and fix renderer, provider, and runtime audit
  findings.
- #555 Admit gallery thumbnails in document order and retry a stalled visible
  tile.
- #557 Skip the system font scan in the attachment utilities and record preview
  failure evidence on every platform.
- #556 Reject incomplete POSIX cleanup and drain release helpers before freeing
  slots.
- #543 Start chats without a project in persistent per-chat folders.
- #544 Resume or snooze chats until subscription quota resets.
- #553 Stream large attachments and pass retained file paths to agents.
- #559 Trim CI certification tiers and prune low-value tests.
- #561 Shorten the Electron critical path and reuse Git lookups per operation.
- #562 Search the in-app Help and cover recent features.

#559 and #561's CI changes and test pruning have no user-visible effect and
share one line under Reliability and safety. #555 and #557 share the thumbnail
line; #557's measured speed-up is not claimed, because it recovers time that
#542's image decoding added in the same release. Schema 86
(`PersistScratchProject`, #543) and schema 87
(`PersistUsageLimitResumePlans`, #544) are the release's new migrations. #544
adds the `@napi-rs/keyring` 2.1.0 (macOS only) and `smol-toml` 1.9.0
dependencies.

## Local validation

On the exact candidate (main `070aa5a7` plus this preparation), macOS ARM64
with Node 22.23.2 and a fresh `npm ci`. Each command ran on its own:

- `npm run check:quality` passed: workflow concurrency, 87 migration lineage
  entries, architecture (1,326 source files), colour themes, lint and all
  typechecks.
- `npm test -- --maxWorkers=2` (the CI worker limit) ran with provider
  discovery confined to an empty directory, so no installed provider CLI could
  run. 11,392 tests passed with 140 platform-dependent skips in 1,078 files (14
  skipped), in 432.3 seconds, with no unhandled errors. The one failure,
  `tests/server/providers.test.ts` "resolves and reuses an absolute command
  path and its discovered environment", needs real PATH discovery and passes
  in CI; it is the same expected failure recorded for v0.0.64 and v0.0.65.
- `npm run build:bundle` passed within the renderer bundle budgets (core
  2,238,608 / 2,238,608 bytes, main workbench first load 860,500 / 860,500
  bytes, detached chat first load 664,758 / 665,030 bytes).
- `npm run test:portable`, with discovery confined the same way: 2,254 tests
  passed with 9 skips in 156 files (1 skipped). Its only failure is the same
  `providers.test.ts` case, which the portable suite also includes.
- `npm run test:windows-codex` passed: 4 tests, with the 4 native Windows
  tests skipped on macOS.

The push CI runs on `fd02e238`, `19416d0a`, `5895fc17`, `46cbe6c3`,
`1113506e`, `811d4882` and `2ef3c2a4` passed on their second attempt. The run
on `a1db0bd3` (#559), 37124618187, failed only in `merge-ready` with "Plan is
not canonical" and was not rerun; the run on `1053edf2` (#561), 37130416429,
passed on its first attempt. The scheduled nightly runs on `1113506e` and `2ef3c2a4` failed;
the latter in the macOS x64 unit suite. The run on `070aa5a7` (#562),
37185977320, was still in progress when this report was written.

## Packaging

On the same candidate, macOS ARM64, with the stable release configuration
(`INERTIA_RELEASE_PLATFORM=macos-arm64`, `INERTIA_RELEASE_CHANNEL=stable`) and
no signing credentials:

- `test:native-architecture` (`INERTIA_EXPECTED_ARCH=arm64`) passed for
  darwin/arm64 (Claude manifest 0.3.283).
- `build:packaged` then `package:release:mac` built `Inertia-0.0.66-arm64.dmg`
  and `Inertia-0.0.66-arm64-mac.zip`.
- `verify:fuses` passed for `release/mac-arm64/Inertia.app`.
- `test:package-smoke` passed: runtime observed, PDF extraction and image
  retention verified, launch to ready 2,512 ms, clean exit.
- `test:release-container-smoke` passed for both the ZIP (launch to ready
  2,334 ms) and the DMG (3,125 ms), each with 19 verified native binaries and
  a clean exit.
- `codesign --verify --deep --strict` reported the app valid on disk and
  satisfying its designated requirement. These local packages use ad-hoc
  signing; Developer ID signing and notarization were not exercised.

The package and container smokes launch with `NODE_ENV=test`, where the
runtime starts with providers disabled, so no provider CLI is discovered or
executed.

## README views

`NODE_ENV=test npm run screenshots:readme` captured all nine views on main
`070aa5a7` plus the version bump and changelog, macOS ARM64. The capture
confines provider discovery to an empty fixture directory, so no provider CLI
is discovered or executed. Each capture was compared with main's image pixel by
pixel:

| View | Result | Decision |
| --- | --- | --- |
| `inertia-dark.png` | 4 pixels differ, none by more than 32 levels | Kept |
| `inertia-message-search.png` | Byte-identical | Kept |
| `inertia-project-picker.png` | Byte-identical | Kept |
| `inertia-split-workspace.png` | Byte-identical | Kept |
| `inertia-git-workflow.png` | Byte-identical | Kept |
| `inertia-goals.png` | Byte-identical | Kept |
| `inertia-image-preview.png` | Only the previewed file's size label differs (373.8 KB, now 374.8 KB) | Kept |
| `inertia-light.png` | Byte-identical | Kept |
| `inertia-add-project.png` (not referenced by the README) | 4 pixels differ, none by more than 32 levels | Kept |

None of the README fixtures shows a feature from this release: the sidebar has
no chat without a project, so its **No project** section stays hidden, the
composers have no attachments, and Help is closed. Every image the README
references still exists.

## Not exercised

Windows and Linux packaging, installers and container smokes, macOS x64,
Developer ID signing, notarization, Windows Authenticode signing, a real macOS
Keychain prompt, and any real authenticated provider. The tag workflow
certifies all six native platforms.

## Publication boundary

This PR's exact head must pass CI, and its merge commit on main must be fully
green before the annotated stable tag `v0.0.66` is placed on that merge
commit. The tag workflow then certifies all six native platforms and validates
the complete asset union, checksums and provenance before publishing. Use the
curated changelog text for the public release notes. No tag, public release or
asset replacement is part of this preparation.

## Changed files

- `package.json` and `package-lock.json`: root version 0.0.66.
- `CHANGELOG.md`: the curated 0.0.66 section.
- This release preparation evidence report.
