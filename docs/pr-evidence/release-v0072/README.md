# v0.0.72 release preparation

This preparation integrates main `b3eb887c` (#606). It applies the fixes a
six-part readiness review of that main found, the dependency updates the
Dependabot groups define, the provider SDK updates, recaptured README views,
release workflow hardening, the package and lockfile root version bump from
0.0.71 to 0.0.72, the curated 0.0.72 changelog section, and this report.

The changelog groups the release as Tasks, Chats and turns, Plans, Chat
titles, Mascot, Windows, macOS and Linux, Performance and updates, Providers
and dependencies, and Fixes. It covers every change since `v0.0.71`
(`7e95d68d`):

- #597 Make turns feel coordinated: page and answer together, follow-ups never
  lost, faster turn start (also the context transport v3, the context tool,
  copy, the token subtraction, the Windows title bar overlay and
  Shift+Cmd/Ctrl+W for Close Window).
- #598 Make the desktop mascot truthful and useful with several chats.
- #599, #600, #601 Dependabot: lucide-react 1.54.0 and smol-toml 1.9.1,
  Claude Agent SDK 0.3.295, happy-dom 20.14.6.
- #602 Fix the macOS isolated lane: wait for the file preview re-centre and
  diagnose stalled quits.
- #546 Add Tasks: a to-do list that hands work to an agent.
- #603 Stop the Linux exec helper waiting on a guardian that has already
  exited.
- #604 Reflect provider plan progress in the Plan tab.
- #605 Name new chats automatically from the first prompt.
- #606 Fit the mascot's failed label on every platform.
- This PR: the readiness fixes, dependencies, README views and release gates.

Schemas 94 (`RecordAgentContextReads`) and 95
(`CompactConversationContextTransport`), both from #597, and 96
(`PersistTodos`, from #546) are the release's migrations. This PR adds no
migration of its own.

<!-- PERF: migration 97 and the performance/update-everything branch, if it
merges before the tag, change the line above and the sections marked PERF. -->

## Dependencies

No Dependabot pull request is open. `work/release-deps` applies every update
the configured groups define except `@tanstack/react-virtual` (deferred
below), at the newest versions on the registry on 2026-10-13, with
`npm install <package>@<version>` (exact pins kept exact, ranges raised as
`versioning-strategy: increase` does) and an npm 10.9.8 (Node 22.23.2)
lockfile, one commit each.

| Package | From | To | Dependabot group | Commit |
| --- | --- | --- | --- | --- |
| `lucide-react` | 1.54.0 | 1.56.0 | production-patch-and-minor | `bab0a8cd` |
| `zod` | ^4.6.5 | ^4.6.7 | production-patch-and-minor | `d6f5444c` |
| `@napi-rs/keyring` | 2.1.0 | 2.1.1 | production-patch-and-minor; own commit (backs the Cursor keychain read) | `9c9a3a66` |
| `@napi-rs/canvas` | 1.0.10 | 1.0.11 | Excluded from production group (native); own commit | `e64ad3e2` |
| `vitest`, `@vitest/coverage-v8` | 5.0.3 | 5.0.4 | vitest-contract | `707cc020` |
| `oxlint` | ^1.87.0 | ^1.88.0 | development-patch-and-minor | `1fa54eca` |
| `oxlint-tsgolint` | 7.0.2003 | 7.0.2004 | development-patch-and-minor | `6557c480` |
| `@testing-library/user-event` | 14.6.7 | 14.6.8 | development-patch-and-minor | `91c46abc` |
| `electron` | ^44.7.0 | ^44.7.1 | Excluded from development group; own commit | `8655ea39` |
| `@anthropic-ai/claude-agent-sdk` | 0.3.295 | 0.3.296 | Excluded (provider SDK); own commit | `2348da30` |
| `@agentclientprotocol/sdk` | 1.7.0 | 1.8.0 | Excluded (provider SDK); own commit | `ab057a7d` |
| `@opencode-ai/sdk` | 1.18.35 | 1.19.0 | Excluded (provider SDK); own commit | `1ac59796` |
| `@anthropic-ai/sdk` | 0.132.1 | 0.133.0 | Excluded (provider SDK); own commit | `f9e773d7` |

The npm 10 lockfile drops the `libc` fields that Dependabot's newer npm wrote
for the four Claude Agent SDK Linux packages in #600; npm 10, which CI uses,
ignores them.

Electron 44.7.1 fixes Linux crashes without a display server or when GTK
fails to load, a re-added `WebContentsView` staying hidden on Linux, asar
archives in non-ASCII folders on Linux and ShadowRealm GC renderer crashes,
refactors Windows mouse forwarding for
`setIgnoreMouseEvents(true, { forward: true })` (the mascot window uses it)
and updates Chromium to 152.0.7977.149. Node stays 24.21.0 and the module ABI
149, so the native modules need no new ABI; `npm ci` rebuilt them. zod 4.6.7
differs from 4.6.6 only in its version string and carries SLSA provenance
after the reverted, never-published compromise of zod's `main` on
2026-09-21. @napi-rs/canvas 1.0.11 adds a 71 KB `sbom.cdx.json` to each
platform package, which the unpack rule ships. `npm audit signatures`: 662
packages have verified registry signatures and 152 verified attestations.

Deferred: `@tanstack/react-virtual` 3.14.19 stays at 3.14.13. It moves
`@tanstack/virtual-core` from 3.17.11 to 3.19.4, six releases from 2026-10-09
to 2026-10-13 that rewrite the scroll correction the transcript relies on
(`anchorTo: "end"`, end-aligned `scrollToIndex`). Also deferred: `vite` 8.3.4
and `@vitejs/plugin-react` 6.1.2 (majors, waiting on electron-vite),
`@types/node` 26.6.5 (Node 22.13 line), `@babel/parser` 8.0.7 (Babel 8 needs
Node 22.18) and `happy-dom` 21.0.1 (major). electron-builder 26.17.0 and
electron-updater 6.8.10 stay on their `v26` dist-tag. GitHub Actions pins are
all current.

`npm audit --omit=dev` and `npm audit` both report 0 vulnerabilities.

## Providers and SDK usage

- Claude Agent SDK 0.3.296 (Claude Code 2.1.296) adds `claude_code_version` to
  the `initialize` response, `autoCompactWindow` for agents, a merged
  `sandbox` option and a 4,096-character MCP description limit. Inertia reads
  none of the new fields.
- ACP SDK 1.8.0 moves to ACP schema 1.25.0: session notices and compaction are
  stable, and the schema rejects malformed values. The Cursor and Kimi ACP
  fixtures pass unchanged.
- OpenCode SDK 1.19.0 changes only the `autoupdate` doc comment. OpenCode 2
  stays unsupported.
- `@anthropic-ai/sdk` 0.133.0 is used only by the drift scripts; the drift
  type and runtime surfaces build against all four SDKs.

`src/server/provider/capability-manifest.ts` carries the new bundled versions,
which `provider-capability-manifest.test.ts` requires to equal the exact pins.
Automatic Codex titles (#605) make one ephemeral, read-only request on the
user's account after a chat's first turn. No provider CLI ran against a real
account.

## Renderer bundle

Two caps change on this branch, each by the exact growth measured on macOS
arm64 against a build of main:

- `deferredTasksViewJavaScript`: +113 bytes (20 KiB + 469 to 20 KiB + 582) for
  the task hand-off start and folder picker error reporting.
- `mainWorkbenchFirstLoadJavaScript`: +596 bytes (871,061 to 871,657) for
  zod 4.6.7; lucide-react 1.56.0 adds none.

Every other cap is unchanged. `detachedChatFirstLoadJavaScript` and
`coreJavaScript` grow by the same 596 bytes within their existing caps. The
review found that #597 raised `coreJavaScript` and `entryCss` about 12.6 KB
and 16 KB beyond their measured growth; they are re-baselined from a fresh
build after the PERF branch merges.

<!-- FINAL: core and entryCss re-baseline numbers -->

## README views

`scripts/capture-readme-screenshots.mjs` (macOS only) recaptured every README
view for the current interface on macOS arm64 with seeded data and fake
providers: add project, dark, Git workflow, goals, image preview, light,
message search, project picker and split workspace. Two views are new:
`inertia-tasks.png` (the Tasks page with an urgent task open, ready to hand
to an agent) and `inertia-plan.png` (a plan document with step progress), each
with a README paragraph. The script now waits for branch menus and orders the
seeded data, so a rerun produces the same views.

## Readiness sweep

Six read-only reviews of main `b3eb887c` covered the renderer, persistence,
Electron, security and packaging, the server runtime and providers,
interactions between the merged PRs, and tests and CI. Every fix below has a
test that failed on the unfixed code.

- Long chats (persistence, high, a #604 regression): the latest history page
  carries the newest plan even when its turn is older than the 40 loaded
  entries, and the event schema rejected a plan whose turn was not on the
  page, so any such chat showed "unreadable response" and dropped its
  connection. A plan whose turn is absent is now accepted, and the run check
  stays when the turn is present (`server-event-schema.test.ts`,
  `conversation-history.test.ts`, `conversation-detail.test.ts`).
  Follow-ups: the plan document is kept and off-page plans stay out of the
  imported-history box
  (`plan-panel-document.dom.test.tsx`, `response-timeline.test.ts`).
- Renames (renderer): the header compared the draft with the live title and
  the sidebar sent any non-empty draft, so an automatic title arriving during
  an edit was replaced by the old name. Both now compare with the title the
  edit started from (`workspace-header-scratch.dom.test.tsx`,
  `sidebar-work.dom.test.tsx`).
- Tasks: start and folder picker failures reach the action error path
  (`tasks-view.dom.test.tsx`); a task deleted during start removes the empty
  chat, and a queue failure keeps the prompt in the chat
  (`todo-commands.test.ts`).
- Titles: task and agent-created chats are locked against automatic naming,
  also after the task is deleted; **Regenerate title** uses the quick title
  and is locked; Claude titles are read with the chat's own `dir`
  (`conversation-title-service.test.ts`).
- Windows: a forced `taskkill` with no graceful phase gets the whole close
  budget instead of 2 s, so a slow Codex metadata read is kept
  (`process-lifecycle.test.ts`).
- Secrets: the header pattern in `command-secrets.ts` was quadratic on long
  runs of name characters (about 0.9 s for 32 KB); it is now anchored on the
  keyword (`command-secrets.test.ts`).
- Backups: recovery validation checks the four triggers migration 95
  recreates (`database-recovery-schema-columns.test.ts`).
- Mascot labels clipped beside the widest picker in DejaVu Sans Bold:
  **Ready**, **Reconnecting** and **Input needed** replace the longer copy, and
  a test bounds every label (`mascot-labels.test.ts`).
- Release workflow: Windows x64 release builds failed their first attempt in
  3 of the last 4 releases at the desktop benchmark. They now exclude the
  workspace from Defender, download Electron before the timed run and allow
  130 minutes. Every `xvfb-run` keeps the server alive (`-noreset`) and
  uploads its log on failure. Release identity requires the tag commit to be
  on main, and release quality compares migrations with the previous stable
  tag on full history (`ci-workflow-contract.test.ts`,
  `cross-platform-packaged-behavior.test.ts`).
- Tests: the Windows lock ordering test allows 10 s, tests set
  `DISABLE_SYSTEM_FONTS_LOAD`, the provider settings hover retries until the
  row is hovered, and a forced Electron fixture close names its exit stages.

Noted, not fixed: the SQL cut of command detail at 4,096 characters can leave
a token's first characters before scrubbing; reconnect backoff resets after
each successful sync; the macOS forced-termination root cause stays open
(#602 diagnostics only); on Windows the hidden title-bar menu likely makes
**Window → Show mascot** unreachable, while **Unhide** in Settings works;
`docs/` is about 318 MB after #597's images and is not packaged.

## Performance and updates

<!-- PERF -->

## Verification

On `release/v0.0.72`, on macOS arm64, as separate commands:

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check:quality` | <!-- FINAL: exit --> | <!-- FINAL: result --> |
| `npm test` | <!-- FINAL: exit --> | <!-- FINAL: files and tests --> |
| `npm run build:bundle` | <!-- FINAL: exit --> | <!-- FINAL: renderer budgets --> |
| `npm run test:portable` | <!-- FINAL: exit --> | <!-- FINAL: tests --> |
| `npm run test:windows-codex` | <!-- FINAL: exit --> | <!-- FINAL: result --> |
| `npm run benchmark:desktop:built` | <!-- FINAL: exit --> | <!-- FINAL: result --> |
| `npm audit --omit=dev`, `npm audit` | 0 | 0 vulnerabilities. |

`work/release-deps` also ran `test:portable` after each provider SDK commit,
`test:windows-codex`, and the chat-scroll, transcript, turn-anchor,
reload-stability and app-shell E2E specs on Electron 44.7.1. Its first
`npm test` under load failed `opencode-sdk-harness.test.ts` "cancels and kills
the owned process while startup readiness is pending" (empty marker file); it
passed 5 of 5 alone and the rerun passed.

<!-- FINAL: E2E specs run on the final head, with repeat counts -->

## CI

PR CI runs the change classifier, migration lineage, the quality gate, the
Node 22.13 minimum runtime, Linux core and portable conformance, the Linux,
Windows x64 and macOS arm64 lifecycle sentinels, the Windows unit shards and
the platform and Electron jobs the classifier selects. Linux ARM64, macOS x64
and Windows ARM64 run only in the scheduled six-target nightly, and the
desktop benchmark on Windows and macOS runs only in the release workflow.

The release workflow adds, on this branch: the tag commit must be an ancestor
of `origin/main`; released migrations are compared with the previous stable
tag on full history; Windows release builds exclude the workspace from
Defender, download Electron before the benchmark and allow 130 minutes; Xvfb
runs with `-noreset` and keeps its log on failure. The release workflow on the
tag is the first run of these steps.

<!-- FINAL: PR CI run and result on the exact head -->

## Not exercised

- Windows and Linux locally: the Windows title bar overlay, Windows
  **Show mascot** reachability, the Windows `taskkill` budget on a slow
  machine and the Linux exec helper ran only in tests and CI.
- Nightly-only lanes (Linux ARM64, macOS x64, Windows ARM64) have not run on
  #604, #605 or #606; a green nightly on the merge commit, or the release
  workflow, is their first run.
- Real providers: no Claude, Codex, Cursor, Kimi Code, OpenCode or Antigravity
  CLI ran. The live Codex title request was not observed.
- Packaging, installers and signing run in the release workflow only.

## Changed files

- `package.json`, `package-lock.json`: dependency updates and the version
  bump.
- `src/server/provider/capability-manifest.ts`: the provider SDK pins.
- `src/shared/contracts/server-event-discriminants.ts`,
  `src/renderer/src/utils/response-timeline/model.ts`,
  `src/renderer/src/utils/terminalTurnProjection.ts`: off-page plans.
- `src/renderer/src/components/WorkspaceHeader.tsx`, `Sidebar.tsx`: renames.
- `src/renderer/src/components/TasksView.tsx`, `AppLayout.tsx`,
  `tasks/TaskHandoff.tsx`, `src/server/runtime/commands/todo-commands.ts`:
  Tasks start.
- `src/server/runtime/conversation-title-service.ts`,
  `src/server/runtime/commands/conversation-commands.ts`,
  `src/server/persistence/conversation-repository.ts`,
  `src/server/provider/claude-session-title.ts`: titles.
- `src/server/process-lifecycle.ts`, `src/server/provider/command-secrets.ts`,
  `src/server/persistence/database-recovery.ts`,
  `src/server/persistence/context-packet-triggers-schema.ts`,
  `src/server/database.ts`: Windows close budget, secrets, backup checks.
- `src/shared/mascot.ts`: mascot labels.
- `.github/workflows/ci.yml`, `.github/workflows/release-platforms.yml`,
  `scripts/validate-release.mjs`: release gates and Xvfb.
- `scripts/check-renderer-bundle.mjs`: the two caps.
- `scripts/capture-readme-screenshots.mjs`, `README.md`, `docs/screenshots/`:
  README views.
- `vitest.config.ts` and tests under `tests/`: the proofs above.
- `CHANGELOG.md` and this report.

<!-- FINAL: PERF branch files -->

## Publication boundary

This PR's exact head must pass CI, and its merge commit on main must be fully
green before the annotated stable tag `v0.0.72` is placed on that merge
commit. Before tagging, wait for a green nightly on the merge commit, or treat
the release workflow as the first run of the nightly-only lanes there. The tag
is placed only when the owner asks.
