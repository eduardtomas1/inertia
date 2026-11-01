# Phase 4 verification: managed delegation, durable parent wakes, observed native children — 2026-11-01

Recorded on Windows 11 x64 with Node 22.23.1 in
`D:\MORELIFE\inertia-wt-orchestrator-v2-p4` (branch `orchestrator-v2-p4`).
The package runs, focused tests, Electron scenario and captures below were
taken on the uncommitted tree over `112c4a46` ("Phase 3 polish staging"). The
work was then rebased onto `origin/orchestrator-v2` at
`630aa2cf51d4526b112fd44913886699c42186ca`, the deferred fidelity hooks were
wired, and the full gate ran on the rebased tree; see
[Rebase onto 630aa2cf, deferred hooks and full gate](#rebase-onto-630aa2cf-deferred-hooks-and-full-gate).
Line numbers in the T3 test mapping refer to the pre-rebase tree. T3 Code anchors refer to
`15fe2832727893cbdd2214383f9f971474849695`. The
[changed-files inventory](../pr-evidence/orchestrator-v2/changed-files.md)
lists every tracked change and untracked addition. What landed is summarised in
[implementation-progress.md](implementation-progress.md#phase-4-managed-delegation-durable-parent-wakes-observed-native-children--2026-11-01).

## Scope

- **Managed delegation.** `inertia_delegate_task` gives a task to a new managed
  chat that the calling chat owns and records a durable task. The task id is
  the approved `agent_thread_operations.id` that dispatched the child's first
  turn. `inertia_get_task_status`, `inertia_wait_for_task` and
  `inertia_cancel_task` read, wait for and cancel the caller's own tasks. An
  approved `inertia_send_message` to an owned child either attaches its turn to
  the unresolved task or starts a follow-up task.
- **Durable parent wakes.** Finished results are planned into a per-parent
  mailbox and delivered as one typed `queued_messages` row
  (`delegated_completion_json`). The row is ordered ahead of user and watcher
  entries and sits outside the three-message user cap. The delivery is steered
  into a running parent when every task in it is `always` and armed, no
  approval or question is pending, and the route supports active follow-ups.
  Otherwise it continues the parent after the current turn. The wake turn shows
  a completion card instead of a user bubble.
- **Observed native children.** Provider-managed subagents are a derived,
  read-only projection over `subagent_traces`. They are not conversations and
  carry no authority. The agents line of a turn opens the projection. An
  individual Stop is offered only where the existing exact-trace stop is
  supported.
- **Renderer.** The Delegated work panel and child breadcrumb, the completion
  card, the pinned Delegated results queue row, the Agent details view and the
  Settings switch for automatic wakes.

## Design decisions

The decisions of the design study (section 0 and the section 3.10
differences from T3), with the additions recorded by the Phase 4 fidelity
review and its fix packages F1 to F4.

| Topic | T3 at `15fe2832` | Inertia Phase 4 |
| --- | --- | --- |
| Child kind | Hidden app-owned subagent thread | A visible managed chat (existing `agent_managed_conversations`) plus a durable `delegated_tasks` record. |
| Authorization | Mode ceiling only; no per-call prompt | The existing explicit host approval on every managed mutation (create, follow-up send, cancel), Full Access included. Reads, waits, acknowledgements and the user's own commands need none. |
| Task identity | Parent-side execution node id | The approved operation id (64 hex). Retries use the tool-call identity plus an optional `clientRequestId` scoped to the source chat's provider backing, on create and on cancel. |
| Budgets | None | Existing managed-chat budgets: depth 2, 3 active children, 4 creates and 8 mutations per turn, 65,536 input characters. `inertia_delegate_task` counts as a create. |
| Task prompt | ≤120,000 characters | ≤32,768 characters (`MAX_MANAGED_PROMPT_CHARS`). |
| Title and role | Optional title with a prompt fallback; roles include `design` | Optional title of at most 120 characters; the fallback is the first line of the task clipped to 72 characters, else "Delegated task". Roles are implementation, research, review, design, test and general; a non-general role prefixes "Act as the <role> sub-agent for this task." |
| Mode ceilings | `runtime_mode_escalation_denied`, `interaction_mode_escalation_denied` | Typed `access_mode_escalation_denied` and `interaction_mode_escalation_denied`, checked before the approval and again after it. |
| Wake policy | `always` (async) or `settled_only` (wait) | `always`, `settled_only` or `never`, requested by the agent and shown in the approval ("delegated task · wakes this chat on result"). A send that starts a follow-up task says so in its approval. |
| Automatic-wakes setting | None | Persisted `app_state.delegation_automatic_wakes` (migration 112), on by default, in Settings › Chats › Delegated tasks. Turning it off disarms every armed, undelivered wake with reason `setting-off`: results stay pending (not dismissed), and tasks in a queued delivery are taken out of it and deferred. Tasks created while it is off are disarmed at creation, recovery at boot disarms with the same reason, and the approval says "result stays in the inbox; automatic continues are off". Steering requires the setting. A delivery the user sends with Continue with results still dispatches. Turning the setting on again does not re-arm a task; its own "Continue this chat when it finishes" toggle does. |
| Mailbox | Cohort per spawning run; one delivery in flight per run | Mailbox per parent conversation; one non-terminal delivery row per parent (unique partial index); generation counter; per-task delivery state. "N of M" counts this delivery's tasks against the source-turn cohort and uses one outcome verb with task labels. |
| Batch size | Unbounded | At most 16 tasks per delivery; the rest stay pending for the next generation. |
| Result | Raw latest assistant message | Fixed at the first published result: failure summary plus the terminal assistant message, neutralized, ≤8,000 bytes. The result turn excludes rolled-back, never-started and watcher-wake turns and is ordered by end time; `latest` is the latest terminal turn. A wake carries at most 16,000 bytes. |
| Wait | 10 min default, 60 min maximum | 5 min default, 30 min maximum; a timeout or a child request upgrades an armed `settled_only` task to `always`. |
| Child questions | `user_input` questions wake the parent | No parent wake for child questions; `needsAction` is reported in status, wait and the panel, scoped to the task's own active turn. Approvals are never routed. |
| Follow-up tasks | A new run from the parent, the user or a non-monitor notice creates one | Only an approved `inertia_send_message` creates or attaches a task. The user's own turns in the child chat never create tasks. A steer only attaches. |
| Follow-up work state | Only its tagged runs | Its tagged turns, and also held while the child chat has live native children or unresolved tasks of its own. |
| Parent Stop | Every cohort disposed; every child stopped | Every undelivered task of the conversation is dismissed and the queued delivery withdrawn. Only the exact child runs the stopped turn dispatched are cancelled; other children keep running (existing exact-target rule). Users can still send dismissed results with Continue with results. |
| Cancel | Thread stop of the whole child, also for a finished task | Stops only the exact active task turn and the task's own nested tasks (depth ≤3). Cancelling a task that already has a result disposes it and does not stop a later turn of the child. An armed usage-limit resume is cancelled through the scheduler, and a pending restart continuation of the child is dismissed. |
| Parent failure | Not a disposal; the queue starts once no run is active | A failed source turn disarms and disposes its own undelivered tasks. The queue releases only after a completed turn or an app-update interrupt, so deliveries from earlier turns wait for the user after any failure or crash interrupt. |
| Usage-limited parent | Queue held; tasks delivered after the resume | A failed source turn with a waiting or dispatching limit-reset plan keeps its tasks; they are disarmed only if the plan ends cancelled, blocked or missed without resuming. |
| Child holds | `delegatedTaskResultPending` forces `working` | A waiting limit-reset plan or restart continuation keeps the task `working`; settling either plan without a turn re-evaluates the task. |
| Manual send against a waiting delivery | Nothing moves ahead of an automatic entry | A manual send of a queued user entry, and a direct send to an idle parent, dispatch the waiting delivery first. |
| Native children | Real read-only child threads; Anthropic-provider-only stop | Derived observed child projection over `subagent_traces`; no conversation row and no authority. Stop only through the existing exact-trace stop on the active run and turn. |
| Workspace | Shared, or a worktree from HEAD | project, reuse-current or isolated through the shared creation service; no remote delegation. |

## Deferrals

- **Inherited runtime-mode step-down (design §5 Q6, upstream 65965f7ab8).**
  `inertia_delegate_task` uses the parent's inherited modes unchanged and
  validates explicit modes against the parent's ceilings. Step-down needs
  per-route offered access modes, which belong to the provider-registry work.
- **Child-question reactor (design §5 Q4).** Agents have no tool to answer a
  child's question until the persisted-questions and agent-tools phase, so a
  child question does not wake the parent.
- **Usage-limit refinements e496db3a5e and 63b0e3d82e.** Recovery phase.
  Phase 4 reads an armed limit-reset plan to keep a task `working`, holds a
  usage-limited parent's tasks, and cancels the plan on task cancel; it does
  not change how plans are armed.
- **`observedChildControls` removed.** The field was declared on
  `ConversationDetail` and stripped for Private Connect, but the server never
  populated it. The Agent details view reads controls through
  `observed-child.read`, so the field was a dead contract.
- **`recheckObservedChildStop` deleted.** It was exported but never called.
  `agent.subagent.stop` keeps its own recheck of the exact live trace on the
  active run and turn before the provider is asked
  (`tests/server/observed-child-stop.test.ts:51,72`).

## Electron scenario

`tests/e2e/delegation-wake.spec.ts` (isolated resource) runs five serial tests
on one Electron fixture. The fixture Codex app-server registers Inertia's
dynamic tools at `thread/start`, issues `item/tool/call` for
`inertia_delegate_task` (`mode: async`, `wake: always`), holds parent and child
turns on gate files, records every wake prompt, and refuses `turn/steer`. With
steering refused, a delivery for a running parent takes the queued path; the
steer path is covered by `tests/server/delegation-queue.test.ts:173` and
`tests/server/orchestration-delegation-delivery.test.ts:226`.

1. The parent's turn calls the tool; the approval shows
   "delegated task · wakes this chat on result" and is approved. A user
   message is queued with Tab while the parent turn is held. The child
   finishes, the steer is refused, and the Delegated results row is first in
   the queue ("1 of 2") without Send now. When the parent turn finishes, the
   wake runs before the user's message. The wake prompt's first line is the
   server wording for one task, `Delegated task "Audit changelog" finished`.
   Exactly one wake prompt and one completion card exist after a further 1.5
   seconds, and the panel shows the task as Delivered.
2. A second task finishes while the parent turn is held and its delivery is
   queued. Stop on the parent withdraws the row and dismisses the task: the
   panel shows Dismissed and no automatic continue, and no wake arrives within
   2 seconds. Continue with results sends it by hand ("Sent 1 result to this
   chat."), producing exactly one wake, and the task becomes Delivered.
3. A third task finishes while the parent turn is held and its delivery is
   queued. The fixture app restarts (graceful quit and relaunch). The parent
   turn ends interrupted, which holds the queue under the existing release
   rule. After the restart the result, the queued row and the panel note
   "Finished results are queued to continue this chat." remain, and no wake
   arrives within 3 seconds. "Send delegated results now" produces exactly one
   wake, and the task becomes Delivered.
4. Settings › Chats shows the "Continue chats automatically when delegated
   tasks finish" switch, on.
5. A turn whose fixture emits a Codex `collabAgentToolCall` (`spawnAgent`) and
   the child thread's turn events shows "1 agent finished"; Agent details opens
   the observed child with its lineage, status, task, result,
   "Provider-managed · read-only" and the Codex stop-unavailable reason.

Command: `npm run build:bundle`, then
`npx playwright test tests/e2e/delegation-wake.spec.ts --project isolated --timeout 180000`.

| Run | Result |
| --- | --- |
| Final run used for the captures | 5 passed in 1.4 minutes |
| Three earlier full runs after the product corrections below | 5 passed each (1.3, 1.2 and 1.4 minutes) |

Earlier runs failed for these reasons, in order: Electron did not reach its
ready state while the `D:` disk was saturated by other processes (twice, and
once more during a launch timeout); Approve once was rejected as "Invalid
command." (product correction 1); after Stop the panel showed Dismissed rather
than the spec's first expectation (spec corrected to the implemented
disposal); after the restart there was no control to send the held delivery
(product correction 3).

Build provenance for the final runs: `out/main/index.js` 10:13:20 SHA-256
`2d3657e48d754ea19f3aff3b2bb5c525cdc6c25a998f69dd075a2582c6adf7f7`;
`out/renderer/index.html` 10:13:48 SHA-256
`e4e72bfd1c409610e4c98d41393c136cd5302262d2c2c529c429d89b795197e9`.
No source file changed after that build; only the spec and documentation did.

## Product corrections made with the scenario

1. **Host-tool approvals could not be approved from the UI.** Inertia host-tool
   approvals carry the request id `inertia-host-tool:<uuid>`, but the
   `agent.approval.respond` command accepted only a UUID, so Approve once,
   Deny and Cancel turn on any host-tool approval failed with "Invalid
   command.". The command now also accepts exactly `inertia-host-tool:`
   followed by a lowercase UUID (`src/shared/contracts/client-command/agent.ts`;
   `tests/contracts.test.ts`, "accepts provider and host-tool approval
   identities and rejects other approval identities").
2. **A result dismissed by Stop could not be sent.** The server's user send
   includes dismissed results, but the panel offered Continue with results
   only for pending ones. The button now also appears when a finished task
   with a result was dismissed
   (`src/renderer/src/components/orchestration/delegation-panel.tsx`;
   `tests/renderer/delegation-panel.dom.test.tsx`, "offers Continue with
   results for a dismissed result and not for a delivered one").
3. **A held delivery had no send control.** After an interrupted or failed
   parent turn the queue is held, and the Delegated results row offered only
   Remove. When no turn is running, the row now offers Send now, labelled
   "Send delegated results now"; during a turn it still offers only Remove
   (`src/renderer/src/components/composer/RuntimeComposerQueuedActions.tsx`;
   `tests/renderer/runtime-composer-queue.dom.test.tsx`).

### Streaming detail refresh, fixed after the scenario

While a parent turn is streaming, a `conversation.detail.invalidated` reload
returned the in-progress assistant segment as a persisted commentary row while
the live stream still showed the same text, so the text appeared twice until
the turn settled. The reload path predates Phase 4, but delegation invalidates
the parent's detail whenever a child task changes, so it happened during
ordinary delegated work. The pinned-queue captures were taken before the fix
and still show it ("Delegated audit changelog." twice in the running turn).
The response timeline now lets the live segment take over the latest
persisted commentary of an active turn when the live text continues it
(`continuedLiveSegment` and `liveSegmentContinuation` in
`src/renderer/src/utils/response-timeline/execution.ts`, consumed by
`virtualization.ts`), so the segment renders once and is handed to its
persisted message when it closes
(`tests/renderer/streaming-detail-refresh.dom.test.tsx`, 6 tests). The fix
added 530 bytes to the core cap.

## Focused tests

`npx vitest run tests/server/orchestration-delegation-*.test.ts tests/server/delegated-tasks-migration.test.ts tests/server/agent-thread-delegation.test.ts tests/server/delegation-*.test.ts tests/server/observed-child-*.test.ts tests/renderer/delegation-*.dom.test.tsx tests/renderer/delegated-completion-card.dom.test.tsx tests/renderer/observed-child-view.dom.test.tsx tests/renderer/delegation-automatic-wakes-settings.dom.test.tsx`

**132 passed, 0 failed, 17 files** (17.0 seconds; confirmed by a second run
with the JSON reporter). An earlier run of the same command while the `D:`
disk was saturated failed 11 of the 12 Delegated work panel tests because the
lazily loaded panel did not appear within the one-second query timeout; the
panel file passed 12 of 12 on its own and in both later runs.

| File | Tests |
| --- | ---: |
| `tests/server/agent-thread-delegation.test.ts` | 17 |
| `tests/server/orchestration-delegation-core.test.ts` | 12 |
| `tests/server/orchestration-delegation-delivery.test.ts` | 12 |
| `tests/server/orchestration-delegation-recovery.test.ts` | 10 |
| `tests/server/observed-child-projection.test.ts` | 10 |
| `tests/server/delegation-cancel.test.ts` | 9 |
| `tests/server/delegation-holds.test.ts` | 9 |
| `tests/server/delegation-queue.test.ts` | 8 |
| `tests/server/delegation-wait.test.ts` | 5 |
| `tests/server/delegated-tasks-migration.test.ts` | 3 |
| `tests/server/delegation-boot-order.test.ts` | 3 |
| `tests/server/delegation-command-policy.test.ts` | 2 |
| `tests/server/observed-child-stop.test.ts` | 2 |
| `tests/renderer/delegation-panel.dom.test.tsx` | 12 |
| `tests/renderer/delegated-completion-card.dom.test.tsx` | 7 |
| `tests/renderer/observed-child-view.dom.test.tsx` | 6 |
| `tests/renderer/delegation-automatic-wakes-settings.dom.test.tsx` | 5 |

Also run for the corrections: `tests/contracts.test.ts` 31 passed;
`tests/renderer/runtime-composer-queue.dom.test.tsx` 24 passed;
`npm run typecheck` (all five TypeScript projects) passed; `oxlint` with the
standard rules passed on the changed spec, tests and sources.

## T3 test mapping

Updated from the fidelity review's section 17 for the F1 to F4 tests. Line
numbers point at the test declarations in this worktree.

| T3 test | Inertia equivalent |
| --- | --- |
| `DelegatedCompletionDelivery.test.ts:313` interrupting a wake disposes both cohorts | `orchestration-delegation-delivery.test.ts:208`; `delegation-queue.test.ts:146`; Electron test 2 |
| `:459` acceptance batches pending siblings without acknowledging | `orchestration-delegation-delivery.test.ts:27` (settle path), `:226` (steer); `delegation-queue.test.ts:173` |
| `:552`, `:2964` `settled_only` sibling once its spawning run ended | `orchestration-delegation-delivery.test.ts:125` (hold half only) |
| `:643` text and metadata from the same live cohort | `orchestration-delegation-delivery.test.ts:27` |
| `:694` counts already delivered siblings | `orchestration-delegation-delivery.test.ts:27` ("2 of 3 delegated tasks finished: Beta, Gamma"), `:261`, `:278`; `delegated-completion-card.dom.test.tsx:113`, `:155` |
| `:745` oversized UTF-8 inline/fallback | `orchestration-delegation-delivery.test.ts:249` |
| `:831` no re-offer after a wake-policy upgrade once delivered | none |
| `:894` repeated ack/dispose are no-ops | none (implicit in the projector) |
| `:1046` run settled between ack/accept read and commit | none; `delegation-holds.test.ts:62`, `:85` cover the neighbouring gap between a child turn's end and finalization |
| `:1489`, `:1613`, `:2051` | none (no Inertia analogue) |
| `:1753` follow-up delivered independently of the original | `orchestration-delegation-core.test.ts:99` (rule only; no delivery) |
| `:2217` restart queues a result | `orchestration-delegation-recovery.test.ts:38`, `:74`; `delegation-boot-order.test.ts:26`, `:55`; Electron test 3 |
| `:2309`, `:2468` restart continuation hold or decline | `orchestration-delegation-core.test.ts:136` (hold); `delegation-holds.test.ts:151` (decline finalizes) |
| `:2572` monitor cut → interrupted | none |
| `:2621` re-offer a cut delivery | `orchestration-delegation-recovery.test.ts:92` |
| `:2711`, `:2780` held wakes behind a cancelled or failed child | none |
| `:2898` unpublished failure after a disposed delivery | `orchestration-delegation-recovery.test.ts:38` (partial) |
| `:3030` finalize after background or nested work | `orchestration-delegation-core.test.ts:136`, `:190` |
| `TaskCancelUsageLimit.integration.test.ts:53` (3 cases) | `delegation-cancel.test.ts:90` (after the limit), `:112` (as the limit lands), `:145` (never cancelled → resumes) |
| `TaskCancelNativeSubagent.integration.test.ts:54` | `delegation-cancel.test.ts:219` |
| `SubagentProjection.test.ts:84` child awake while the parent is snoozed | none |
| `:123` no settlement-protection inheritance | `observed-child-projection.test.ts:504` (native only; none for managed chats) |
| `:212` run that ended last | `orchestration-delegation-core.test.ts:301` |
| `:233` nested work and monitor acks | `orchestration-delegation-core.test.ts:190` (no monitor analogue) |
| `:330` provider failure over progress | `orchestration-delegation-core.test.ts:65` (partial) |
| `QueuedRunOrder.test.ts:6` | `delegation-queue.test.ts:46`; Electron test 1 |
| `ProviderRuntimeRecoveryService.test.ts:1307` | `orchestration-delegation-recovery.test.ts:164` |
| `runtimeLayer.test.ts:6440` held delegated run does not block snooze | none |
| `RemoteDelegatedTask.test.ts` (all) | none; deliberate (no remote delegation) |
| — | Inertia-only: `delegated-tasks-migration.test.ts`; `agent-thread-delegation.test.ts` (all, including the typed escalation codes at `:85`, the post-approval recheck at `:168`, the role and title fallback at `:197` and the follow-up send approval at `:300`); `delegation-wait.test.ts` (all); `delegation-boot-order.test.ts`; `delegation-command-policy.test.ts`; `delegation-holds.test.ts:99`, `:177`, `:210`, `:230`, `:259`; `delegation-queue.test.ts:79`, `:98`, `:120`; `orchestration-delegation-core.test.ts:264`, `:333`, `:370`; `observed-child-stop.test.ts`; the renderer DOM tests; the Electron scenario |

## Renderer bundle

From [renderer-bundle.json](../pr-evidence/orchestrator-v2/renderer-bundle.json).
Package D raised four budgets, each to its measurement plus the branch
headroom; F4 raised core again; the package E corrections fit within the
limits. No route closure or core inclusion or exclusion changed.

| Budget | Previous limit | Package D | F4 | Package E | Rebased final | Current limit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Main workbench first load | 902,865 | 904,996 | 904,815 | 904,815 | 905,416 | 905,508 |
| Detached chat first load | 796,629 | 798,741 | 798,560 | 798,560 | 799,182 | 799,253 |
| Deferred composer queue | 13,302 | 13,599 | 13,599 | 13,650 | 13,650 | 13,855 |
| Core JavaScript | 2,485,379 | 2,517,433 | 2,519,982 | 2,520,075 | 2,521,262 | 2,521,518 |
| Transcript (unchanged limit) | 649,783 | 628,412 | 630,369 | 630,369 | 630,555 | 649,783 |
| Settings (unchanged limit) | 81,511 | — | 79,156 | 79,156 | 79,156 | 81,511 |
| Entry CSS (unchanged limit) | 243,221 | 243,221 | 243,221 | 243,221 | 243,221 | 243,221 |

The streaming detail-refresh fix raised the core cap by 530 bytes, from
2,520,238 to 2,520,768. The rebase conflicted on the main workbench, detached
chat and core caps; each took the larger side and was re-measured. On the
rebased tree only core failed (2,521,262 against 2,520,768) and was re-capped
to its measurement plus 256 (2,521,518); the startup routes keep 92 and 71
bytes of headroom. The accounting is the `phase4Final` block of
[renderer-bundle.json](../pr-evidence/orchestrator-v2/renderer-bundle.json).

## Captures

All sixteen captures come from the final Electron run above, at 1440 × 960.
They are in `docs/pr-evidence/orchestrator-v2/screenshots/`.

| State | Dark | Light |
| --- | --- | --- |
| Delegation approval | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-approval-dark.png) | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-approval-light.png) |
| Queue with the pinned Delegated results row | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-queue-pinned-dark.png) | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-queue-pinned-light.png) |
| Completion card, expanded | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-completion-card-dark.png) | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-completion-card-light.png) |
| Delegated work panel with a running and a delivered task | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-panel-running-delivered-dark.png) | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-panel-running-delivered-light.png) |
| Result dismissed by Stop, with Continue with results | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-stop-dismissed-dark.png) | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-stop-dismissed-light.png) |
| Delivery held after a restart, with Send now | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-restart-held-dark.png) | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-restart-held-light.png) |
| Settings switch for automatic wakes | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-settings-toggle-dark.png) | [Capture](../pr-evidence/orchestrator-v2/screenshots/delegation-settings-toggle-light.png) |
| Observed child panel from the agents line | [Capture](../pr-evidence/orchestrator-v2/screenshots/observed-child-panel-dark.png) | [Capture](../pr-evidence/orchestrator-v2/screenshots/observed-child-panel-light.png) |

## Not exercised

- **Real providers.** Every run used fixture provider processes. No live
  Codex, Anthropic-provider, Cursor, Kimi, OpenCode, Antigravity or Pi account
  delegated, steered a wake or emitted native subagents. Cross-provider
  delegation is covered only by server tests with fixtures.
- **Resumed native sessions (R1).** Codex registers dynamic tools only at
  `thread/start`. The orchestration pack revision is now 4, so the new tools
  appear on the next fresh native session; a resumed session keeps its old
  tool surface and gets an unknown-tool failure. Migration 111 does not drop
  sessions. No real resumed session was run.
- **Provider tool-call timeouts for long waits (R3).** The wait bounds are a
  fixed 5-minute default and 30-minute maximum. No per-provider host-tool
  timeout was measured, and no real provider held a blocking host-tool call
  for minutes.
- **Steering into a running parent in Electron.** The fixture refuses
  `turn/steer`; steering is covered by server tests only.
- **Toggling automatic wakes off in Electron.** The scenario captures the
  switch on; the off state is covered by `delegation-holds.test.ts:230`,
  `:259`, `orchestration-delegation-delivery.test.ts:226`,
  `agent-thread-delegation.test.ts:133` and the settings DOM tests.
- **Platforms and packaging.** Windows 11 x64 only. macOS, Linux and packaged
  builds were not run.
- **Full gates before the rebase.** `npm run check` and
  `npm run test:portable` were not run on the pre-rebase tree; the full gate
  ran on the rebased tree (below).
- **Capture effects in the desktop app.** The capture executor, its wake and
  the start barrier are covered by server tests; no Electron scenario asserts
  on a capture effect or holds a start behind a slow capture.

## Rebase onto 630aa2cf, deferred hooks and full gate

The Phase 4 tree was committed as one local staging commit and replayed onto
`origin/orchestrator-v2` at `630aa2cf` (`git rebase --onto
origin/orchestrator-v2 112c4a46`; `112c4a46` and `907ad3d2` share a tree).
Four files conflicted and each kept both sides: the queued-message runtime
(upstream checkout-restore fence first, then Phase 4's delegated content),
the bundle caps (the larger side, re-measured), the bundle evidence blocks and
the progress log. `npm run typecheck` passed before the hook work. The
resolutions are tabled in
[implementation-progress.md](implementation-progress.md#rebase-onto-630aa2cf-and-deferred-hooks--2026-11-01).

Hook results:

| Hook | Result |
| --- | --- |
| Effect wake | The event store calls `onEffectsCommitted` after a non-replayed commit with effects; the repository passes `effects.notifyAvailable()`. |
| Shutdown and executor | `orchestrationEffects` stops in `quiesceRuntimeWork` after the lanes close and before the store closes. The `checkpoint.capture-requested` executor calls `turnGitArtifacts.finalize` and is registered when post-ready artifact reconciliation starts (`src/server/runtime/checkpoint-capture-executor.ts`). `index.ts` is 1,175 lines. |
| Capture emission and start barrier | The terminal `run.status-changed` commit carries one capture per run and turn, except for read-only watcher chats. The start and native-control claims pass over capture effects; with an executing runtime the start waits for the thread's earlier captures, bounded by 60 seconds, instead of refusing. The direct finalization and the boot catch-up are kept: the controller test "atomically queues the visible request, captures immutable config, and owns all completion associations" expects the direct hook, the direct path also orders paired Duo pre-captures, and the boot catch-up covers turns that have no capture effect. Both paths share one finalization per turn. |
| Retrieval attestation | Portable history receives `hostToolBridgeAttested`; `inertia_request_context` is named only on attested routes. |
| Files decision | The aggregate "Files changed earlier in this chat" block is removed from provider handoffs; file changes travel as attributed per-turn `file-change` items, rolled-back turns excluded. Chat-reference packets keep the block. |

New and changed tests: `tests/server/orchestration-v2-outbox.test.ts`
(capture committed with the terminal event and finalized once; a pending
capture runs once after restart; the next start waits for the capture),
`tests/server/orchestration-backings.test.ts` (retrieval named only when
attested), `tests/server/orchestration-history-rollback.test.ts`,
`tests/server/provider-handoff-continuation.test.ts`,
`tests/server/conversation-context-v3.test.ts` and
`tests/server/session-continuity.test.ts`.

Fixes found by the full gate:

- `src/server/orchestration-v2/delegation-reads.ts` compared task creation
  times with `localeCompare` and no locale; it now pins `"en"`
  (`tests/locale-collation.test.ts`).
- The hot query plan snapshot gains the four delegation reads of the history
  page (`tests/server/__snapshots__/runtime-query-plans.test.ts.snap`, 30
  added lines, nothing removed).
- `tests/server/session-continuity.test.ts` expected the retrieval tool on
  routes its fixture never attests (`providerInfo: () => []`); it now expects
  the unattested wording, as the retrieval attestation requires.
- `tests/server/turn-interaction-commands.test.ts` and
  `tests/server/compact-and-send-command.test.ts` stub the store without
  `conversationWork`, which upstream `7c27c05d` made admission read
  (`restoreBlocksConversation`), so 61 tests failed admission with a
  `TypeError` on the rebased tree; the code and both tests are identical to
  `630aa2cf`. The stubs now return `false` for it.

Full gate on the rebased tree, one job at a time, on Windows 11 x64 with
Node 22.23.1:

| Command | Result |
| --- | --- |
| `npm run check:quality` | Passed: workflow concurrency, 112 migration lineage entries, architecture (1,876 source files, 7,848 internal edges, 4 derived compatibility facades), color themes, both linters and all five TypeScript projects. It passed again after the gate fixes below. |
| `npm run test:portable` | 246 files: 243 passed, 2 failed, 1 skipped; 3,961 tests: 3,878 passed, 3 failed, 80 skipped (2,544 s). Two `app-update-candidate-viability-worker` tests failed creating symlinks (EPERM); `conversation-provider-gate` timed out at 15 s and passed 7 of 7 alone (2.2 s). |
| `npm test -- --maxWorkers=4` | 1,488 files: 1,436 passed, 31 failed, 21 skipped; 18,354 tests: 17,756 passed, 117 failed, 481 skipped (2,040 s). Classified below. |
| `npm run build:bundle` | Passed after the core re-cap: core 2,521,262 of 2,521,518 bytes, main workbench first load 905,416 of 905,508, detached chat first load 799,182 of 799,253, transcript 630,555 of 649,783. |
| `npx playwright test tests/e2e/delegation-wake.spec.ts tests/e2e/history-rollback-merge-back.spec.ts tests/e2e/session-continuity.spec.ts --project isolated --timeout 180000` | First run: 3 failed and 4 did not run because the Electron fixture never reached its ready state (`ERR_FAILED (-2) loading 'inertia://bundle/index.html'`, "GPU state invalid"), before any scenario step. Rerun on the same build: 7 passed in 1.2 minutes (delegation wake 5, history rollback and merge-back 1, session continuity 1). |

The 117 unit failures:

| Class | Files | Tests | Outcome |
| --- | ---: | ---: | --- |
| EPERM creating symlinks (no symlink privilege on this machine): `app-update-candidate-viability-worker`, `app-update-capability`, `attachment-import-file`, `attachment-selection-import`, `completion-sound-main`, `database-export`, `database-recovery`, `git-diff-review`, `launch-request`, `private-connect/host-migration`, `runtime-owned-process-linux`, `secure-file-worker`, `snapshot-queue`, `snapshot-queue-links`, `windows-runtime-job`, `workspace` | 16 | 19 | Machine noise |
| pdfjs worker "Denied ID" through the `node_modules` junction: `document-attachment-preview`, `attachment-image-zoom`, `attachment-preview-dialog`, `sent-message-attachments`, `environment-summary` (DOM) | 5 | 22 | Machine noise; same failure alone |
| `cursor-sdk-packaging` "resolves the development SDK from the checkout": the SDK resolves through the `node_modules` junction to another worktree | 1 | 1 | Machine noise; same failure alone |
| Timeouts under load: `legacy-backfill-compatibility`, `document-attachment-context`, `settings-composite-updates`, `settings-registry` (DOM) | 4 | 5 | Passed alone (11, 27, 17 and 26 tests) |
| Fixed above: `turn-interaction-commands` (53), `compact-and-send-command` (8), `session-continuity` (7), `locale-collation` (1), `runtime-query-plans` (1) | 5 | 70 | Passed alone after the fixes (75, 36, 45, 2 and 7 tests) |

Focused runs during the hook work: `orchestration-v2-outbox` and
`orchestration-backings` 25 of 25; the rollback, handoff, context, outbox,
native fork, portable history, artifact, post-commit settlement, rollback
restore and request-context files 200 of 206 before the context test update
(5 `conversation-context-v3` expectations and the Git timeout below), then
`conversation-context-v3` 17 of 17 after it. `turn-git-artifacts`
"compares two turn-owned post snapshots" timed out at 15 s twice under load
and passed alone with a longer timeout (about 16 s of Git work).

Not exercised by these runs: real providers, macOS, Linux and packaged builds;
the effect executor in a running desktop app (the Electron scenarios do not
assert on capture effects), and a start actually held by a slow capture in
Electron.
