# Pre-release regression audit, 2026-09-23

This pre-release audit repairs three defects: OpenCode
startup diagnostics could expose launch credentials; goal workflow updates could
steal focus and redirect budget typing; and split-pane tool buttons reported a
closed panel while its empty launcher was open. All three have regression
controls that failed before their corresponding production fixes.
No actual credential exposure was observed; all credential controls use synthetic
values and local fixture processes.

## Exact scope

Release baseline: `v0.0.61`, `ad204b742f869ea7ea864909206421ba149ff564`.
Audited main: `178940bbd95a660d8bbf12b755ecbd97022df973`.
Audit branch: `codex/release-regression-audit`, based on that main commit.
The release-to-main interval includes these ten merged changes:

| PR | Area | Merge commit |
| --- | --- | --- |
| #446 | Reviewed dependency batch | `620ca04842dbd18ef0f69962c2f74f09c6057a6b` |
| #447 | Detached chat titles | `d1de153e743575a3556eec2dc8ca70b4d58a4bfd` |
| #450 | Development AppUserModelID | `840e27a781d383985c2e25e8d1b711f271ea0f28` |
| #451 | Workspace header and right-panel surfaces | `1d0dc60305f729bd1a8edac97b447d1eb7c9d9e0` |
| #452 | Unexpected Claude/OpenCode exits | `d3bd5b18d08dfd8d7baba1fc1870d0857d350a94` |
| #449 | Claude resumed notification ownership | `aa44d214191f63bca7e73633a39950fb3d82b88c` |
| #455 | Full durable attachment store | `ee7e15c7c45b751cbec6a5cc9d4e04bc64572400` |
| #434 | Bounded CI diagnostics | `be12f1e28ba784b62f2b3ca149519c99a8d34deb` |
| #454 | Working indicators | `558395da97498dd06201d7e5802b446272afd56c` |
| #459 | Seven-PR integration and CI repairs | `178940bbd95a660d8bbf12b755ecbd97022df973` |

The source heads below identify the integrated feature work. The review used
the resulting main source and its interactions, not just individual PR patches.

| PR | Reviewed source head |
| --- | --- |
| #454 | `76441d412b143a9f8ee826df5fbbcaa0a55df13e` |
| #459 | `cfc6aa41e6d779e9cb2476ab2a77e1571ccc2dc1` |
| #458, four Claude answers | `f5010035df2eca922352fbb52b9ec58f72c20686` |
| #457, toolbar focus and composer evidence | `a0e20dbdee44a54f53151953361a3f6490015dbc` |
| #456, project appearance and favourites | `a3436855f0e902d6e775f3f4dbb446969a2d86ca` |
| #448, composer surface | `4ef8ab5db494527ed9ffe15cb32a0fb538eb9283` |
| #435, attachment zoom and gallery | `9f7a0517f748f1f1da787220f955f7a9a5013750` |
| #431, confirmed source cleanup | `76bcb3300396a9de2758e07163edc565f319d610` |
| #427, package contents and transcript following | `f5cf5b1a38cfdd0ee49db96f5791af16c1fd9afb` |

PR #460 was reviewed separately, read-only. Its published source head at audit
start was `5eff8eb4f6464a9c946ed01498380acd7e250ff3`. The coordinator's final
warning repair was also inspected against main, with these SHA-256 identities:

- `src/server/runtime/commands/agent-workflow-commands.ts`:
  `6c031cbf74fbc6ce416a79229551ed7458f66ec0ef09241cf0f1795751b6cce2`
- `tests/server/agent-workflow-commands.test.ts`:
  `5a3d531dead616427e67e46872e6160913c07edd604375b1cf25e854464cff49`

The coordinator subsequently published that unchanged reviewed source at
`632c4b265bce50861f5358f8951daa8fc5eee7de`.

That change preserves blocked mutation authority, returns route-filtered saved
state, and adds a response-only warning for blocked native refresh. Existing
warnings survive and admitted refresh releases its reservation in `finally`.
No integration finding or source overlap was found. Its implementation and
validation remain owned by the coordinator; this branch does not contain it.

## Confirmed repairs

### OpenCode launch credentials in failure details (P1)

The new unexpected-exit dossier appends the owned server's bounded stdout/stderr
to `failure.technicalDetail`. The generic pattern scrubber cannot recognize an
opaque API key printed without a credential label, or OpenCode's generated
server password. A failing local child that prints those values demonstrated
that they survive in the persistence-bound failure result.

The harness now collects credential values from the actual owned launch
environment and explicitly includes the actual server password regardless of
length. It deduplicates and sorts the values longest first, then applies the
existing exact-value scrubber before diagnostic sanitization. Host-tool
redaction, useful failure text, bounds, classification and cleanup requirements
remain in place. No environment, protocol, authority or dependency change is
needed.

`opencode-failure-credentials.test.ts` exercises supplied long, generated, seven-
character, one-character and empty-fallback passwords, plus a short password
inside a longer API key. PR review identified that the initial generic collector
omitted configured passwords shorter than eight characters. Three additional
controls failed before the explicit-password union, while four other controls
passed. The generic arbitrary-environment heuristic is unchanged. Host-tool
redaction still runs first, and useful failure context and cleanup assertions
remain intact.

The adjacent process-tree cleanup catch was also traced. Terminator exceptions
are wrapped in a fixed `ProcessTreeTerminationError` message; the underlying
cause is not published. The ownership-retirement path uses the privileged
journal, not provider text. A separate real-server test kills the child and injects
a credential-bearing terminator error: the final cleanup failure and emitted
status omit the underlying cause and retain `cleanupConfirmed: false`. This
control passes without an additional cleanup-path production change.

### Goal workflow refresh could redirect input focus (P2)

CI run `35892516435` failed the macOS ARM lifecycle sentinel at the exact
request-text assertion in `goal-reliability.spec.ts:179`. Its saved snapshot
contains `/goal Ship the reliable goal flow12000` and the expected first-action
provider output. The provider had started; the expected objective did not match.
The artifact preserves test actions but no browser focus-event sequence, so it
does not prove which refresh or focus event caused that hosted result.

The goal control is byte-identical between v0.0.61 and the audited main head;
this focus defect predates the reviewed release interval. Source review found
that every new workflow or goal object scheduled another
animation frame to focus Objective or the first action. Three deterministic DOM
controls reproduced focus being stolen from Budget during refresh, and from
explicit budget/outside focus before the opening frame. The submission control
requires an unchanged objective and the separate 12,000-token budget.

The goal disclosure now consumes one opening-focus intent in a layout effect,
before later user interaction. Same-owner data updates cannot rearm it. If the
target is initially disabled or unavailable, explicit focus or pointer intent
cancels it; otherwise a readiness change may fulfill it once. Closing rearms it.
The first resolved owner is adopted, while change or loss of an established
owner still clears drafts and dismisses the disclosure before another focus.
Controls also cover asynchronous arrival, disabled readiness, focus out and
back, reopening, owner changes and recovery-budget focus.

The native fixture, exact-text assertions, worker count and all deadlines remain
unchanged. The final focus implementation fits the existing renderer budgets;
its first deferred-frame draft exceeded the core limit and was simplified before
publication. Shared intent event names and native-label predicates avoid
repeating equivalent code. This is a reproduced product defect consistent with
the hosted snapshot, not a claim to have captured that run's exact event order.

### Split-pane tools toggle state (P2)

The new right panel can show its launcher with no selected surface. Both split
scene projections still used `activeTool !== null` as the open flag. Consequently
an open launcher retained the button's closed label and false pressed state.

Both projections and their memo dependencies now use `layout.toolsVisible`.
`split-pane-panel-state.dom.test.tsx` uses the real layout and split-scene hooks
for primary and pinned panes. It opens an empty launcher, checks the persisted
open state, verifies the corresponding scene flag and isolation from the other
pane, then closes it. Both cases failed before and pass after the repair.

## Review coverage and limits

This was a targeted source and integration audit of the release interval,
including changed callers and their authority boundaries. It was not a new
line-by-line certification of the entire repository.

| Area | Inspected behavior and result |
| --- | --- |
| Provider lifecycle | Claude resumed prompt/notification ownership and zero-ack handling; four-answer bounds; Codex stale pre-response turn identity; OpenCode failure classification, process ownership and diagnostic publication. Credential defect repaired above; no other demonstrated regression. |
| Attachment capacity | Serialized mutation/retention, same-batch and nonterminal protection, durable transcript eviction, follow-up ownership and startup reconciliation. No demonstrated loss or admission bypass. |
| Git reversal | Reused repository diff requires an unchanged complete fingerprint and ordinary whitespace semantics; secure roots, file/index reads and pre-apply checks remain fresh. No authority relaxation found. |
| Renderer integration | Header controls and responsive portals; right-panel persistence and split ownership; terminal scope; toolbar focus; transcript wheel intent and observer cleanup; composer attachment admission; gallery visibility, zoom and modal lifecycle. Goal-focus and split-panel state defects repaired above. |
| Appearance and indicators | Partial project appearance commands, update revisions and field salvage; deferred contrast cache; working-indicator settings/migration; reduced motion, visibility and shared animation cleanup; cross-window phase identity and expiry. No demonstrated regression. |
| Persistence and IPC | New append-only working-indicator migration, settings validation and boundary routing; detached title normalization and first-message history behavior. Privileged operations remain outside the renderer. |
| Runtime diagnostics | Shutdown observers retain original promises, fixture opt-in and bounded scalar evidence. No changed deadline, cleanup result or production authority. |
| Packaging and cleanup | Platform-specific package exclusions retain current-platform runtime assets and Chromium notices; removed legacy paths are not active production routes; package smoke, fuse, checksum/provenance checks remain. Development AppUserModelID change preserves packaged identity. |
| Dependency integration | Reviewed package/lock changes and affected provider/runtime contracts; this audit introduces no dependency change. Live upstream provider compatibility is outside local fixture coverage. |

Potential issues were not promoted to fixes without a reachable defect. In
particular, attachment reconciliation runs during startup before active staging;
the process-tree error cause is not exposed by its message wrapper; and protocol
notification-order suspicions require provider evidence beyond the deterministic
fixtures. Prior CI failures and their cause limits remain documented in
`docs/pr-evidence/combined-review/README.md`; this audit does not reinterpret a
local passing run as an explanation of a hosted failure.

## Initial reviewed-head verification (`3487e28e`)

Environment: local macOS ARM64, Node.js 22, reviewed `npm ci` dependency graph.
Existing assertions, deadlines, worker configuration, sample policies and bundle
budgets are unchanged. Heavy test cohorts are coordinated sequentially.

| Check | Result |
| --- | --- |
| `npm ci` | Passed; 670 packages, zero reported audit findings |
| Baseline renderer state cohort | 40 tests in 5 files passed |
| New split-pane control before fix | Both primary and pinned cases failed at the incorrect open flag |
| Split-pane control and layout/split neighbors after fix | 17 tests in 3 files passed |
| New OpenCode startup credential controls before fix | Both supplied/generated password cases failed because values remained in detail |
| Provider diagnostic/lifecycle neighbors after fix | 18 tests in 4 files passed |
| OpenCode startup and process-tree diagnostic controls | 3 tests passed, including the additional cleanup cause control |
| Portable registration and diagnostic controls | 4 tests in 2 files passed; `test:portable --list` includes the new file and retains the existing OpenCode conformance owner |
| Full quality, unit/integration/DOM and build gate | Passed: 9,918 tests, 146 skips, 925 passing files; 7 separate child controls passed; production build, Private Connect and all renderer bundle budgets passed |
| Full portable provider contracts | Passed: 1,623 tests, 9 platform skips, 114 files; 159.19 seconds |

The full gate uses `npm run check:quality && npm test -- --maxWorkers=2 && npm
run build:bundle`, the complete `npm run check` sequence with the coordinator's
existing two-worker policy. Final unit/integration/DOM duration: 449.74 seconds.
Provider contracts run through the unmodified `npm run test:portable` runner.

The local before/after logs are retained under `/tmp/inertia-report-review/`
with prefix `audit-`; the tests and this report are durable repository evidence.
The before-control credential values are synthetic, not account credentials.

Verification caught and corrected two errors in the new test setup: its direct
harness callback now uses `onEvent` and asserts the captured terminal status;
its portable-suite annotation no longer duplicates the existing OpenCode
conformance-owner marker. The first complete suite had 9,917 passing tests and
one registration failure, plus seven passing child controls. That failed log is
preserved; the final full gate above passed independently after correction.

Native Windows, Linux, Intel macOS, packaged desktop scenarios, release signing,
notarization and live provider services were not newly exercised in this audit.
The coordinator owns exact-head hosted CI, merge and resulting-main validation.
No release, version, tag, asset, icon or unrelated branch changes are included.

## Follow-up verification

The initial CI failed one macOS lifecycle scenario, and GitHub review found the
short-password gap described above. Both are addressed by independently reviewed
source and deterministic controls. The earlier passing full/portable results
above apply to the initial published source; final follow-up results follow.

- Before fixes: three short-password cases failed/four passed; three goal-focus
  controls failed/thirteen existing checks passed.
- Focused provider, registration, goal-panel and focus neighbors: 108 passed on
  the first focus draft; final compact-focus verification is recorded below.
- Final compact focused cohort: 31 passed. Fresh build passed all unchanged budgets (core 2107.3/2107.4 KiB), and all four native runtime-recovery scenarios passed in 46.4s with one worker. Pre-integration quality/full/build passed 9,932 tests plus seven child controls, with 146 skips and 925 passing files (413.02s). The separate portable suite passed 1,627 tests across 114 files, with nine skips (152.86s).

After integrating main `26d80b8a`, all 44 focused checks passed. The complete final quality/full/build gate passed 9,939 tests plus seven child controls, with 146 skips and 925 passing files (416.52s). All bundle budgets remained unchanged and passed. On the freshly built integrated source, all four native runtime-recovery scenarios passed again in 44.6s with one worker and zero retries.

Changed files beyond the original audit: `ChatGoalControl.tsx`, its DOM tests,
`opencode-sdk-harness.ts`, its credential controls, and this evidence report.
All source changes were reviewed independently. Local native evidence is macOS
ARM64 only; exact-head hosted CI remains required before merge.

## Integration after PR #460

After PR #460 passed all six native platforms and current main was green, the
coordinator squash-merged it as `26d80b8aee023391516f770ba8a189e701c1ba4c`.
The audit branch ordinarily merged that main commit without conflicts as
`6f1ea0d43f76623d8c22944540b9c9863b53440c`. This adds only the already-reviewed
workflow command, its tests and its evidence document. All seven audit source/
test blobs and both workflow source/test blobs remain byte-identical to their
independently reviewed versions. The final delivery gate validates this combined
source; provider code and portable controls are unchanged from the portable
result above.
