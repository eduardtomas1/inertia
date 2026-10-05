# v0.0.67 release preparation

This preparation integrates main `620e69a8` (#570). It applies the dependency
updates Dependabot's groups define, brings every provider integration up to
date with its current upstream release, fixes the provider and turn defects
found while doing so, bumps the package and lockfile root versions from 0.0.66
to 0.0.67, adds the curated 0.0.67 changelog section and adds this report.

The changelog groups the release as Settings, Diagnostics and Report an issue,
Background tasks, Appearance, Providers and dependencies, and Reliability and
safety. It covers every change since `v0.0.66`:

- #566 Gate the desktop benchmark on a warmed median instead of one cold
  sample.
- #567 Run clipboard-reading E2E specs in the exclusive display lane.
- #568 Assert the mascot approval handoff and resolution in the main window.
- #569 Bound the native diagnostic probe by the test timeout instead of
  PowerShell startup.
- #570 Rework Settings, Diagnostics and Report an issue, add Background tasks,
  the usage-limit row, custom colours across the app with the Muted colours
  switch, and the header menu fixes (#564, #563 and #554 combined).
- This PR: dependency updates, provider updates and provider fixes.

#566 to #569 change only CI and tests and share one line under Reliability and
safety. Schema 88 (`PersistNotificationPreferences`), 89
(`PersistIssueReportPreview`), 90 (`PersistSubagentTaskTelemetry`) and 91
(`PersistMutedCustomColors`) are the release's new migrations, all from #570.
This PR adds no migration.

## Dependencies

Dependabot's scheduled npm run on 2026-10-05 (run 37263104757, on main
`620e69a8`) opened #571 to #578 and then stopped at the configured limit of
eight open pull requests, so the provider SDK updates it would open next were
never proposed. This branch applies the complete set the configured groups
define, at the newest versions on the registry, with `npm install
<package>@<version>` (exact pins kept exact, ranges raised as
`versioning-strategy: increase` does) and an npm-generated lockfile. Each group
is one commit; every package the groups exclude has its own commit.

| Package | From | To | Dependabot group | Commit |
| --- | --- | --- | --- | --- |
| `@napi-rs/canvas` | 1.0.9 | 1.0.10 | Excluded from production-patch-and-minor (native); own commit | `93ab88a9` |
| `@crowecawcaw/xa11y` | 0.15.0 | 0.15.2 | production-patch-and-minor | `76ad772d` |
| `lucide-react` | 1.48.0 | 1.52.0 | production-patch-and-minor | `76ad772d` |
| `pdfjs-dist` | 6.3.289 | 6.4.299 | production-patch-and-minor | `76ad772d` |
| `ws` | 8.21.3 | 8.22.0 | production-patch-and-minor | `76ad772d` |
| `vitest` | 5.0.1 | 5.0.3 | vitest-contract | `f0ba30d2` |
| `@vitest/coverage-v8` | 5.0.1 | 5.0.3 | vitest-contract | `f0ba30d2` |
| `@types/ws` | 8.18.1 | 8.18.2 | development-patch-and-minor | `87653423` |
| `oxlint` | 1.85.0 | 1.86.0 | development-patch-and-minor | `87653423` |
| `electron` | 44.4.5 | 44.5.1 | Excluded from development-patch-and-minor; own commit | `9c922c5c` |
| `@anthropic-ai/claude-agent-sdk` | 0.3.283 | 0.3.289 | Excluded (provider SDK); own commit | `a7929de1` |
| `@anthropic-ai/sdk` | 0.128.0 | 0.131.0 | Excluded (provider SDK); own commit | `43798dd0` |
| `@agentclientprotocol/sdk` | 1.5.0 | 1.7.0 | Excluded (provider SDK); own commit | `db8002ea` |
| `@modelcontextprotocol/sdk` | 1.30.1 | 1.32.0 | Excluded (provider SDK); own commit | `93a05b18` |
| `@opencode-ai/sdk` | 1.18.32 | 1.18.34 | Excluded (provider SDK); own commit | `c049f4d7` |
| `hono` (via MCP SDK) | 4.13.5 | 4.13.13 | Security (npm audit fix, lockfile only) | `682f781c` |
| `fast-uri` (via MCP SDK) | 3.1.7 | 3.1.8 | Security (npm audit fix, lockfile only) | `682f781c` |
| `ip-address` (via MCP SDK) | 10.4.0 | 10.7.3 | Security (npm audit fix, lockfile only) | `682f781c` |
| `electron-builder` | 26.16.1 | 26.17.0 | Excluded from development-patch-and-minor; own commit (Dependabot #574) | `f8350ecc` |
| `electron-updater` | 6.8.9 | 6.8.10 | Excluded from production-patch-and-minor (update trust); own commit | `de6053f3` |
| `undici` (via `@electron/get`, development) | 7.29.0 | 7.30.0 | Security (npm audit fix, lockfile only) | `f0ac9ad7` |

Deferred:

| Package | Available | Reason |
| --- | --- | --- |
| `vite` | 8.3.2 | Major; ignored in .github/dependabot.yml until electron-vite 5 declares Vite 8 support. |
| `@vitejs/plugin-react` | 6.1.1 | Major; same ignore rule, moves with Vite. |
| `@types/node` | 26.6.4 | Minor and major ignored; declarations stay on the Node 22.13 minimum runtime line. |
| `better-sqlite3`, `node-pty`, `@napi-rs/keyring`, `@playwright/test`, `happy-dom`, `electron-vite`, `typescript`, `oxlint-tsgolint` and the other direct packages | — | Already at the latest version. |

GitHub Actions: every pin is already the exact commit of its action's newest patch and minor tag (checked with `gh api repos/actions/<action>/git/matching-refs/tags/<major>`): attest-build-provenance v4.2.2 `4d101475`, cache v6.1.0 `55cc8345`, checkout v7.0.1 `3d3c42e5`, download-artifact v8.0.1 `3e5f45b2`, github-script v9.0.0 `3a2844b7` (annotated tag `d746ffe3` dereferenced), setup-node v7.0.0 `82076278`, upload-artifact v7.0.1 `043fb46d`. No action changes.

Dependabot's own PRs compared with this branch: #571 proposed xa11y 0.15.2,
Lucide 1.49.0 and ws 8.22.0 (this branch takes Lucide 1.52.0, published
before the run, and also pdfjs-dist 6.4.299, which the bot did not propose);
#573 proposed only oxlint, and this branch also takes `@types/ws` 8.18.2 from
the same group; #572, #576, #577 and #578 match this branch; #575 proposed MCP
1.31.0 (this branch takes 1.32.0); #574 proposed electron-builder 26.17.0,
included above (it is on electron-builder's `v26` dist-tag, while the
registry's `latest` tag still names 26.15.3). After the merge, Dependabot
closes PRs whose update is already on main.

@napi-rs/canvas moved first because pdfjs-dist 6.4 requires `^1.0.10`; applied
after pdfjs-dist, npm would have nested a second copy of the native binding
under `node_modules/pdfjs-dist`, outside the `asarUnpack` pattern for
`node_modules/@napi-rs/canvas*`.

After each Electron and provider SDK commit (`9c922c5c` to `c049f4d7`),
`npm run test:portable` and `npm run test:windows-codex` ran on that commit,
and `test:native-architecture` ran after the canvas, Electron and Claude Agent
SDK commits. Every portable run had only the expected `providers.test.ts`
discovery failure described under Verification; the Windows Codex runs passed
4 with 4 native Windows tests skipped. electron-builder 26.17.0 (Dependabot's
run surfaced it after the provider work had started), electron-updater 6.8.10
and the development `undici` fix were applied after the provider fixes. They
were checked with the packaging, installer, updater and app-update suites when
applied, and by the release packaging and smokes on the candidate.

Third-party notices are generated from the installed production graph by
`npm run notices:generate` during `build:packaged`; the file is ignored by Git
and its packaged copy is verified by the package smoke. No runtime dependency
was added or removed, and the canvas, xa11y and Electron bindings keep their
paths and platform sets, so the release-container smoke needs no change. The
Windows installer smoke test pins the reviewed electron-builder version next
to its NSIS payload inspection; it moves to 26.17.0 with this review, and PR
CI runs Windows packaging and the N-1 to N installer smoke because the
lockfile changed. The new NSIS `store-asar` mode is opt-in and unused.

## Providers and SDK usage

| Adapter | Inertia before | Inertia after | Upstream current (2026-10-05) | How verified |
| --- | --- | --- | --- | --- |
| Codex App Server (JSON-RPC, no SDK) | Protocol tables verified against 0.159.0 | Verified against 0.160.0 | `@openai/codex` 0.160.0 (rust-v0.160.0, 2026-10-01); 0.162.0-alpha.14 is prerelease | The `codex-rs/app-server-protocol` tree is byte-identical at rust-v0.159.0 and rust-v0.160.0 (tree `01988e42`): 85 notifications, 11 server requests and every client method Inertia sends are unchanged. Fixtures updated to the 0.160.0 wire shapes; portable and Codex suites. |
| Claude Agent SDK | 0.3.283 (Claude Code 2.1.283) | 0.3.289 (Claude Code 2.1.289) | 0.3.289; `@anthropic-ai/claude-code` 2.1.289 | Packed 0.3.283 and 0.3.289 type diff (one new startup failure reason; no message, option or Query change), upstream changelog 0.3.284 to 0.3.289, typed fixtures, installed-SDK synthetic stdio test, portable suite. |
| Anthropic SDK (drift surface, Claude peer) | 0.128.0 | 0.131.0 | 0.131.0 | Release notes; typecheck of the drift surface; not imported by `src`. |
| Cursor (ACP) | ACP SDK 1.5.0; cursor-agent behaviour reviewed on 2026.09.02 | ACP SDK 1.7.0 (protocol v1) | Installer points at 2026.10.01-e373342 | ACP 1.5.0/1.7.0 schema diff; Cursor ACP docs (`create_plan` blocks until the client accepts or rejects); portable drift and interaction tests. The CLI was not run. |
| Kimi Code (ACP) | ACP SDK 1.5.0; Kimi Code reviewed at 0.41.0 | ACP SDK 1.7.0 | `@moonshot-ai/kimi-code` 2.1.1 | Static comparison of the 0.41.0 and 2.1.1 bundles as text: same capabilities, login method, 11 session update kinds, stop reasons and `/compact` acknowledgement. The CLI was not run. |
| OpenCode (owned `serve --pure`) | SDK 1.18.32 | SDK 1.18.34 | `opencode-ai` and `@opencode-ai/sdk` 1.18.34; OpenCode 2 is `@opencode/cli` 2.0.22 | Every SDK file except `package.json` is byte-identical from 1.18.32 to 1.18.34; upstream v1.18.34 source for the permission merge order. OpenCode 2 is reported as unsupported. |
| Antigravity (`agy` headless stream-json) | Minimum agy 1.2.2 | Unchanged | agy 1.2.16 (google-antigravity/antigravity-cli) | Documented stream-json schema matches the parser (events, step fields, statuses, usage keys); `subagent_info` added to the fixtures; changelog 1.2.3 to 1.2.16. |
| MCP SDK (host-tool server, Claude in-process tools) | 1.30.1 | 1.32.0 | 1.32.0 | Latest protocol version still 2025-11-25; the APIs Inertia imports are byte-identical; host-tool suites. |
| Gemini | Removed in schema 76 | — | — | Not an Inertia provider. |

Codex: one more notification, `thread/prediction/updated`, exists only in the
0.162.0 alpha. It is deliberately not added yet: the scheduled drift probe
(`scripts/provider-drift-probe.mjs`) requires an exact match with the latest
stable binary's generated types, so adding it now would fail the canary. An
unknown notification is a no-op at runtime and cannot fail a turn.

Cursor: keep ACP. A move to Cursor's proprietary SDK is not recommended: its
agent runs in-process, which breaks Inertia's owned process tree and output
bounds, it needs its own API-key login, it has no interactive approvals,
questions or plans, and it has no Windows sandbox or ARM64 support.

### What changed per provider, and how it is proven

Two read-only reviews audited the adapters on main `620e69a8` against the
current upstream sources. Every finding was verified against the code and the
upstream source before it was fixed; each behavioural fix has a test that
failed on the unfixed code. Findings that did not hold are listed as refuted.

**Codex** (`194ac82d`, `778df1dc`, `eb96ce33`, `2fb79378`, `ee9f8969`)

- A command approval whose command has line breaks or tabs, or a terminal
  input approval (`write_stdin --session-id N <input>`), failed the whole turn
  as a malformed App Server message, because the command was read as
  single-line text. Upstream builds the command with `shlex_join`, which keeps
  newlines inside quotes. Line breaks and tabs are now accepted; a command
  over 4,000 characters or with invisible or control characters is declined
  for that one request and the turn continues; terminal input approvals are
  titled "Send input to running command". Proven by `codex-core`,
  `codex-app-server-interactions` and three fixture scenarios in
  `codex-app-server.test.ts`, which failed with a failed run before the fix.
- Goal turns ignored the chosen reasoning effort: `effort` was sent in
  `thread/start` and `thread/resume`, whose parameters have no such field, and
  goal turns never send `turn/start`. A goal start now sends
  `thread/settings/update {threadId, effort}` before `thread/goal/set`, and the
  dead field is gone. Proven by new goal cases for a new and a resumed thread.
- A question with `options: null` (how 0.160 serialises a missing list) failed;
  it is now a free-text question. A new reasoning summary part starts on a new
  line. `thread/compacted`, which 0.160 never emits, is ignored and no fixture
  emits it.
- Fixtures now carry the 0.160.0 shapes for turns, turn errors, item
  timestamps, token usage, thread start and resume results, command approvals
  (`availableDecisions`) and questions (`isBlocking`).
- Refuted: force-terminating Codex right after `turn/completed` loses the last
  turn. Upstream saves a turn's items before it finishes the turn
  (`tasks/mod.rs`), and resume rebuilds history from them; only the final
  "turn complete" marker can be lost. No change.

**Claude** (`a7929de1`, `457343de`, `1a60d80f`, `ae3ad828`, `adb799ce`,
`d055e063`, `ba1b0e1e`, `f7585e46`, `9894159c`, `a13ae754`, `c293bf11`)

- 0.3.289 adds the `provider_not_allowed` startup failure; the exhaustive
  message map did not compile without it, and the chat now explains it.
- Security: a selected repository skill was copied into the plugin with its
  `SKILL.md` front matter, and the SDK keeps a host plugin's `allowed-tools`,
  so a skill could grant itself tools without Inertia's approval. Staging now
  keeps only name, description and argument-hint, so `allowed-tools`, `hooks`
  and `model` are dropped in any casing. A skill that sets `context` or
  `agent` (any casing) changes meaning without them, so discovery does not
  offer it and selection refuses it by name. Proven by
  `claude-skill-staging.test.ts`.
- A follow-up accepted while the first prompt ended in an error result was
  dropped. Error results now release the follow-ups they answer; while Claude
  reports `queued_turn_count` above zero the run keeps reading so the follow-up
  is answered, and otherwise the failure says the follow-up was not answered.
  `claude-follow-up-settlement.test.ts` was changed deliberately to assert
  that message.
- The Bash command never appeared in its activity: the streamed block opened it
  with empty input and the full message was ignored. The full message's
  command now updates the activity (bounded and redacted as before).
- Context occupancy came from the last `usage.iterations` entry even when it
  was a compaction entry (3,500 instead of 173,000 tokens); it now comes from
  the last message entry.
- A subagent's permission denial no longer shows as a failed parent activity;
  host tools are auto-allowed only when the SDK reports Inertia's own `sdk`
  server; an empty AskUserQuestion is a clean deny instead of a control error;
  a `rejected` rate-limit event marks the turn usage-limited (and
  `allowed`/`allowed_warning` clears it).
- Shared fixtures are typed against the 0.3.289 message types instead of cast,
  with new cases for rejected and allowed_warning rate limits,
  `queued_turn_count` and non-message iterations.
- Checked, no change: Inertia always passes `permissionMode`, so 0.3.286's
  default-mode change does not reach its turns; it never sends priority `now`
  messages, so 0.3.287's detached tool results do not occur; `defaultToNo` and
  `suppressAlwaysAllowRule` need nothing because the approval card preselects
  nothing and offers no "always allow".

**Cursor and Kimi Code** (`db8002ea`, `e51b6d3d`, `cde3fde0`, `acde3713`,
`faa14e77`, `62cc54c1`)

- ACP 1.7.0's unstable `subagent_update`, `session_message` and
  `session_message_chunk` are rejected like the unnegotiated `notice`, because
  Inertia does not advertise the `subagents` capability; the portable drift
  test proves each fails the turn with confirmed cleanup.
- A session update kind Inertia does not know yet ended the turn, while the ACP
  SDK's own client logs and drops it. A valid envelope with an unknown kind is
  now ignored (still counted against the event budget), including during
  session/load replay; known kinds keep strict validation. A usage update with
  used above size is ignored instead of failing the turn
  (`acp-adapter-drift.test.ts` was changed deliberately for that case).
- Kimi Code answers `/compact` with one text chunk saying compaction started in
  the background, then `end_turn`, and never sends `compaction_update` (0.41.0
  through 2.1.1 bundle ACP SDK 1.3.0). Inertia required a completed update, so
  every Kimi `/compact` failed and the cleanup killed the compaction it had
  started. Kimi's explicit compaction is now unavailable in the capability
  manifest, refused before launch, and the composer says why; the fixtures use
  the real acknowledgement. The composer reason grows the core and main
  workbench bundles by 142 bytes each, measured against the dependency-only
  commit, which builds exactly main's sizes; both caps rise by exactly that.
- Cursor in plan mode answered `cursor/create_plan` with `cancelled` without
  asking; Cursor's docs say it blocks until the client accepts or rejects. The
  plan is now shown to the user for approval in plan mode.
- Cursor sends a backend error as one message chunk followed by `end_turn`, so
  "Please sign in to continue", "Upgrade your plan to continue", "Add a payment
  method to continue", "Check your settings to continue" or "Error: …" became
  the answer of a completed turn. When the turn's whole output is exactly one
  of those, it now fails: sign-in as an authentication failure that asks you to
  connect Cursor, "Upgrade your plan" as usage-limited, the others with the
  text as the reason. Any further output releases the text unchanged. These
  sentences come from the reviewed build 2026.09.02 and may change.
- Refuted: a final message chunk arriving with the prompt response is lost (the
  SDK delivers notifications before the response; the reviewer's scenario
  passed 4 of 4 runs unfixed). Already handled: in-flight tool calls on cancel
  are marked "Interrupted" by the turn layer. Unchanged: "open in terminal"
  stays pinned to Cursor 2026.08.04-aaa8809, because nothing documents that
  ACP and terminal session ids still match on current builds.

**OpenCode** (`c049f4d7`, `15d8f13f`, `136e7e9a`)

- OpenCode 1.18.34 merges the agent's permission rules before the session's,
  and the last match wins, so Inertia's access-level session rules overrode the
  plan agent's edit denial: Full access and Auto-edit could edit in plan mode
  and Supervised asked. The session rules now end with an edit deny in plan
  mode for every access level; a 6-case access × mode matrix proves it.
- OpenCode 2 (`@opencode/cli`, different API, no `serve --pure`) failed closed
  but told the user to update the CLI. A `--version` major of 2 or more is now
  reported as "OpenCode 2 is not supported yet; use OpenCode 1.x
  (opencode-ai)", and a 1.x install is preferred when both exist. An OpenCode 2
  adapter is a follow-up.

**Antigravity** (`af52d1fa`, `4a46a3a5`)

- Any stderr line containing "denied" counted as a declined approval, including
  "Access is denied" and "403 PERMISSION_DENIED". Only agy's auto-denial notice
  counts now.
- `subagent_info` (1.2.16's image-generator subagent) is in the fixtures; the
  child's conversation id is nested, so the turn completes as the parent's.
- Report only: since 1.2.6, agy prints `AGY_ERROR: {...}` on stderr and exits
  with code 3 on agent or model errors; it could become a usage-limit signal
  later.

### Not verifiable without a live account

No provider CLI was run and no account was used. These rest on upstream
source, documentation, packaged types and fixtures only:

- Codex: that Codex accepts a `decline` for a command whose
  `availableDecisions` does not list it; that `thread/settings/update` applies
  the effort to goal-driven turns; account-dependent `model/list` contents; the
  content-filter retry sequence; real rate-limit payloads; live approvals; and
  Windows and Linux behaviour.
- Claude: whether Claude Code 2.1.289 fills in `mcpServer` in the permission
  callback; real `queued_turn_count` values; a real `rejected` rate-limit
  event; that Claude Code accepts the rewritten skill front matter; that
  `--thinking-display` is still accepted; and whether force-terminating the CLI
  right after the result can lose the saved session's last turn (the SDK's own
  `close()` waits 2 seconds first).
- Cursor: that build 2026.10.01 still sends backend errors as the reviewed
  sentences; how Cursor reacts to an accepted, rejected or cancelled plan;
  whether ACP and terminal session ids match on current builds.
- Kimi Code: authentication, resume and permission flows on 2.1.1, and when
  its background compaction finishes.
- OpenCode: the real `--version` output of OpenCode 2; plan mode with
  `OPENCODE_EXPERIMENTAL_PLAN_MODE`, whose plan-file write is now denied too.
- Antigravity: whether a subagent step can carry a child `conversation_id` at
  the top level (Inertia would fail that turn as a different conversation);
  whether real `agy models` output has a header row; whether stream-json mode
  ever prints a non-JSON line on stdout; the exact denial notice on 1.2.16.

## Turns

After every bump and fix was integrated (head `faa14e77` plus the budget
commit `62cc54c1`), with `npm run build:bundle` and a proven Electron 44.5.1
install, the Electron specs that drive a full turn through a fake provider ran
locally with `--repeat-each=3 --max-failures=1` in one Playwright command,
after a single smoke run of `scratch-chat`:

`core-bridge-smoke`, `image-send-regression`, `image-follow-up-regression`,
`transcript-turn-anchor`, `session-continuity`, `scratch-chat`, `limit-reset`,
`antigravity-evidence`, `goal-reliability`, `usage-limits`, `terminal-resume`
and `multi-spawn`: **51 passed, 0 failed** in 7.2 minutes, macOS ARM64,
unloaded. They cover start, streaming, approval and deny, follow-up after deny,
image send and follow-up across restart, a clamped accepted turn, a rejected
saved session replaced inside the turn, a chat without a project across
restart, resume and snooze at a usage-limit reset across restart, an
Antigravity turn through its fake CLI, a sessionless goal resumed after Stop,
provider-session resume in a split pane and multi-route spawn with a judge.
The end-to-end turn drivers are fake Codex App Server and fake Antigravity
executables; every other provider's lifecycle (Claude Agent SDK, Cursor and
Kimi ACP peers, OpenCode owned server) is covered by the portable suite's
deterministic fixtures for success, failure, cancellation, malformed messages,
output limits and clean shutdown. Provider discovery in these launches is
confined by `INERTIA_TEST_PROVIDER_BIN_DIR`, so no installed provider CLI was
discovered or run.

## README views

`NODE_ENV=test npm run screenshots:readme` captured all nine views on the
release candidate (version bump and changelog included), macOS ARM64. The
capture confines provider discovery to an empty fixture directory, so no
provider CLI is discovered or executed. Each capture was compared with main's
image byte by byte and, where bytes differed, pixel by pixel:

| View | Result | Decision |
| --- | --- | --- |
| `inertia-dark.png` | Byte-identical | Kept |
| `inertia-message-search.png` | 423,306 pixels differ: the palette now lists the **Usage display** setting (Chats) above the message results for "context", from #570's one-entry-per-setting palette | Replaced |
| `inertia-project-picker.png` | Byte-identical | Kept |
| `inertia-split-workspace.png` | Byte-identical | Kept |
| `inertia-git-workflow.png` | Byte-identical | Kept |
| `inertia-goals.png` | Byte-identical | Kept |
| `inertia-image-preview.png` | Only the previewed file's size label differs (373.8 KB, now 374.8 KB), the case v0.0.65 and v0.0.66 kept | Kept |
| `inertia-light.png` | Byte-identical | Kept |
| `inertia-add-project.png` (not referenced by the README) | Byte-identical | Kept |

The README's palette sentence now names settings among what **Ctrl/Cmd+K**
finds. None of the other fixtures shows Settings, Help, Background tasks, the
usage-limit row or a custom colour, so #570's other visual changes do not
appear in them. The user docs already use #570's Settings paths
(**Settings → Agents**, **Settings → Help**, **Settings → Devices &
integrations** and so on) and need no change. Every image the README
references still exists.

## Verification

On the release candidate `64143231` (main `620e69a8` plus every dependency
update, provider fix, the version bump, the changelog and the README view),
macOS ARM64, Node 22.23.2, a fresh `npm ci` and a verified Electron 44.5.1
framework binary. Each command ran on its own; provider discovery was confined
to an empty directory (`INERTIA_TEST_PROVIDER_BIN_DIR`), so no installed
provider CLI could be discovered or run.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check:quality` | 0 | Workflow concurrency, 91 migration lineage entries, architecture (1,409 source files, 5,371 internal edges), colour themes, lint and all typechecks |
| `npm test -- --maxWorkers=2` | 1 | 12,230 passed, 140 platform-dependent skips, 1 expected failure, in 1,132 files (14 skipped), 457.8 s, no unhandled errors |
| `npm run build:bundle` | 0 | Every renderer budget within its cap (core 2,266,194 / 2,266,194 bytes, main workbench first load 868,412 / 868,412, detached chat first load 661,286 / 665,030) |
| `npm run test:portable` | 1 | 2,345 passed, 9 skipped, 1 expected failure, in 158 files (1 skipped) |
| `npm run test:windows-codex` | 0 | 4 passed; the 4 native Windows tests are skipped on macOS |
| `npm run test:native-architecture` (`INERTIA_EXPECTED_ARCH=arm64`) | 0 | darwin/arm64, Claude manifest 0.3.289 |
| `npm run build:packaged` | 0 | Third-party notices regenerated (agentclientprotocol 1.7.0, Claude Agent SDK 0.3.289, canvas 1.0.10, electron-updater 6.8.10, hono 4.13.13, pdfjs-dist 6.4.299 among them) |
| `npm run package:release:mac` (`INERTIA_RELEASE_PLATFORM=macos-arm64`, `INERTIA_RELEASE_CHANNEL=stable`, no signing credentials) | 0 | `Inertia-0.0.67-arm64.dmg` and `Inertia-0.0.67-arm64-mac.zip` |
| `npm run verify:fuses -- release/mac-arm64/Inertia.app` | 0 | Fuses verified |
| `npm run test:package-smoke` | 0 | Runtime observed, PDF extraction and image retention verified, manual updater fallback 6.8.10, launch to ready 2,555 ms, clean exit |
| `npm run test:release-container-smoke` | 0 | ZIP (launch to ready 2,364 ms) and DMG (3,064 ms), each with 19 verified native binaries and a clean exit |
| `codesign --verify --deep --strict --verbose=2 release/mac-arm64/Inertia.app` | 0 | Valid on disk and satisfies its designated requirement (ad-hoc) |
| `node scripts/verify-database-lineage.mjs --base-ref origin/main` | 0 | 91 entries |
| `npm audit --omit=dev` | 0 | 0 vulnerabilities |

The one expected failure in `npm test` and `test:portable` is
`tests/server/providers.test.ts` "resolves and reuses an absolute command path
and its discovered environment", which needs real PATH discovery and passes in
CI; it is the same case recorded for v0.0.64, v0.0.65 and v0.0.66. Both
commands therefore exit 1 locally.

The full `npm audit` then reported a development-only `undici` 7.29.0 under
Electron's install-time download helper (also on main). Commit `f0ac9ad7`
moves it to 7.30.0 in the lockfile only; after it, a fresh `npm ci`, the
Electron download through the new version, `check:quality`, `build:bundle`
and `test:native-architecture` passed again, and `npm audit` reports 0
vulnerabilities. Later commits change only this report.

Before the version bump, on the integrated provider fixes (`faa14e77`), the
full unit suite (same counts and the same single expected failure),
`test:portable` (2,345 passed) and `test:windows-codex` also passed, and the
Electron turn specs ran as described under Turns. The package and container
smokes launch with `NODE_ENV=test`, where the runtime starts with providers
disabled.

Main's CI on `620e69a8` (run 37242230245) passed.

## Not exercised

Windows and Linux packaging, installers and container smokes, macOS x64,
Developer ID signing, notarization, Windows Authenticode signing, a real macOS
Keychain prompt, and any real authenticated provider account or provider CLI.
The tag workflow certifies all six native platforms.

## Changed files

- `package.json` and `package-lock.json`: the dependency updates and root
  version 0.0.67.
- `CHANGELOG.md`: the curated 0.0.67 section.
- `README.md` and `docs/screenshots/inertia-message-search.png`: the palette
  sentence and the recaptured view.
- `src/server/codex/` (`app-server-events.ts`, `app-server-notifications.ts`,
  `app-server-requests.ts`, `app-server-run.ts`, `approvals.ts`,
  `questions.ts`), `src/server/provider/codex-app-server-harness.ts`,
  `scripts/package-smoke-codex-fixture.cjs` and
  `tests/helpers/codex-app-server-fixture.ts`: Codex.
- `src/server/provider/claude-*.ts`, including the extracted
  `claude-permission-broker.ts` and `claude-tool-activity-projection.ts`, and
  `tests/helpers/claude-agent-sdk-protocol.ts`: Claude.
- `src/server/provider/acp-json-rpc.ts`, `cursor-acp-*.ts` (new
  `cursor-acp-inband-errors.ts`), `kimi-acp-*.ts`, `run-coordinator.ts`,
  `capability-manifest.ts`, `src/shared/provider.ts` and
  `src/renderer/src/components/composer/useComposerCompaction.ts`: Cursor and
  Kimi Code.
- `src/server/provider/opencode-host-tools.ts`, `opencode-sdk-harness.ts` and
  `discovery.ts`: OpenCode.
- `src/server/provider/antigravity-stream.ts`: Antigravity.
- `scripts/check-renderer-bundle.mjs`: two caps raised by 142 bytes each.
- `tests/`: the failing-first tests and updated fixtures named above.
- This release preparation evidence report.

## Publication boundary

This PR's exact head must pass CI, and its merge commit on main must be fully
green before the annotated stable tag `v0.0.67` is placed on that merge
commit. The tag workflow then certifies all six native platforms and validates
the complete asset union, checksums and provenance before publishing. Use the
curated changelog text for the public release notes. No tag, public release or
asset replacement is part of this preparation.
