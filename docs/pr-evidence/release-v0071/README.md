# v0.0.71 release preparation

This preparation integrates main `e5c28844` (#593). It applies the dependency
and GitHub Actions updates the Dependabot groups define, checks every provider
integration against its current upstream release, bumps the package and
lockfile root versions from 0.0.70 to 0.0.71, adds the curated 0.0.71
changelog section, and adds this report.

The changelog groups the release as Chats and providers, Visual replies,
Claude, Codex, Kimi Code, Windows, macOS and Linux, Performance, Providers and
dependencies, and Fixes. It covers every change since `v0.0.70` (`99eac4e2`):

- #589 Fix the Kimi mark, stuck Claude turns and Windows/Linux gaps, and trim
  hot paths.
- #590 Prevent Linux update checks from rolling back an active update.
- #591 Hand a chat over to another provider with its earlier messages as
  context.
- #592 Let agents answer with a rendered page: visual replies.
- #593 Fix the regressions a review sweep of main found and refresh provider
  support, including the usage-limit snooze ending on a provider handoff.
- This PR: dependency and Actions updates and the provider review.

Schema 93 (`html_renders` and `messages.html_render_json`, from #592) is the
release's one new migration. This PR adds no migration.

## Dependencies

No Dependabot pull request is open. This branch applies every update the
configured groups define, at the newest versions on the registry on
2026-10-08, with `npm install <package>@<version>` (exact pins kept exact,
ranges raised as `versioning-strategy: increase` does) and an npm-generated
lockfile, one commit each.

| Package | From | To | Dependabot group | Commit |
| --- | --- | --- | --- | --- |
| `lucide-react` | 1.52.0 | 1.53.0 | production-patch-and-minor | `34b494b1` |
| `@playwright/test` | 1.63.0 | 1.64.0 | Excluded from development group; own commit | `3982c900` |
| `electron` | 44.5.1 | 44.7.0 | Excluded from development group; own commit | `ad7f9acd` |
| `@anthropic-ai/sdk` | 0.131.0 | 0.132.1 | Excluded (provider SDK); own commit | `d177ce1f` |

Electron 44.6.0 and 44.7.0 add backported ANGLE, Chromium, Dawn, Skia, V8 and
WebRTC fixes, a macOS launch crash fix, a `net.fetch` header fix and streamed
macOS `autoUpdater` downloads; the Node ABI is unchanged within 44.x, and a
clean `npm ci` rebuilt the native modules. `@anthropic-ai/sdk` is used only by
the provider drift scripts, and Claude Agent SDK 0.3.293 accepts it
(`>=0.93.0`); 0.132 adds API fields and models and 0.132.1 rejects empty path
parameters, none of which the drift surface reads.

Deferred: `vite` 8.3.3 and `@vitejs/plugin-react` 6.1.2 (majors, waiting on
electron-vite), `@types/node` 26.6.4 (Node 22.13 line) and `@babel/parser`
8.0.7 (major; Babel 8 requires Node 22.18). electron-builder 26.17.0 and
electron-updater 6.8.10 stay on their `v26` dist-tag, ahead of `latest`.

GitHub Actions (actions-patch-and-minor, commit `25b75429`): download-artifact
v8.0.1 → v8.0.2 (`9000827c`), setup-node v7.0.0 → v7.1.0 (`949feb24`) and
upload-artifact v7.0.1 → v7.0.2 (`cf430e03`), each pinned to the exact commit
its tag resolves to and replaced in all 31 occurrences. attest-build-provenance
v4.2.2, cache v6.1.0, checkout v7.0.1 and github-script v9.0.0 are current.

`npm audit --omit=dev` and `npm audit` both report 0 vulnerabilities.

## Providers and SDK usage

Every provider is at the version #593 reviewed on 2026-10-08: Codex 0.161.0,
Claude Agent SDK 0.3.293 (Claude Code 2.1.293), ACP SDK 1.7.0 (the Cursor
installer still points at 2026.10.01-e373342), Kimi Code 2.1.1, OpenCode and
its SDK 1.18.35 (OpenCode 2 is still unsupported), Antigravity 1.3.1 and MCP
SDK 1.32.1. No provider code changes in this PR. No provider CLI ran against a
real account.

## Renderer bundle

`mainWorkbenchFirstLoadJavaScript` (861,322 of 861,527 bytes) and
`coreJavaScript` (2,280,838 of 2,280,881 bytes) stay within the budgets main
already carries; the lucide-react update adds no bytes.

## README views

The README screenshot script runs only on macOS, so no view was recaptured on
this Linux host. The README text for provider handoff and visual replies came
with #591 and #592. No captured view seeds Kimi, so #589's new mark does not
appear in one; #589's sidebar label change (the project path as chosen instead
of its lowercased identity) was not checked against the captured views.

## Verification

On this branch, on Linux x64:

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check:quality` | 0 | Workflow concurrency, migrations, architecture, color themes, lint and typecheck pass. |
| `npm run build` | 0 | Typecheck, electron-vite build, Private Connect build and renderer bundle budgets pass. |
| `npx vitest run` | 1, then 0 | 13,070 of 13,071 tests passed while E2E specs ran on the same host; the failing `inertia-connection.dom.test.tsx` reconnect test passed 18 of 18 on its own, as it did when it flaked under load on 2026-10-06. |
| `playwright test app-shell html-render conversation-continuation` | 0 | On Electron 44.7.0. One app-shell launch first failed with `spawn ETXTBSY` while the unit suite ran, then passed 4 of 4 on its own. |
| `npm audit --omit=dev`, `npm audit` | 0 | 0 vulnerabilities. |
| `npx vitest run` on the final head (with the Claude fix) | 0 | 1,172 files and 13,074 tests pass; 8 files and 99 tests are skipped by platform. |

## Main's CI on `e5c28844`

Main's run 37735631748 on `e5c28844` failed in Windows unit tests (2/4):
`acp-adapter-drift.test.ts` "cursor ACP drift regressions > cancels a resumed
session stalled at session/load" saw the run "still running" 1 s after a
graceful cancel. The same tree passed all four Windows shards in #593's CI
(`2e776ad5`), and the shard passed on every other run since v0.0.70. The test
gave a Windows process-tree stop 1 s; this PR allows 4 s, which stays below the
fixture's 5 s control-RPC deadline whose failed result would not match, so a
cancel that does not settle the run still fails the test. The failed job on
main was rerun without code changes.

## PR CI on `009d929b`

macOS x64 failed two unit tests that this release does not touch:

- `issue-report.test.ts` "scrubs a full body of repeated "a_" in linear time"
  took 166 ms against a 100 ms limit. The full 24,000-character body takes
  about 15 ms on this Linux host (the slowest unit, `a_`) and a quarter of it
  about 3 ms, so the scan is linear; the Intel macOS runner is about eleven
  times slower. The limit is now 1 s: about six times that runner's time,
  while a quadratic scan of this body would still take far longer.
- `document-attachment-preview.dom.test.tsx` "keeps the truncated-text notice
  in its own row" read the first `status` element, which on a slow runner was
  still the "Preparing secure preview…" loading status. It now waits for the
  notice text and checks that element is the status row.

## Claude turns cut off by a notification reply

A local Claude turn on 2026-10-08 completed at "Waiting for `update.database`
to finish." while that background shell was still running, and the CLI was
stopped with it: Claude's next session reported the shell "didn't finish before
the previous session ended". The turn had started a background `gradlew
update.database` and a Monitor, ended its reply, and was correctly held open;
the Monitor's event made Claude reply again, and that reply closed the turn.

A probe through the real Claude Agent SDK 0.3.293 (Claude Code 2.1.293, Haiku,
two background shells of different lengths) shows the cause:
`background_tasks_changed` still lists the long shell when the short one ends,
but the CLI sends `system/init` before each notification-driven reply.
`ClaudeDelegateLifecycle` treated every `init` as a restarted CLI and cleared
its background level, so the next result looked final. Every `init` in the
probe carried the same `messaging_socket_path`, named after the CLI process,
and Inertia's owned query refuses a second process for one query. The level is
now reset on the first `init` and when the reported process changes, and kept
across repeated `init`s from the same process. A lifecycle test and a harness
test replaying the probe's event order fail without the change; with it the
turn completes on the long shell's final reply.

The two earlier local Claude failures ("exited without a final result", exit
143, on 2026-10-06 19:39 and 2026-10-07 07:31) each came about two seconds
after a background task's notification, the parent-resume bound #587 fixed;
both ran before the app restarted into v0.0.70, and no Claude turn has failed
that way since.

## Not exercised

Windows and macOS packaging, installers and signing, and the macOS
`autoUpdater` change in Electron 44.7.0 run in CI and the release workflow,
not on this machine.

## Changed files

- `package.json` and `package-lock.json`: the dependency updates and the
  version bump.
- `.github/workflows/ci.yml`, `.github/workflows/release-platforms.yml`,
  `.github/workflows/provider-contract-drift.yml` and
  `.github/actions/install-dependencies/action.yml`: the Actions pins.
- `CHANGELOG.md`: the curated 0.0.71 section.
- `tests/server/acp-adapter-drift.test.ts`: the cancellation window.
- `tests/shared/issue-report.test.ts` and
  `tests/renderer/document-attachment-preview.dom.test.tsx`: the two macOS x64
  test fixes.
- `src/server/provider/claude-delegate-lifecycle.ts` and its lifecycle and
  harness tests: the background level across notification turns.
- This release preparation evidence report.

## Publication boundary

This PR's exact head must pass CI, and its merge commit on main must be fully
green before the annotated stable tag `v0.0.71` is placed on that merge
commit.
