# v0.0.68 release preparation

This preparation integrates main `07282b41` (#582). It applies the dependency
updates Dependabot's groups define and clears both audits, checks every
provider integration against its current upstream release, bumps the package
and lockfile root versions from 0.0.67 to 0.0.68, adds the curated 0.0.68
changelog section, recaptures the one README view whose content changed,
fixes the two causes of main's red CI run on `07282b41` and adds this report.

The changelog groups the release as Browser, Chats and turns, Usage limits,
Settings and providers, CLI import, Checkpoints, Snapshots, Performance,
Providers and dependencies, and Fixes. It covers every change since
`v0.0.67` (`6d1c4ee4`):

- #580 Redact sensitive fields instead of withholding pages and extend the
  Browser tool surface.
- #581 Frame the Agents settings lists again and show full text on running
  background tasks.
- #551 Import existing Codex and Claude CLI conversations. Its Unreleased
  changelog entry moves into the 0.0.68 section.
- #582 Core wins: usage limits, checkpoints, tool activity, turns,
  continuation, snapshots, provider updates on Linux, right-click menus and
  sign-in with paste.
- This PR: dependency updates, audit fixes, the provider review and the
  checkpoint benchmark fixture fix for Windows CI.

Schema 92 (`CliConversationImports`, from #551) is the release's one new
migration. This PR adds no migration.

## Dependencies

No Dependabot pull request is open: the 2026-10-05 run's #571 to #578 were
closed after v0.0.67 applied them, and the next scheduled run is on
2026-10-12. This branch applies every update the configured groups define, at
the newest versions on the registry on 2026-10-06, with `npm install
<package>@<version>` (exact pins kept exact, ranges raised as
`versioning-strategy: increase` does) and an npm-generated lockfile. Each group
is one commit; every package the groups exclude has its own commit.

| Package | From | To | Dependabot group | Commit |
| --- | --- | --- | --- | --- |
| `oxlint` | 1.86.0 | 1.87.0 | development-patch-and-minor | `55734176` |
| `@anthropic-ai/claude-agent-sdk` | 0.3.289 | 0.3.290 | Excluded (provider SDK); own commit | `4f1995a2` |
| `@modelcontextprotocol/sdk` | 1.32.0 | 1.32.1 | Excluded (provider SDK); own commit | `fa87c64d` |
| `proxy-addr` (via MCP SDK and express, production) | 2.0.7 | 2.0.8 | Security (npm audit fix, lockfile only) | `c17918a9` |
| `source-map-js` (via PostCSS, development) | 1.2.1 | 1.2.2 | Security (npm audit fix, lockfile only) | `efa69c18` |
| `global-agent` (via electron-builder's `@electron/get` 3.1.0, development) | 3.0.0 | 4.1.3 | Security; `overrides` entry, own commit | `6ffdec57` |

Every other direct package is already at its newest version within the
configured rules: the production group, the vitest-contract group (Vitest
5.0.3), Electron (44.5.1 is the newest 44.x), electron-builder 26.17.0 and
electron-updater 6.8.10 (both on their `v26` dist-tag; the registry's `latest`
tag still names 26.15.3 and 6.8.9), `@anthropic-ai/sdk` 0.131.0,
`@agentclientprotocol/sdk` 1.7.0, `@opencode-ai/sdk` 1.18.34, `@napi-rs/canvas`,
`better-sqlite3`, `node-pty`, `@playwright/test`, `happy-dom`, `electron-vite`,
`typescript` and `oxlint-tsgolint` 7.0.2003 (oxlint 1.87 still requires
`>=7.0.2003`).

Deferred:

| Package | Available | Reason |
| --- | --- | --- |
| `vite` | 8.3.2 | Major; ignored in .github/dependabot.yml until electron-vite declares Vite 8 support. electron-vite 5.0.0 (`latest`) still peers `vite ^5 \|\| ^6 \|\| ^7`; 6.0.0 is at beta.5. |
| `@vitejs/plugin-react` | 6.1.2 | Major; same ignore rule, moves with Vite. |
| `@types/node` | 26.6.4 | Minor and major ignored; 22.13.17 is the newest 22.13 patch and stays on the Node 22.13 minimum runtime line. |

GitHub Actions: every pin is already the exact commit of its action's newest
patch and minor tag (checked with `gh api
repos/actions/<action>/git/matching-refs/tags/<major>`): attest-build-provenance
v4.2.2 `4d101475`, cache v6.1.0 `55cc8345`, checkout v7.0.1 `3d3c42e5`,
download-artifact v8.0.1 `3e5f45b2`, github-script v9.0.0 `3a2844b7` (annotated
tag `d746ffe3` dereferenced), setup-node v7.0.0 `82076278`, upload-artifact
v7.0.1 `043fb46d`. No action changes.

### Audits

On main `07282b41`, `npm audit --omit=dev` reported one critical advisory and
`npm audit` ten (one critical, one high, eight moderate):

- `proxy-addr` 2.0.7, GHSA-jqcg-44mw-7w3h (critical, published 2026-10-05):
  IP spoofing through an IPv4-mapped IPv6 trust subnet. It is reached through
  express under the MCP SDK. `npm audit fix` moves it to 2.0.8 within
  express's range, with the same dependencies.
- `source-map-js` 1.2.1, GHSA-68fv-2mgg-jv7q (high): event-loop denial of
  service through indexed source-map section offsets, used by PostCSS at build
  and test time. `npm audit fix` moves it to 1.2.2. The renderer bundle is
  unchanged by it (see Renderer bundle).
- `sprintf-js` 1.1.3, GHSA-hp3w-g68c-fv3c (moderate): no release is patched,
  so `npm audit fix` cannot fix it and only offered an electron-builder
  downgrade to 26.5.0 (`--force`). Its seven other reports are the chain above
  it: `roarr` 2.15.4, `global-agent` 3.0.0, `@electron/get` 3.1.0,
  `app-builder-lib`, `dmg-builder`, `electron-builder-squirrel-windows` and
  `electron-builder`. `global-agent` is an optional dependency of
  `@electron/get` 3.1.0, which loads it only inside `initializeProxy()` (when
  `ELECTRON_GET_USE_PROXY` is set, inside a try block) and calls its
  `bootstrap` export. global-agent 4.1 drops `roarr` and keeps that export;
  4.0 also defaults `rejectUnauthorized` to true. An `overrides` entry
  `"global-agent": "4.1.3"` (next to the existing `@hono/node-server` one)
  removes `roarr`, `sprintf-js`, `boolean`, `detect-node`, `es6-error`,
  `json-stringify-safe` and `semver-compare` from the lockfile and moves
  `matcher`, `serialize-error` and `type-fest` to the versions global-agent 4
  needs. With `HTTPS_PROXY` set, `@electron/get`'s own `initializeProxy()`
  still installs the global proxy agent. Nothing in the repository or its
  workflows sets `ELECTRON_GET_USE_PROXY`.

After these commits `npm audit --omit=dev` and `npm audit` both report 0
vulnerabilities, also after a fresh `npm ci` on the candidate.

### Runtime dependencies and packaging

Third-party notices are generated from the installed production graph by
`npm run notices:generate` during `build:packaged`; the file is ignored by Git
and its packaged copy is verified by the package smoke. No runtime dependency
was added or removed. The production changes are the Claude Agent SDK, the MCP
SDK and `proxy-addr`; the regenerated notices list Claude Agent SDK 0.3.290,
MCP SDK 1.32.1 and proxy-addr 2.0.8. The Claude Agent SDK's native optional
packages keep their paths and platform set, so the release-container smoke
needs no change. `global-agent` is development-only (electron-builder's
download helper) and does not ship.

The release packaging on this Mac (below) downloaded the Electron 44.5.1 zip
through electron-builder's `@electron/get` 3.1.0 with `global-agent` 4.1.3
installed, packaged, signed ad hoc and smoked the app.

## Providers and SDK usage

| Adapter | Inertia before | Inertia after | Upstream current (2026-10-06) | How verified |
| --- | --- | --- | --- | --- |
| Codex App Server (JSON-RPC, no SDK) | Verified against 0.160.0 | Verified against 0.160.1, no change | `@openai/codex` 0.160.1 (rust-v0.160.1, 2026-10-05); 0.162.0-alpha.16 is prerelease | `codex-rs/app-server-protocol` is the same tree (`01988e42`) at rust-v0.160.0 and rust-v0.160.1, so every notification, server request and client method is unchanged; 0.160.1 only backports a Windows remote MCP environment fix. Portable and Windows Codex suites. |
| Claude Agent SDK | 0.3.289 (Claude Code 2.1.289) | 0.3.290 (Claude Code 2.1.290) | 0.3.290; `@anthropic-ai/claude-code` 2.1.290 (`stable` tag 2.1.285) | Packed 0.3.289/0.3.290 diff: the `OfferChromeSetup` tool, an optional WebFetch `offset`, the `idleCompaction` setting and documentation; no message, option or Query shape Inertia uses changes. Upstream changelog 0.3.290. Typecheck, Claude suites, portable suite, native architecture probe. |
| Anthropic SDK (drift surface, Claude peer) | 0.131.0 | unchanged | 0.131.0 | Registry. |
| Cursor (ACP) | ACP SDK 1.7.0 (protocol v1) | unchanged | ACP SDK 1.7.0; the Cursor installer still points at 2026.10.01-e373342 | Registry and installer script read as text; nothing to re-review since v0.0.67. The CLI was not run. |
| Kimi Code (ACP) | ACP SDK 1.7.0; reviewed at 2.1.1 | unchanged | `@moonshot-ai/kimi-code` 2.1.1 | Registry; same version as reviewed for v0.0.67. |
| OpenCode (owned `serve --pure`) | SDK 1.18.34 | unchanged | `opencode-ai` and `@opencode-ai/sdk` 1.18.34; OpenCode 2 is `@opencode/cli` 2.0.23 | Registry; OpenCode 2 is still reported as unsupported. |
| Antigravity (`agy` headless stream-json) | Minimum agy 1.2.2; reviewed at 1.2.16 | unchanged | agy 1.2.17 (2026-10-05) | google-antigravity/antigravity-cli 1.2.16...1.2.17 changes only CHANGELOG.md: announcement cards, the Windows sandbox, table alignment and `.tiff` detection, nothing in the headless stream. |
| MCP SDK (host-tool server, Claude in-process tools) | 1.32.0 | 1.32.1 | 1.32.1 | Every file under `dist` and every dependency range is byte-identical to 1.32.0 (only the README and version change); latest protocol version still 2025-11-25; host-tool suites. |
| Gemini | Removed in schema 76 | — | — | Not an Inertia provider. |

Codex: `thread/prediction/updated` still exists only in the 0.162.0 alphas, so
it is still not added: the scheduled drift probe requires an exact match with
the latest stable binary's generated types, which is 0.160.1 with the same
protocol tree as 0.160.0. An unknown notification is a no-op at runtime.

Claude: of the 0.3.290 changelog, the one item that reaches Inertia is that
`includePartialMessages` streams that are cut, interrupted or fall back to
non-streaming now end with `message_stop`. Inertia passes
`includePartialMessages: true` and its projector ignores `message_stop`
(`claude-message-projector.ts`), so the extra event changes nothing; text
still comes from the deltas and the final assistant message. The deny/ask rule
fix for tool aliases and the replay fix do not apply: Inertia uses neither
`toolAliases` nor `--replay-user-messages`. The capability manifest's bundled
SDK version follows the pin: `provider-capability-manifest.test.ts` failed
with the package at 0.3.290 and the manifest still at 0.3.289, and passes
after the manifest moved.

No turn or provider defect was exposed by the bump, so no provider code
changed. No upstream protocol changed in a way the fixtures do not cover:
Codex's protocol tree is identical, Claude's message union is unchanged, and
ACP, OpenCode and agy did not move.

### Not verifiable without a live account

No provider CLI was run and no account was used. Everything above rests on
upstream source, packaged types, registry metadata and fixtures. The limits
recorded for v0.0.67 still apply (Codex `decline` outside
`availableDecisions`, goal-turn effort, Claude `queued_turn_count` and
`rejected` events, Cursor's error sentences and plan handling, Kimi's
background compaction, OpenCode 2's `--version`, agy subagent steps).

## Renderer bundle

`npm run build:bundle` on this branch and on a separate worktree of main
`07282b41` (its own `npm ci`), macOS ARM64: all 52 budget lines are identical,
and the 249 files under `out/renderer` have the same sizes and, once chunk
file names and the embedded version (0.0.67 or 0.0.68) are normalised, the
same content. No cap changes: core 2,278,934 / 2,278,934 bytes, detached chat
first load 665,220 / 668,778. No renderer, transcript or React/Vite code
changed, so the desktop benchmark was not needed.

## README views

`NODE_ENV=test npm run screenshots:readme` captured all nine views on the
candidate, macOS ARM64, and the same command ran on the main worktree
(`07282b41`). The capture confines provider discovery to an empty fixture
directory, so no provider CLI is discovered or executed.

| View | Result | Decision |
| --- | --- | --- |
| `inertia-dark.png` | Byte-identical | Kept |
| `inertia-message-search.png` | The two "context" agent answers appear in the other order. The capture saves both at the same `assistantAt` timestamp with random message ids, and search orders by `created_at DESC, id DESC`, so their order changes between runs; nothing else differs | Kept |
| `inertia-project-picker.png` | Byte-identical | Kept |
| `inertia-split-workspace.png` | Byte-identical | Kept |
| `inertia-git-workflow.png` | Byte-identical | Kept |
| `inertia-goals.png` | Byte-identical | Kept |
| `inertia-image-preview.png` | The blurred sidebar behind the preview now shows the footer's fourth control, as the dark and light views do, and the previewed file's size label reads 374.8 KB instead of 373.8 KB. The capture of main `07282b41` is pixel-identical to the candidate's | Replaced |
| `inertia-light.png` | Byte-identical | Kept |
| `inertia-add-project.png` (not referenced by the README) | Byte-identical | Kept |

None of the README views shows Settings, the usage-limit row or a right-click
menu, so #581's Agents frames and #582's usage-limit row do not appear in
them. The README already describes the CLI import, and the user docs were
updated by #551 and #582.

## Verification

macOS ARM64, Node 22.23.2, after a fresh `npm ci` of the final lockfile and a
verified Electron 44.5.1 framework binary. Each command ran on its own.

On candidate `3ebe0219` (every dependency update, the version bump, the
changelog and the README view):

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check:quality` | 0 | Workflow concurrency, 92 migration lineage entries, architecture (1,448 source files, 5,534 internal edges), colour themes, lint and all typechecks |
| `npm run build:bundle` | 0 | Every renderer budget within its cap, identical to main (see Renderer bundle) |
| `npm run test:portable` | 0 | 2,473 passed, 9 skipped, in 163 files (1 skipped) |
| `npm run test:windows-codex` | 0 | 4 passed; the 4 native Windows tests are skipped on macOS |
| `npm run test:native-architecture` (`INERTIA_EXPECTED_ARCH=arm64`) | 0 | darwin/arm64, Claude manifest 0.3.290 |
| `node scripts/verify-database-lineage.mjs --base-ref origin/main` | 0 | 92 entries, no migration added |
| `npm audit --omit=dev` and `npm audit` | 0 | 0 vulnerabilities each |

The first `npm test -- --maxWorkers=2` on `3ebe0219` exited 1 with one failure,
`tests/source-usage.test.ts`, which had parsed this worker's own untracked
scratch files (an unpacked `global-agent` 3.0.0 used for the comparison above)
inside the worktree. After moving them out, the test passed alone (4 passed)
and the full suite passed: exit 0, 12,926 passed, 140 skipped. Unlike v0.0.64
to v0.0.67, the `providers.test.ts` PATH discovery case no longer fails
locally.

On the final head `84e8c84d` (the CI fix below and the changelog note added;
no source or dependency change), each command on its own:

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check:quality` | 0 | 92 lineage entries, 1,448 source files |
| `npm test -- --maxWorkers=2` | 0 | 12,927 passed, 140 platform-dependent skips, in 1,160 files (14 skipped), 462.6 s |
| `npm run benchmark:platform:smoke` (enforced) | 0 | 3 passed; checkpoint median 83.1 ms for 20 files and 109.2 ms for 12,000 files, ratio 1.314 (limit 6) |
| `npm run build:packaged` | 0 | Third-party notices regenerated (Claude Agent SDK 0.3.290, MCP SDK 1.32.1, proxy-addr 2.0.8 among them) |
| `npm run package:release:mac` (`INERTIA_RELEASE_PLATFORM=macos-arm64`, `INERTIA_RELEASE_CHANNEL=stable`, `CSC_FOR_PULL_REQUEST=true` as CI sets it, no signing credentials) | 0 | `Inertia-0.0.68-arm64.dmg` and `Inertia-0.0.68-arm64-mac.zip` |
| `npm run verify:fuses -- release/mac-arm64/Inertia.app` | 0 | Fuses verified |
| `npm run test:package-smoke` | 0 | Runtime observed, PDF extraction and image retention verified, manual updater fallback 6.8.10, launch to ready 2,527 ms, clean exit |
| `npm run test:release-container-smoke` (`INERTIA_RELEASE_CHANNEL=stable`) | 0 | ZIP (launch to ready 2,350 ms) and DMG (3,107 ms), 19 verified native binaries, clean exits |
| `codesign --verify --deep --strict --verbose=2 release/mac-arm64/Inertia.app` | 0 | Valid on disk and satisfies its designated requirement (ad hoc) |

`test:portable`, `test:windows-codex`, `build:bundle` and
`test:native-architecture` were not repeated on the final head: the commits
after `3ebe0219` change only a test helper, two test files and the changelog.
No real provider CLI ran: the unit and portable suites use fixtures, and the
package and container smokes launch with `NODE_ENV=test`, where the runtime
starts with providers disabled. No Electron turn spec was run, because no
provider, turn or renderer code changed.

## Main's CI on `07282b41`

Main's run 37401688846 on `07282b41` failed in three jobs. Both causes are
fixed on this branch, each in its own commit:

- Linux x64, "Audit production dependencies": `npm audit --omit=dev
  --audit-level=high` reported the critical `proxy-addr` advisory
  (GHSA-jqcg-44mw-7w3h, published 2026-10-05 23:30 UTC). Fixed by `c17918a9`
  (lockfile only, above).
- Windows x64 and Windows ARM64, "Run cross-platform performance smoke":
  `tests/performance/checkpoint.benchmark.test.ts` failed with
  `RangeError: stderr maxBuffer length exceeded`. The benchmark's fixture runs
  `git add -A` over 12,000 files through `execFile` (1 MiB stderr buffer), and
  under the Windows runners' `core.autocrlf=true` Git prints one LF-to-CRLF
  warning per file. `67cbf8d8` moves the fixture unchanged to
  `tests/helpers/checkpoint-benchmark-repository.ts` and sets
  `core.autocrlf=false` and `core.safecrlf=false` in its throwaway repository
  right after `git init`. The new
  `tests/performance/checkpoint-benchmark-repository.test.ts` builds the
  12,000-file fixture under a global configuration with `core.autocrlf=true`
  and requires empty Git stderr and 12,000 tracked files; on this Mac it failed
  with the same `RangeError` before the fix and passes after it. The 6x ratio
  and the 10 s ceiling are unchanged. Windows itself is proven by the next
  main run.

The `merge-ready` job failed only because those jobs did.

## Not exercised

Windows and Linux packaging, installers and container smokes (PR CI runs them
because the lockfile changed), macOS x64, Developer ID signing, notarization,
Windows Authenticode signing, a real macOS Keychain prompt, and any real
authenticated provider account or provider CLI. The tag workflow certifies all
six native platforms.

## Changed files

- `package.json` and `package-lock.json`: the dependency updates, the
  `global-agent` override and root version 0.0.68.
- `CHANGELOG.md`: the curated 0.0.68 section; the Unreleased entry moves into
  it.
- `src/server/provider/capability-manifest.ts`: Claude's bundled SDK version.
- `tests/helpers/checkpoint-benchmark-repository.ts`,
  `tests/performance/checkpoint-benchmark-repository.test.ts` and
  `tests/performance/checkpoint.benchmark.test.ts`: the Windows benchmark
  fixture fix.
- `docs/screenshots/inertia-image-preview.png`: the recaptured view.
- This release preparation evidence report.

## Publication boundary

This PR's exact head must pass CI, and its merge commit on main must be fully
green before the annotated stable tag `v0.0.68` is placed on that merge
commit. The tag workflow then certifies all six native platforms and validates
the complete asset union, checksums and provenance before publishing. Use the
curated changelog text for the public release notes. No tag, public release or
asset replacement is part of this preparation.
