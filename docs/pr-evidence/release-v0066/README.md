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

Pending.

## Packaging

Pending.

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

Pending.

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
