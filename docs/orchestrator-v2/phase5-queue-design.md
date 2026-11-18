# Phase 5 design: durable queues

Status: design for review, 2026-11-09; decisions re-answered 2026-11-14 and
re-checked on 2026-11-17.
Nothing in this document is implemented. It reconstructs the Phase 5 design
from the code on `orchestrator-v2` at `652ba6c18`. Section 1.2 describes T3
Code at the audited pin `15fe2832`; sections 2 to 5 follow T3 Code's current
orchestrator at `b05c505b` (2026-11-14), compared commit by commit in
[t3code-delta-2026-11-14.md](t3code-delta-2026-11-14.md). The decisions that
T3 changed between `b05c505b` and `b387e3a17` (2026-11-17) are updated in
place and marked "(updated 2026-11-17)"; the commits are in
[t3code-delta-2026-11-17.md](t3code-delta-2026-11-17.md). Anchors marked `O:`
and `CP:` in those updates are against `b387e3a17`.

Rule for every decision: T3 Code's current orchestrator is the reference.
Inertia keeps a deliberate difference only where an invariant in `AGENTS.md`
forces it, or where it is an explicitly recorded architecture choice. Section
4 marks each decision accordingly, and section 5 lists the differences kept
and the ones closed.

Phase 5 covers this checklist item of
[implementation-plan.md](implementation-plan.md): "Durable message/configuration
queues, edits/cancellation/reorder, native steering or explicit
interrupt/restart fallback, automatic-result priority, delivery attribution and
retry identities." It also takes the deferred L1 item (per-item queue
selection, [implementation-progress.md](implementation-progress.md) line 756)
and the two upstream items the delta assigned to the queue phase
([t3code-delta-2026-10-31.md](t3code-delta-2026-10-31.md) rows `54d0a161bb`
and `afb8619e1d`).

Anchors use `file:line` against the branch for Inertia. In section 1.2, T3
anchors are against the pin (`apps/server/src/orchestration-v2/` is shortened
to `o2/`); from section 2 on they are against `b05c505b`, with the
abbreviations given at the start of section 2.

## 1. Current state

### 1.1 Inertia

**Storage.** The queue is the `queued_messages` table from
`PersistRuntimeQueuedMessages`
(`src/server/persistence/migrations/queued-messages.ts:6-20`): an
autoincrement `sequence`, the client-supplied `id`, `content` (at most 20,000
characters), `attachments_json`, an `intent_digest`, a `route_identity`,
`state` in `waiting | dispatching | blocked | accepted | cancelled`, and the
`turn_id` and `user_message_id` it became. Later migrations add
`watcher_note_json` (`watcher-links.ts:163`) and `delegated_completion_json`
with a unique partial index that allows one active delegated row per chat
(`delegated-tasks.ts:78-85`). Accepted and cancelled rows are wiped of content
and pruned to the latest 50 per chat
(`src/server/persistence/queued-message-repository.ts:48-53`,
`turn-ledger-repository.ts:313-321`). The queue is **not** a V2 entity: no
`orchestration_v2_events` row describes an item, an edit or a dispatch.

**Contract.** `src/shared/queued-messages.ts:7` caps user entries at
`MAX_QUEUED_MESSAGES = 3`; a result carries at most three user entries plus one
delegated delivery (`:22-29`). An entry has at most one automatic attribution
(`:21`). The client commands are `message.queue.get | enqueue | remove | send
| stop-and-send` (`src/shared/contracts/client-command/agent.ts:33-41`). There
is no edit, reorder or resume command.

**Ordering.** `list()` orders delegated results first, then user entries, then
watcher notes, each by `sequence`
(`queued-message-repository.ts:71-73`). The user documentation promises this:
"Your own queued messages always go before watcher notes"
(`docs/user/watcher.md:84`). An automatic watcher note may not take the last
user slot (`queued-message-runtime.ts:318`).

**Route identity instead of per-item selection.** Each row stores
`queuedRouteIdentity` = project, worktree, provider, model selection, model,
effort, interaction mode and access mode
(`queued-message-repository.ts:34-38`). If the chat's identity differs at
dispatch, the head is blocked with "This chat's model, access or workspace
changed. Remove and queue the message again." (`queued-message-runtime.ts:140-144`,
`:382-386`). Delegated rows always match (`queued-message-repository.ts:135`).
Configuration changes on a running chat are refused outright
(`src/server/runtime/commands/conversation-commands.ts:548-586`; projector
refusal `src/server/orchestration-v2/projector.ts:53-54`).

**Dispatch.** `createQueuedMessageRuntime`
(`src/server/runtime/queued-message-runtime.ts:59-649`) schedules one loop per
chat (`:193-216`). `dispatch` (`:110-182`) waits for provider cleanup, skips
during compaction, pending V2 cleanup, the update hold and checkout restore,
and then releases the queue only if the latest turn completed or was
interrupted by an app update (`releasesQueue`, `:33-35`, applied at `:139`).
It claims the head (`waiting|blocked → dispatching`, repository `:137-140`) and
replays it through the ordinary `message.send` handler with
`requestId: first.id` (`:162-172`). The admitting transaction flips the row to
`accepted` with the turn and message ids
(`turn-ledger-repository.ts:313-321`; steers:
`transcript-repository.ts:279-286`). Transient failures release the claim;
anything else blocks the row with the public error (`:175-178`). A blocked
watcher note does not hold back later entries (`:114-116`).

**Who dispatches.** Since G5 every internal dispatcher commits under the actor
`runtime` with an origin-prefixed command id: `queue:`, `limit-reset:`,
`restart-continuation:`, `watcher:` or `delegation:` followed by the request id
(`src/server/runtime/commands/message-send-support.ts:115-130`). For the queue
the request id is the entry id, so the command id is `queue:<entry id>` for
every dispatch attempt of that entry.

**G5 receipts.** Queue edits run through `store.orchestration.authority.begin`
under the `human` actor (`queued-message-runtime.ts:471-474`). `enqueue` commits
its receipt in the same transaction as the row (`:487-494`); `remove` cancels
inside the intake section (`:529-541`); `send` commits a receipt-only result
(`:543-545`); `stop-and-send` enqueues, records its receipt, then stops with
`<request id>:stop` and the expected turn (`:349-372`). Every commit is
`events: []`: G5 made the edits ordered and replayable but did not make the
queue an event-sourced entity.

**Steering from the queue.** "Send now" during a turn steers only the first
user entry (`sendDuringTurn`, `:374-448`) through `turns.steer`, not through
G5's `provider.steer` effect; unconfirmed delivery blocks the entry
(`:424-428`, `:434-441`). Which providers can steer is decided by a static
list, `STEERABLE_HARNESS_IDS = codex-app-server, claude-agent-sdk,
opencode-sdk` (`src/shared/follow-up-steer.ts:1-9`), combined with the
manifest capability (`src/server/provider/run-coordinator.ts:909-916`).

**Delegated delivery row (Phase 4).** The delegation planner commits V2
`delegation.*` events and writes the queue row as their compatibility
projection in the same transaction
(`src/server/orchestration-v2/delegation-delivery-planner.ts:150-180`). The row
sits outside the user cap, is ordered first, cannot be sent during a turn
(`queued-message-runtime.ts:376-378`), is steered automatically only when every
task is armed and steerable (`steerDelegated`, `:551-587`), and a direct send
to an idle parent with a waiting delivery queues the user message behind it
(`queueBehindDelivery`, `:589-604`).

**Watcher, limit reset, restart continuation.** Watcher notes start the next
turn when the main chat is idle and nothing non-blocked waits, else they are
queued (`src/server/runtime/watcher/watcher-delivery.ts:325-349`). Limit-reset
plans and restart continuations are separate durable plans with their own
`route_identity` checks (`src/server/usage/limit-reset-scheduler.ts:68-77`,
`:96-112`); a restart continuation is not planned, and an existing plan goes
stale, when the chat has queued entries
(`src/server/runtime/restart-continuation-scheduler.ts:87`, `:109`). A queued
message sent after an app-update interrupt continues that turn
(`tests/server/queued-message-runtime.test.ts:702`).

**Crash behavior.** At boot `reconcile()` returns `dispatching` rows without a
turn to `waiting` (`queued-message-repository.ts:159-161`), delegation recovery
runs, then every chat with waiting rows is scheduled
(`queued-message-runtime.ts:636-647`; boot order `src/server/index.ts:724`).
The "Send now" retry that was pressed during compaction lives only in an
in-memory map (`manualRetries`, `queued-message-runtime.ts:68`, `:93-96`,
`:118-121`) and is lost on restart.

**Renderer.** `RuntimeComposerQueuedActions`
(`src/renderer/src/components/composer/RuntimeComposerQueuedActions.tsx`) polls
`message.queue.get` every 10 seconds while a turn runs or the queue is not
empty (`:76-78`) and renders **only the head** with Send now and Remove
(`:83-111`). Enqueue keeps a renderer-local intent journal of at most three
pending ids in `localStorage` (`runtimeQueueClient.ts:11-33`) so a lost
acknowledgement can be checked with `message.queue.get` (`:49-72`).

**The old local queue.** Before the durable queue, queued prompts lived in
`localStorage` (`inertia:queued-prompts:v2:<chat>` with a legacy
unversioned key, `composerQueuedPrompts.ts:19-25`, `:40-42`, `:205`). The
legacy component still renders next to the runtime queue with automatic
sending disabled: "Older local drafts retain their explicit retry control; an
unknown old delivery must never be silently re-admitted as a new runtime
intent" (`ComposerQueuedActions.tsx:270-282`). New drafts fall back to it only
when no runtime runner is present (`queueComposerDraft.ts:5-13`); the main and
split scenes always supply a runner
(`workspace-scene/createWorkspaceSceneModel.ts:164-170`,
`hooks/useSplitWorkspaceScene.ts:70`, `:395`). The user guide says "Older
local queues remain available for manual review"
(`docs/user/chats-and-agents.md:14`).

**Private Connect.** A Collaborate device's prompt is admitted directly as a
turn and refused while the chat is busy: "This conversation already has an
active agent task." (`src/server/private-connect/prompt-admission.ts:45-50`,
called from `runtime-gateway.ts:488-503`). Devices cannot see or change the
queue, and the prompt path does not use the queue or the G5 command authority.

### 1.2 T3 Code

**A queued message is a run.** `OrchestrationV2RunStatus` includes `queued`
(`packages/contracts/src/orchestrationV2.ts:585-596`), and a run carries
`queuePosition` and `queueHeld` next to its own `modelSelection` and
`providerInstanceId` (`:671-700`). Enqueue (`message.dispatch` with
`queue_after_active`) creates the run, its first attempt, its root node and
the user message at once, numbered `nextRunOrdinal` and placed at the end of
the queue (`o2/Orchestrator.ts:5788-5900`). The capability gate is
`supportsQueuedMessages` (`orchestrationV2.ts:288`;
`o2/CommandPolicy.ts:246-255`).

**Commands.** `queued-run.start | reorder | cancel | edit`,
`queued-message.promote-to-steer` and `queue.resume`
(`orchestrationV2.ts:3209-3249`); `message.dispatch` takes `dispatchMode`
`steer_active | restart_active | queue_after_active | start_immediately |
defer_start` and an optional `deliveryIntent` `auto | steer | restart`
(`:3122-3161`).

**Order and automatic priority.** `queuedRunsInDeliveryOrder` puts delegated
completion runs first, then sorts by `queuePosition ?? ordinal`
(`o2/QueuedRunOrder.ts:12-31`; test `QueuedRunOrder.test.ts:6`). Monitor
notifications are not prioritised; they keep their queue position. Reorder
refuses to move an automatic delivery or a notification and refuses to place
anything ahead of an automatic delivery (`o2/Orchestrator.ts:9452-9537`).
Edit refuses automatic deliveries, notifications and guest messages, and
replaces attachments only when given (`:9643-9720`). Cancel of a delegated
delivery disposes the cohort (`:9539-9641`). There is **no cap** on queued
runs; the agent tool pages the list (`apps/server/src/mcp/toolkits/thread/tools.ts:83-86`).

**Hold.** Stop holds every queued run (`queueHeld: true`) and cancels buffered
provider wakes (`o2/Orchestrator.ts:10655-10690`; docs
`docs/orchestration-v2/feature-lifecycles.md:254-256`). A provider failure on
the same instance, a disabled instance or a missing worktree holds the queue
(`o2/Orchestrator.ts:1586-1622`), as does a usage limit on the item's provider
(`:785-800`, `:1573`). A user send from a client releases held runs; server
continuations and scheduled tasks do not (`:5735-5767`). `queue.resume` and
`queued-run.start` release the hold and start a run; a replay of either
re-kicks the queue (`:13090-13168`, `:13295-13301`). Recovery holds the queue
of a recovered thread (`o2/ProviderRuntimeRecoveryService.ts:322-357`) and boot
starts unheld queues (`o2/Orchestrator.ts:2335-2345`).

**Start and renumbering.** `startNextQueuedRun` takes the next unheld run or
the selected one, resolves its model selection (delegated completions and
monitor notes follow the thread's current selection,
`o2/Orchestrator.ts:774-783`), plans a provider switch when the selection
differs (`:1720-1760`), and **renumbers** the run to `max + 1` when any run
started after it was queued (`:1622-1634`); ordinals may therefore skip values
(`:442-445`). The start command id is `command:system:start-queued:<run id>`
(`:1635`).

**Steering and the restart fallback.** `resolveDeliveryIntent` steers when the
session supports active steering, queues when it supports queued messages, and
otherwise restarts (`o2/CommandPolicy.ts:142-180`); a provider that can do
neither queues (`:95-115`). Restart is the same run with a new attempt of
reason `steering_restart` (`o2/Orchestrator.ts:5072-5096`), forced when a
selection must apply now (`:4794-4806`). Promote-to-steer cancels the queued
run and steers its message into the active run (`:9240-9450`); a `/goal`
command instead goes to position 1 and stops the run
(`stopRunForQueuedCommand`, `:11591-11625`).

**Clients.** Web shows three rows collapsed, with edit, remove and send (steer
while running, start while stopped) and a keyboard shortcut for "send first
queued" (`apps/web/src/components/chat/QueuedRunsControl.tsx:56`, `:99-101`,
`:167-185`). Mobile offers steer, edit, remove and resume
(`apps/mobile/src/features/threads/ThreadQueueControl.tsx:135-137`). No client
reorders; only the agent tool does
(`apps/server/src/mcp/toolkits/thread/handlers.ts:306`).

**Upstream after the pin** (`git log 15fe2832..origin/main`):

| Commit | Change | Relevance |
| --- | --- | --- |
| `a732caa7d` | Promote-to-steer uses the queued run's `modelSelection`, not the thread's | Adopt: a steered item keeps its own selection |
| `5731c0222` | Queued delegated completions follow the thread's newer selection | Adopt: automatic items follow the current selection |
| `737afe24b` | Recovery returns a never-started user run to the held queue; start effect ids gain a per-attempt suffix | Adopt both: requeue on restart and per-dispatch identities |
| `6049196c5` | A queued provider switch no longer ends background work | Carry into the per-item switch path |
| `cbb0417df` | Resume continues a usage-limited thread before its queue | Already Inertia's behavior (queue stays held after a failed turn) |
| `7f17f5153` | Idle compaction still runs after a queued message is removed or steered | Check Inertia's compaction trigger in package 2 |
| `bfd37b774`, `ceed427d7` | Edit during Compact and send; removing an attachment counts as an edit | Renderer acceptance cases |

**At `b05c505b`.** The table above was written against `origin/main` on
2026-11-09. The full range to `b05c505b` (releases v0.1.7 to v0.1.9 plus
unreleased `main`) is in
[t3code-delta-2026-11-14.md](t3code-delta-2026-11-14.md), section B. The
changes that alter this design are: stop-and-send on providers without
interrupt-restart (`631ea1b6d`) and its edge rules (`f12bb6229`), deferred
steer (`b20bbc595`), declined-steer placement (`2248ca8db`), queue-tail model
inheritance (`4168c14c7`), per-provider usage-limit holds (`8d236998d`),
held messages after failed workspace setup (`4225c9dfa`), native Resume
(`9e19b7f7e`) and the steering flags for attachments and compaction
(`55e253856`, `b3f5d5270`). Web now shows two rows and "Show all" once more
than three items wait (`QueuedRunsControl.tsx:57`, `:238-239`); mobile has a
"Queue paused" banner with Resume (`ThreadQueueControl.tsx:219-245`). The
anchors above for `QueuedRunsControl.tsx:56`, `:99-101`, `:167-185`,
`ThreadQueueControl.tsx:135-137` and `handlers.ts:306` are now `:57`,
`:100-102`, `:171-192`, `:137-139` and `:321`.

## 2. Target model

Sections 2 to 4 follow T3 Code at `b05c505b` (2026-11-14). T3 anchors in this
part of the document are at `b05c505b`: `O` is
`apps/server/src/orchestration-v2/Orchestrator.ts`, `C` is
`packages/contracts/src/orchestrationV2.ts` and `CP` is
`apps/server/src/orchestration-v2/CommandPolicy.ts`. The commit-level comparison
is [t3code-delta-2026-11-14.md](t3code-delta-2026-11-14.md), section B.

### 2.1 Queue items are V2 entities, not runs

Queue items become their own V2 entity (`queue-item`) with an event family,
and a per-thread `thread-queue` entity holds order and hold state. A run is
created only when an item is dispatched, and `run.accepted` gains an optional
`queueItemId`. This is a recorded architecture choice, not an invariant
(decision 4.7): Inertia's compatibility transcript assumes at most one
non-terminal turn per chat, and its run ordinals are dense and assigned at
admission (G8, `implementation-progress.md:1378-1382`). To keep behavior equal
to T3's queued runs, the item carries every field T3 now hangs on a queued run
(section 2.2). If the one-non-terminal-turn assumption is removed later, T3's
queued-run model becomes the default.

The run ordinal is assigned when the run is accepted
(`thread.lastRunOrdinal + 1`). That equals T3's ordinal after renumbering at
queued start whenever something started ahead of the item (`O:2488-2500`), and
it never leaves gaps. The item records its `enqueuedAt` and the run records
`requestedAt = claim time`, so queue wait remains measurable (T3
`RunMetrics.test.ts:74`).

### 2.2 Item shape

```
queue-item {
  id                       // client-supplied uuid, unchanged from today
  threadId, projectId
  kind: "message" | "watcher-note" | "delegated-results"
  origin: "composer" | "refused-follow-up" | "stop-and-send" | "watcher"
        | "delegation" | "private-connect" | "requeued"
  createdBy: { actor: "human" | "runtime" | "device", deviceId? }
                                         // device id set by the server only
  content (<= 20,000 chars), attachments (retained refs, images only)
  selection?: { providerId, providerInstanceId, modelSelection, interactionMode }
             | "follow-current"          // automatic kinds (T3 followsThreadSelection)
                                         // absent: resolved from the queue tail at enqueue
  position                               // one FIFO order for every kind
  skipsHold?: true                       // stop-and-send item only (T3 skipsHeldQueue)
  steerWhenReady?: { runId }             // deferred steer (T3 steerWhenReadyRunId)
  steerFallbackOf?: { runId, afterRunOrdinal }
                                         // declined steer (T3 steerFollowUpOfRunId)
  freshContext?: true                    // T3 freshContext; dormant until fresh sends exist
  editRevision, enqueuedAt, editedAt
  state: "waiting" | "dispatching" | "blocked" | "delivered" | "cancelled"
  blockedReason?, detail?
  dispatchOrdinal                        // claims so far
  delivery?: { mode: "run" | "steer" | "after-stop", outcome?: "restarted",
               runId, attemptId, turnId, messageId, steerEffectId?, deliveredAt }
  attribution?: watcherNote | delegatedCompletion   // existing schemas
}
thread-queue { threadId, order: itemId[], held, holdReason, revision }
```

There is no access ceiling on an item: a queued item runs under the chat's
access and interaction mode at its start, as a T3 queued run does (decision
4.3).

Delivery order is a pure function of the projection, tested on its own, and
follows T3 `QueuedRunOrder.ts:12-31` (byte-unchanged since the pin): delegated
results first, then every other item by `position` (decision 4.2). A held
queue starts nothing automatically except an item with `skipsHold`. A blocked
watcher note is skipped; a blocked user item stops the queue until it is sent,
edited or removed (today's behavior). A watcher note whose source review is
stale is cancelled at queued start (decision 4.2).

Caps (decision 4.1): 20 user-attributed items (every `message` item,
whatever its origin), one delegated delivery, and watcher notes bounded to at
most one waiting note per watcher and five in total.

### 2.3 Events

All are thread events committed through the existing event store with the
`queued_messages` row as the compatibility projection in the same transaction,
the pattern Phase 4 uses for delegated rows.

| Event | Written by | Effect |
| --- | --- | --- |
| `queue.item-enqueued` | enqueue, refused follow-up, watcher, delegation planner, Private Connect | New item. Position: end of the queue; position 1 for stop-and-send; after the items queued before the steer for a declined steer (decision N2) |
| `queue.item-edited` | edit | Replaces content, attachments and optionally selection; bumps `editRevision` |
| `queue.reordered` | reorder (server command; no client offers it, decision N13) | Full new order (bounded by the caps) |
| `queue.item-cancelled` | remove, Stop withdrawal, delegation withdrawal, watcher coalescing, stale drop | Terminal; reason `user`, `stopped`, `withdrawn`, `superseded`, `stale` |
| `queue.hold-changed` | Stop, failure, usage limit, restart, resume, user send | `held` and `holdReason` on `thread-queue` |
| `queue.send-requested` | Send now, resume | Durable manual intent (replaces `manualRetries`) |
| `queue.item-claimed` | dispatcher | `dispatching`, `dispatchOrdinal + 1`, mode |
| `queue.item-released` | dispatcher, boot | Back to `waiting`; reason `transient`, `runtime-lost`, `steer-declined`, `turn-ended` |
| `queue.item-blocked` | dispatcher | `blocked` with reason and public detail |
| `queue.item-delivered` | run admission, steer settlement | Terminal; full delivery attribution |
| `queue.item-requeued` | boot reconciliation | A delivered item whose run never started goes back to the front, held (T3 `737afe24b`) |

`run.accepted` adds `queueItemId` and `afterStopOf` (the run that
stop-and-send stopped). `run-control.steer-requested` already carries the
queued message id (`run-control-repository.ts:156-164`). The interrupt that
stop-and-send records carries the reason "Stopped to send a new message"
(T3 `O:7135`).

### 2.4 Commands and receipts

The existing commands keep their names and gain real events. New commands:

- `message.queue.edit {conversationId, id, expectedRevision, content,
  attachments?, selection?}`: refused for automatic kinds, for items no
  longer `waiting` or `blocked`, and while the chat has an open question or
  approval (decision N11).
- `message.queue.reorder {conversationId, id, beforeId | null}`: refuses to
  move an automatic item or to place anything ahead of a delegated delivery,
  as T3 `O:11394-11440`. It exists for the later agent queue tool (T3
  `t3_queue`); no client offers it (decision N13).
- `message.queue.resume {conversationId}`: Resume (decision N7).

Every user command is receipted under `human` with the renderer's request id,
as G5 does; device commands are receipted under `device:<id>`. Internal
dispatch uses the command id `queue:<item id>:<dispatchOrdinal>` instead of
`queue:<item id>`, and the admitted message id is fixed at claim time. Each
dispatch attempt therefore has its own identity, a replay of the same attempt
is idempotent, and a later retry of a released item can never be answered by
an earlier attempt's receipt. This is Inertia's form of T3's per-dispatch start
effect ids (`737afe24b`, `O:3202`). A deferred steer is delivered under
`queue:<item id>:steer-when-ready:<run id>:<attempt id>`, Inertia's form of T3's
`command:deferred-steer:<queued>:<run>:<attempt>` (`O:15650-15700`).

Refusals keep G5's rule: internal dispatch never records a rejected receipt;
user commands record only deterministic, non-user-correctable refusals.

### 2.5 Steering and the interrupt/restart fallback

Send now on a running chat resolves like T3's `decideSteeringExecution`
(`CP:267-289`) and the forced-restart test at `O:6116-6134`, with Inertia's
stop-and-send in place of T3's same-run `interrupt_restart`:

1. The steer is direct when the active run's harness can steer (decision 4.9)
   and nothing forces a restart: the item's selection is on the run's
   provider instance and can apply on the next turn, and any attachments are
   accepted by the steer (`steerAcceptsAttachments`). Commit
   `queue.item-claimed (mode steer)` and G5's `run-control.steer-requested`
   with its `provider.steer` effect. The outcome `accepted` delivers the item;
   `refused` and `turn-ended` release it at its own position (decision N2);
   `unconfirmed` and `unavailable` block it as today. While the run is still
   preparing, or running without a provider turn, the item is stored with
   `steerWhenReady` and steered when the provider turn starts (decision N1).
2. When a restart is forced, or the harness cannot steer but can interrupt,
   Send now uses the stop-and-send mechanism (decision 4.6): the run is
   stopped and the item runs next. The renderer labels the action **Stop and
   send** in that case, so the user sees what will happen before choosing it.
   Exception (updated 2026-11-17, T3 `0597532f1`): when the only reason for
   the restart is that the item's selection is on another provider instance,
   and the target harness cannot interrupt-restart (T3
   `providerSwitchWaitsForTurn` = `supportsQueuedMessages &&
   !(supportsInterrupt && supportsSteeringByInterruptRestart)`, `CP:136-145`;
   today Claude and Pi), the item queues behind the turn instead. The run is
   not stopped and the action is labelled as queueing. Codex, OpenCode and
   Cursor SDK keep stop-and-send. The explicit **Stop and send** action (4.6)
   is unchanged.
3. When the harness can neither steer nor interrupt, Send now is refused, as
   T3 refuses (`CP:278-288`).

A composer submission while a run is active (T3 `deliveryIntent: "auto"`,
`CP:154-192`) steers when step 1 applies and otherwise queues behind the
turn. Where T3 would force a same-run restart for an automatic send (a
selection that must apply now, or attachments a steer does not accept), Inertia
queues instead; see section 5.

Delegated deliveries move from the direct `turns.steer` call to the same
`provider.steer` effect, closing the G5 follow-up. Steering during automatic
compaction follows decision N4.

### 2.6 Automatic-result priority and dispatcher precedence

At a turn boundary the order is: a waiting limit-reset resume (it runs before
the queue because the queue stays held after a failed turn, matching T3
`cbb0417df`), then the queue in delivery order. Updated 2026-11-17 (T3
`4c8cb0445`, `QueuedRunOrder.ts:13-50`): delegated deliveries and the other
items each keep their own order (position, then sequence), and the two lists
merge by request time, with a delivery winning a tie. The request time of
Inertia's coalesced per-conversation delivery is that of its earliest
undelivered completion. A stop-and-send item is stamped with the time of the
Send, so results that arrived before it still go first, which is T3's
`O:7525-7540` behaviour, now produced by the order function alone. Watcher
notes no longer form a class after user items (decision 4.2). A restart
continuation keeps today's rule: it is not planned while items wait and an
app-update interrupt releases the queue instead.

The Phase 4 rule "any manual Send of a user item dispatches a waiting
delegated delivery first" (`queued-message-runtime.ts:105-108`) is dropped
(updated 2026-11-17). It was never T3's: T3's `queued-run.start` starts the
selected item and refuses automatic items as targets (`O:15295-15318`,
unchanged since `b05c505b`), and no AGENTS.md invariant requires the rule.
Send now on a chosen item starts that item. A Send to an idle chat while
unheld items wait starts the next queued item first, and the new message
waits behind it; restart continuations are exempt (T3 `7a72fe301`,
`O:15529`). Today the drain after settlement is asynchronous
(`queued-message-runtime.ts:632`), so package 2 needs a race test for that
gap.

Holds follow T3: Stop holds every queued item and cancels buffered provider
wakes (`O:12560-12588`); a provider failure on the same instance, a disabled
instance or a missing checkout holds the queue (`O:2440-2486`); a usage limit
holds only the limited provider's items while its reported reset is in the
future (decision N8); messages sent after failed or stopped isolated-workspace
preparation wait held (decision N9). A user send from a client releases the
hold; server continuations, scheduled deliveries and steer fallbacks do not
(`O:7350-7370`).

### 2.7 Configuration changes while running

Follows T3 (decision 4.8). A provider, model, effort, interaction-mode or
access-mode change on a running chat is accepted and committed to the chat
immediately, as T3's `thread.model-selection.set`, `thread.runtime-mode.set`
and `thread.interaction-mode.set` are (`O:5061-5071`). The active run keeps
the selection it started with. Queued items:

- an item enqueued with a selection keeps it;
- an item enqueued without one takes the selection of the last queued item
  that has one, else the chat's current selection (T3 `4168c14c7`,
  `queueTailModelSelection`, `O:1008-1019`, used at `O:7347`);
- automatic items (`follow-current`) take the chat's selection at their
  start (T3 `5731c0222`, `beb528ce4`, `O:976-1005`);
- a promoted item steers with its own selection (T3 `a732caa7d`).

Ordered configuration changes therefore ride on items: item 1 under model A
and item 2 under model B switch between them at item 2's start, through the
existing provider switch and backing path. A switch whose replaced session
still has background work holds the queue instead of ending that work (T3
`6049196c5`, `O:2655-2680`). There are no configuration-only queue rows. A
mode change restarts a stalled queue, as T3 does (`O:15461-15468`).

Applying effort and flags live to a running Claude turn (T3 `d6e5f2e06`,
`5984bbb36`, `provider-session.apply-model-selection`) is a separate
provider item for the Claude agent SDK harness only, with portable fixtures.
Until it lands, such a change takes effect on the next run.

### 2.8 Projections and publication

`thread-queue` and `queue-item` are projected by a new
`src/server/orchestration-v2/queue-projector.ts`; the projection version
increases by one (after any G9 bump). The `message.queue` result gains
`position`, `editRevision`, `selection`, `held`, `holdReason`, `delivery`,
`steerWhenReady` and `editable` flags; the caps follow decision 4.1. The
server pushes a `conversation.queue.changed {conversationId, revision}` event
so the renderer stops polling; this is a narrow slice of L4, not general V2
publication. Queue rows stay off the token stream (T3 `4c2f04d35`,
`ad0b2a9d2`).

### 2.9 Crash and restart

Boot reconciliation runs before admission (Phase 6 rule), per chat, in one
lane section, and follows T3 `737afe24b`
(`ProviderRuntimeRecoveryService.ts:331-443`):

- `dispatching` with no accepted run: `queue.item-released (runtime-lost)`.
- Delivered to a run that never reached the provider, user items only:
  `queue.item-requeued` at the **front**, positions 1..n in their original
  order ahead of the items already waiting. Updated 2026-11-17 (T3
  `34204a39e`, `rewindUnacceptedRuns`, `ProviderRuntimeRecoveryService.ts:220-260`):
  "never reached the provider" means that no attempt of the run has a
  provider-turn observation and none has a pending request. It is never
  decided from the turn status, because a run is marked running before its
  provider accepts the prompt.
- Unattended prompts that never reached the provider (agent-sent through
  `inertia_send_message`, and scheduled prompts once they exist) are sent
  again after boot, as T3 does when restart continuation is on
  (`:440-500`). Each resend is a new attempt, admitted only after boot
  confirms cleanup, so no same-run restart is written. A run is resent at
  most three times (`MAX_RESENDS`, `:62`), and never after a Stop recorded on
  it or on the run that delegated it. This lands in the recovery phase;
  package 2 only records how such items are marked.
- The whole queue is held with reason `restart`. Buffered provider
  notifications are exempt, as in T3.
- Automatic items are not requeued; their owners (delegation recovery,
  watcher) re-plan. An unsent usage-limit resume gets a fresh request id in the
  recovery phase (T3 `240446e2d`).
- A steer whose effect was retired as `runtime-lost` (G5): the item blocks
  with the existing "did not confirm" detail; it is never resent.
- `queue.send-requested` without a later claim: honoured after boot.
- A requeued item is admitted even when it takes the user class over the cap;
  the cap bounds enqueue, and at most one run per chat can be requeued.

### 2.10 Migration plan

The branch's last migration is 118 today (`database-migration-lineage.json`;
`src/server/persistence/migrations/orchestration-v2-receipt-status.ts:3`).
The pending sync with `main` renumbers it: `main` now owns 112–116, so the
branch's migrations become 117–123 and Phase 5 starts at **124**. Take the
final numbers when the package lands; if G9 or another package adds a
migration first, every number below moves up again.

- **124 `PersistQueueItemOrderAndDelivery`** (package 1). Adds nullable or
  defaulted columns to `queued_messages`, so no table rebuild is needed:
  `position INTEGER`, `kind TEXT CHECK (kind IN ('message','watcher-note',
  'delegated-results'))` backfilled from the attribution columns,
  `edit_revision INTEGER NOT NULL DEFAULT 0`, `edited_at TEXT`,
  `dispatch_ordinal INTEGER NOT NULL DEFAULT 0`, `run_id TEXT`,
  `delivery_mode TEXT CHECK (delivery_mode IS NULL OR delivery_mode IN
  ('run','steer','after-stop'))`, `hold_reason TEXT`, `origin TEXT`,
  `skips_hold INTEGER NOT NULL DEFAULT 0`, `steer_when_ready_run_id TEXT` and
  `steer_fallback_json TEXT` (JSON-valid, bounded). It backfills `position`
  for active rows other than delegated deliveries by `sequence`, and adds an
  index on `(conversation_id, state, position)`. A delegated delivery is
  ordered by its request time (updated 2026-11-17, section 2.6), so it needs
  no position. The `state` CHECK is unchanged;
  "held" is a thread property and "delivered" stays `accepted` in the table.
- **125 `PersistQueueItemSelection`** (package 3). Adds `selection_json`
  (JSON-valid, bounded). There is no `access_ceiling` column (decision 4.3).
  Existing rows get a selection derived from their `route_identity` when it
  still parses, else `NULL`, which the runtime resolves as "follow the queue
  tail" for a user item. If packages 1 and 3 land in the same checkpoint, fold
  125 into 124.

Both are transactional and append-only. V2 events for legacy active rows are
not written by SQL: at boot an idempotent adoption commits
`queue.item-enqueued (origin legacy)` with the command id
`queue-adopt:<item id>`, before scheduling. Tests use a representative fixture
at the last pre-Phase-5 migration (123 after the sync) with waiting, blocked,
dispatching, accepted and cancelled rows, including a watcher note, a
delegated row and image attachments, and check that a rebuild reproduces the
same entities.

## 3. Packages

Order: **1 core → 2 runtime → 3 per-item model → 4 integrations → 5
renderer**. Package 5 can start its list and edit slices after package 2; its
model chip waits for 3 and its Private Connect slice for 4. Package 2 touches
the turn controller and send commands that G9 is changing; start it after G9
lands and after the main sync.

### Package 1: core

Scope: queue item entities, event family, projector, the FIFO delivery order
function, caps and per-watcher coalescing, edit/cancel/reorder/hold/send
intent commands with real events, compatibility projection, migration 124,
boot adoption, the new dispatch identity scheme (definitions only).

Files likely touched: new `src/shared/orchestration-queue.ts`;
`src/shared/orchestration-v2.ts` (event union); new
`src/server/orchestration-v2/queue-projector.ts` and `queue-repository.ts`;
`projector.ts` (version, dispatch); `src/shared/queued-messages.ts`;
`src/shared/contracts/client-command/agent.ts`;
`src/server/persistence/queued-message-repository.ts`; new
`src/server/persistence/migrations/queue-items.ts`; `recent-migrations.ts`;
`database-migration-lineage.json`; `database-recovery-required-tables.ts`.

Tests (unit and integration, `*.test.ts`): new
`tests/server/orchestration-queue-core.test.ts`; migration fixture in
`tests/server/database-migrations.test.ts`; receipts in
`orchestration-command-authority.test.ts`.

Acceptance:
- Delivery order: delegated deliveries and the other items, each in their own
  order, merged by request time with a delivery winning a tie; watcher notes
  are ordinary items; blocked watcher skipped (port of T3
  `QueuedRunOrder.test.ts` at `b387e3a17`, "delivers completions and queued
  messages in request order").
- Reorder refuses automatic items and positions ahead of delegated results
  (T3 `O:11394-11440`); reorder of a dispatched item is refused.
- Edit with a stale `expectedRevision` is refused; edit of a dispatching
  item is refused; edit replaces attachments only when given.
- Exact replay of every command returns the original answer and writes
  nothing; a different payload under the same id is `command-conflict`.
- Caps enforced under concurrent enqueues: 20 user items, one delegated
  delivery, one waiting note per watcher (a newer note supersedes the older
  one) and five watcher notes in total.
- Upgrade from the pre-Phase-5 fixture plus boot adoption yields the same
  queue the old repository listed, in FIFO positions; a rebuild reproduces it.

### Package 2: runtime

Scope: rewrite `queued-message-runtime.ts` on the core: claim with
`queue:<item>:<n>`, `run.accepted.queueItemId`, delivery attribution, steer
through `provider.steer`, durable Send now, hold and Resume (decision N7),
stop-and-send at position 1 for every provider with T3's edge rules (decision
4.6), deferred steer (N1), declined-steer placement (N2), the
failed-workspace-setup hold (N9), boot reconciliation (2.9), dispatcher
precedence (2.6).

Prerequisite from the core review: before `provider.steer` (a provider-facing
kind) is dispatched by the effect worker, adopt T3's slot detachment after 30 s
and the per-kind slot cap (`cbc38a1b0`, `20584babc`; delta section A, B1).

Files: `src/server/runtime/queued-message-runtime.ts`;
`commands/message-send-command.ts`, `message-follow-up-command.ts`,
`message-send-support.ts`, `agent-stop-command.ts`;
`src/server/runtime/turns/turn-follow-up-coordinator.ts`;
`src/server/persistence/turn-ledger-repository.ts`,
`transcript-repository.ts`; `src/server/orchestration-v2/turn-repository.ts`,
`run-control-repository.ts`, `effect-outbox.ts`, `effect-runtime.ts`;
`restart-continuation-scheduler.ts`; `src/server/index.ts` (boot order).

Tests: extend `tests/server/queued-message-runtime.test.ts`,
`follow-up-delivery-uncertainty.test.ts`, `turn-restart-continuation.test.ts`,
`limit-reset-turn-dispatch.test.ts`; new
`tests/server/orchestration-queue-recovery.test.ts`; Electron:
update `tests/e2e/composer-stop-and-send.spec.ts`, new
`tests/e2e/queue-restart.spec.ts` (queue and hold survive a relaunch).

Acceptance:
- A released item retried later gets a new command id; its first attempt's
  receipt never answers the second.
- Run accepted from an item carries `queueItemId`; its ordinal is dense.
- Steer accepted, refused, turn-ended, unconfirmed and runtime-lost each give
  the documented item state; nothing is sent twice.
- Stop holds the queue; a user send or Resume releases it; an automatic
  dispatch does not (T3 `ThreadStop.test.ts:710`).
- Stop and send with other user items queued puts the new item first, shifts
  the rest, starts it even when an older hold exists, runs a waiting
  delegated delivery first, and reports `restarted` (T3 `631ea1b6d`
  "restarts by stopping the running turn when the provider cannot
  interrupt-restart" and "starts a restart that stops the running turn ahead
  of an older held queue"). The refusal "Send or remove the queued message
  first." is gone.
- Stop and send into a turn that already ended starts the item immediately;
  into a run that Stop already reached, it queues as a start behind the
  stopping run; an explicit steer into that run is refused (T3 `f12bb6229`,
  `O:6960-7008`).
- Send now while the run is preparing, or running before its provider turn,
  stores `steerWhenReady` and steers once on provider start, under a
  per-attempt command id; a maintenance command is refused as a steer (T3
  `b20bbc595`).
- A declined composer steer is placed after the items queued before it,
  keeping earlier declined steers in order (T3 `2248ca8db`, `O:7486-7513`); a
  refused Send now leaves no delivered transcript row and forks exclude
  queued items (T3 `9fb449232`).
- Crash after claim, after admission before provider start, and during a
  steer each reconcile as in 2.9; requeued items come first and the queue is
  held; Send now pressed during compaction survives a restart.
- Force stop never tears down an item whose run started during cleanup (T3
  `2e0bd97e8`); Stop that lands while a queued item is being admitted holds it
  (checked inside the admitting section; T3 `2de337003`).
- Messages sent after an isolated workspace failed or was stopped wait held
  and never run in the project checkout (T3 `4225c9dfa`).
- The settle path of a claimed effect retries a busy database before giving
  up, so a `running` row cannot block later items (T3 `5ba3a84db`; it may land
  earlier as core polish).

### Package 3: per-item model (L1)

Scope: selection snapshot at enqueue with queue-tail inheritance (N5);
replace `route_identity` blocking with per-item selection; switch provider at
item start through the existing switch, backing and coverage path;
configuration changes while running per T3 (2.7); automatic kinds follow the
current selection (T3 `5731c0222`, `beb528ce4`), and a steered item keeps its
own (T3 `a732caa7d`); per-provider usage-limit hold (N8). There is no access
ceiling (decision 4.3).

Files: `queued-message-repository.ts` (remove `queuedRouteIdentity` from the
queue; limit-reset and continuation keep their own copy),
`commands/conversation-commands.ts` (drop the "Stop the active run or review
before changing its agent configuration." refusal at `:60`, `:585`, `:623`),
`orchestration-v2/projector.ts` (accept `thread.configured` while a run is
active), `turns/turn-request-preparation.ts`, provider switch and backing
repositories, `src/server/usage/limit-reset-scheduler.ts`, migration 125.

Tests: new `tests/server/orchestration-queue-selection.test.ts`; extend
`orchestration-backings.test.ts` (switch between queued items keeps coverage,
switch-back delivers only intervening items) and the provider-switch fallback
suites.

Acceptance:
- Two items under different models run in order and switch between them;
  the second's switch does not end background work (T3 `6049196c5`).
- Changing the model, effort, interaction or access mode while running is
  accepted, updates the chat at once, and does not alter the active run.
- An item enqueued without a selection takes the last queued item's selection
  (T3 `4168c14c7`); an automatic item takes the chat's selection at start.
- A queued item runs under the chat's access mode at its start; agent-created
  items stay within the managed-chat ceilings.
- An item whose provider instance was removed or disabled blocks with a named
  reason instead of failing the run (T3 `O:2440-2486`).
- A usage-limited provider holds only its own items, keeps them held after
  another provider's turn succeeds while its reset is in the future, lifts the
  hold when the reset is unknown, and a user start lifts it (T3 `8d236998d`,
  `usageLimitHoldsQueue`, `O:1026-1045`).

### Package 4: integrations

Scope: watcher delivery on queue events with FIFO order, per-watcher
coalescing and the stale-note drop (decision 4.2); delegation mailbox on queue
events; Private Connect queue (decision 4.4); steering capability truth with
T3's new flags (decision 4.9, N3, N4); agent sends to a stopping chat queue
(N10); the two assigned upstream items: Pi clears its native queue before
abort and the cleared texts become a notice (`afb8619e1d`), and Codex
`turn/start` must not adopt a turn owned by another attempt (`54d0a161bb`); a
read model the later agent queue tool can wrap (T3 `t3_queue`).
`docs/user/watcher.md` (`:84`, `:92` and the automatic-sending paragraph)
must be rewritten in this package, because it promises user-first order and a
three-item queue.

Files: `src/server/runtime/watcher/watcher-delivery.ts`;
`src/server/orchestration-v2/delegation-delivery-planner.ts`,
`delegation-repository.ts`, `delegation-reads.ts`;
`src/server/runtime/delegation/task-service.ts`;
`src/server/runtime/agent-thread-manager.ts` (`inertia_send_message`);
`src/server/private-connect/prompt-admission.ts`, `runtime-gateway.ts`;
`src/shared/private-connect/*` (projection schema);
`src/shared/follow-up-steer.ts`, `src/server/provider/capability-manifest.ts`;
`src/server/provider/pi-rpc-harness.ts`; `src/server/codex/app-server-run.ts`;
`docs/user/watcher.md`, `docs/PRIVATE_CONNECT.md`.

Tests: `watcher-delivery.test.ts`, `delegation-queue.test.ts`,
`orchestration-delegation-*.test.ts`, Private Connect gateway tests,
`pi-rpc-harness.test.ts`, Codex app-server tests; `npm run test:portable`
(provider protocol changes); Electron `delegation-wake.spec.ts` and a Private
Connect scenario.

Acceptance:
- A watcher note queues at the end, after items queued before it and before
  items queued after it; a newer note from the same watcher supersedes its
  waiting note; a stale note is cancelled at start and its card says **Not
  sent** with the reason; removing a note still reports "Not sent" to the
  watcher card. Delegated deliveries stay first.
- A Collaborate device's text prompt to a busy chat is queued with
  server-side `device:<id>` attribution and CRLF-normalized text; the device
  can Send now (start or steer), edit text-only items, remove and Resume; it
  cannot reorder, add or remove attachments, or edit an item that carries
  attachments. A Monitor device sees the queue read-only, with text within the
  transcript budget and attachment counts only.
- The steerable set equals the manifest's wired steer support, including
  `steerAcceptsAttachments` and `steerDuringCompaction`; portable fixtures
  cover steer success, refusal, turn-ended, malformed response and
  cancellation for every harness newly marked steerable (Pi, Cursor SDK).
- An agent's send to a chat whose run is stopping queues instead of failing
  (T3 `c192c6786`).
- Pi Stop clears its queue first and surfaces the cleared texts.

### Package 5: renderer

Scope: full queue list (two rows and "Show all N queued" when more than three
items wait, as T3 `QueuedRunsControl.tsx:57`, `:238-239`), edit in the
composer, remove, Send now (start or steer, labelled **Stop and send** when
that is what it will do), Stop and send, Resume as the composer's primary
action on a held chat (Enter on an empty composer resumes; hidden while a
question or approval is pending), a steer "waiting for acceptance" state,
per-item model chip, attribution labels, push invalidation in place of
polling, the old local queue migration (decision 4.5), user docs. No reorder
control (decision N13).

Files: `src/renderer/src/components/composer/RuntimeComposerQueuedActions.tsx`
(rewrite), `runtimeQueueClient.ts`, `runtimeQueueEvents.ts`,
`ComposerQueuedActions.tsx`, `composerQueuedPrompts.ts`, `Composer.tsx`,
`useComposerStopAction.ts`, keybinding registry;
`src/renderer/private-connect/src/workspace/ConversationPane.tsx`;
`docs/user/chats-and-agents.md`, `watcher.md` (final check after Package 4),
`keyboard-shortcuts.md`, `docs/PRIVATE_CONNECT.md`.

Tests: Happy DOM `tests/renderer/runtime-composer-queue.dom.test.tsx`,
`composer-queued-actions.dom.test.tsx`, `composer-queued-prompts.dom.test.tsx`
(focus after edit and remove; labels; live region for errors); Electron
`tests/e2e/queue-edit.spec.ts` (real geometry, restart), the updated
`composer-stop-and-send.spec.ts`.

Acceptance:
- Every action is reachable by keyboard, focus returns to a sensible row after
  remove, each row has a readable label ("Queued message 2 of 4, Claude
  Sonnet") and a polite live region announces the queue (T3
  `QueuedRunsControl.tsx:247-262`). Rows the server has not confirmed render
  as pending with their actions disabled.
- Editing keeps an unrelated composer draft and mention chips; cancelling an
  edit with changes keeps them; recovery moves an edit into the thread draft
  only when that draft is empty, otherwise it shows a toast; a cancelled or
  replaced edit releases its staged uploads; removing an attachment counts as
  an edit and a cleared edit can only be discarded; every "add to chat" entry
  point targets the edit being made (T3 `queuedMessageEdit.ts:12-50`,
  `cebdf3998`, `ceed427d7`, `7271ea06a`, `5e06246d2`, `ed7e5010b`).
- Edit is allowed during compaction (T3 `bfd37b774`) and refused while a
  question or approval is open (T3 `editBlockedReason`).
- Resume shares the Stop pending state and latch (T3
  `ComposerPrimaryActions.tsx:88-129`, `:364-373`).
- The queue updates without polling after a server push; a reconnect
  refetches once.
- A legacy local item can be moved into the durable queue only by an explicit
  action and is never sent automatically.

## 4. Decisions

Every decision below was re-answered on 2026-11-14 against T3 Code at
`b05c505b`, under the rule that T3's current orchestrator is the reference and
Inertia differs only where an AGENTS.md invariant forces it or an architecture
choice is recorded. Each is marked **Decided (follows T3 b05c505b)** or
**Decided (deliberate difference: <reason>)**.

### 4.1 Queue cap

**Decided (deliberate difference: AGENTS.md "Bound runtime, output, and input
sizes").**

T3 has no cap on queued user runs (none in the enqueue path `O:7470-7540`;
`QueuedRunOrder.ts` unchanged). It bounds automatic and foreign sources: 20
queued webhook runs per scheduled task (`WEBHOOK_MAX_QUEUED_PER_TASK`,
`apps/server/src/scheduledTasks/ScheduledTaskService.ts:90`), one queued
occurrence per recurring task (`1d61dd3fd`), coalesced and stale-dropped pull
request wakes (`1de3c3c68`, `0af2d2164`), three pending guest messages
(`packages/contracts/src/guestShare.ts:19-28`). An unbounded user queue with
retained attachments would break the bounded-input invariant, so a cap stays,
set high enough not to shape normal use:

- 20 user-attributed items per chat;
- one delegated delivery (unchanged);
- watcher notes: at most one waiting note per watcher (a newer note
  supersedes the waiting one, as T3 coalesces recurring and pull request
  wakes) and five in total. At the total, a new note is not queued and its
  card says **Not sent** with the reason.

Watcher notes no longer compete for user slots, so the "leaves the last place
for you" rule (`docs/user/watcher.md:92`) goes; its anti-loop rule stays. The
renderer shows two rows and "Show all N queued" once more than three items
wait (T3 `QUEUE_VISIBLE_ROWS = 3`, `QueuedRunsControl.tsx:57`, `:238-239`).

### 4.2 Watcher order

**Decided (follows T3 b05c505b).**

T3 orders FIFO: delegated completions first, then everything by
`queuePosition ?? ordinal` (`QueuedRunOrder.ts:12-31`, byte-unchanged).
Monitor notes follow the current selection (`O:976-994`), never steer
(`O:7141-7182`), and stale pull request wakes are cancelled at queued start
(`0af2d2164`, `O:1116-1126`, `:2383-2391`). User-first order was an Inertia
product promise (`docs/user/watcher.md:84`), not an invariant.

Updated 2026-11-17: T3 `4c8cb0445` replaced "completions first" with a merge
by request time (section 2.6), so `QueuedRunOrder.ts` is no longer
byte-unchanged.

Inertia follows T3: watcher notes take positions with user items, delegated
deliveries merge with them by request time, and a watcher note whose source review is stale (a newer
note from the same watcher exists, or the turn it reviewed was rolled back)
is cancelled at queued start with reason `stale`. This removes a priority
class from the order function and from migration 124's index. A note can
still be removed. `docs/user/watcher.md` must be rewritten in Package 4.

### 4.3 Access widening

**Decided (follows T3 b05c505b).**

A T3 queued run carries `modelSelection` but no runtime mode
(`C:725-760`) and starts under the thread's current mode. Since the pin T3
added only an organization ceiling that makes the queue wait without a hold
(`d897d3f3f`, `O:2436-2439`) and a queue restart on `thread.runtime-mode.set`
(`O:15461-15468`). Agent-originated dispatch is still limited by
`DispatchModeLimit`. No invariant forces a per-item ceiling: access changes are
desktop user actions, Private Connect cannot enable Full Access
(`docs/PRIVATE_CONNECT.md:49-51`), and delegated children keep their own
ceilings.

A queued item runs under the chat's access and interaction mode at its start.
There is no `accessCeiling` field, no migration column and no "Access widened
since this was queued" block. Items created by agents stay within the existing
managed-chat ceilings (Inertia's `DispatchModeLimit` equivalent). The user
guide says that a queued message runs with the chat's settings when it starts.

### 4.4 Private Connect

**Decided (follows T3 b05c505b mobile client; deliberate difference: no file
or attachment access from devices, the documented Private Connect boundary).**

T3 has two foreign surfaces. Mobile is a full owner client: steer, edit,
remove, Resume queue and a "Queue paused" banner, no reorder
(`apps/mobile/src/features/threads/ThreadQueueControl.tsx:219-305`). Guest
share is a foreign-user surface: at most three pending messages, owner
admission, server-prefixed text, cancel but no edit
(`GuestShareDecider.ts:143-255`). Private Connect devices are the user's own
paired devices (`docs/PRIVATE_CONNECT.md:1-6`), so mobile is the analogue.

- **Monitor:** a read-only queue, text within the transcript budget and
  attachment counts only.
- **Collaborate:** for text items, enqueue to a busy chat, Send now (start or
  steer), edit, remove and Resume. No reorder (as T3 mobile). No attachment
  operations: a device cannot add or remove attachments or edit an item that
  carries them, though it may remove it.
- From the guest share: a server-side `device:<id>` attribution that a client
  cannot claim, and CRLF normalization (T3 `6bce2226d`).
- The prompt path moves onto the queue command authority with the actor
  `device:<id>`; payloads are validated at the gateway (AGENTS.md).

This **widens the documented Collaborate grant** ("supervised text prompts,
answers to non-secret agent questions, and stopping the exact active run",
`docs/PRIVATE_CONNECT.md:41-42`): steering, editing, removing and resuming
queued text are new device powers. `docs/PRIVATE_CONNECT.md` must say so in
the same release, and the gateway's authorization tests must cover each new
command per level.

### 4.5 The old local queue

**Decided (deliberate difference: AGENTS.md "Preserve … identities across
every command boundary"; T3 has no desktop counterpart).**

T3's only analogue is the mobile durable outbox, which resends automatically
because its command and message ids are stable and delivery is idempotent.
Legacy local items have no idempotent identity and their earlier delivery is
unknown (`ComposerQueuedActions.tsx:276-277`), so automatic import could
resend a prompt.

Unchanged: stop the local write path (`queueComposerDraft.ts:8`) and refuse
instead; show legacy items under "Saved from an earlier version" with Move to
queue (a fresh id through `message.queue.enqueue`, then delete the local copy)
and Discard (release attachments). Remove the component and keys one release
after Phase 5 ships.

### 4.6 Stop and send

**Decided (follows T3 b05c505b `631ea1b6d` and `f12bb6229` for every
provider; deliberate difference: never a same-run restart, because of the
cleanup-proof invariant).**

T3 has two restart paths chosen by capability (`CP:267-289`). Providers with
interrupt-restart (Codex, Cursor SDK, OpenCode, generic ACP) restart the same
run on a new attempt with reason `steering_restart` (`O:6437`). Providers
without it (Claude, Pi) now stop the running turn and run the message next
(`631ea1b6d`, `O:7110-7140`): position 1, stop reason "Stopped to send a new
message", `skipsHeldQueue`, delivery reported as `restarted`, and an unheld
delegated result that survives the stop still runs first (`O:7525-7540`).
`f12bb6229` adds the edge rules (`O:6960-7008`).

Inertia uses T3's second path for every provider:

- stop the target run (interrupt reason "Stopped to send a new message"),
  enqueue the item at position 1 with the others shifted, and start it next;
- `skipsHold` for this item only, so an older held queue does not hold it;
- a waiting delegated delivery still runs first;
- report delivery `restarted`; the new run records `afterStopOf`;
- the refusal "Send or remove the queued message first."
  (`queued-message-runtime.ts:342-347`) is removed;
- edge rules: a target turn that already ended makes it a start; a run that
  Stop already reached makes it a start queued behind the stopping run; an
  explicit steer in that situation is refused.

The invariant: AGENTS.md requires terminating complete process trees on
timeout or cancellation, Inertia's stop ladder can end `unconfirmed-released`,
and G8 replaces an attempt only after confirmed cleanup. A same-run
`steering_restart` on an attempt whose process tree may still be alive is
therefore never written by the queue; `steering_restart` stays reserved.

### 4.7 Queued items as runs or as their own entities

**Decided (deliberate difference: recorded architecture choice, not an
invariant).**

T3 still models a queued message as a queued run, and now hangs more on it:
`steerWhenReadyRunId` (`C:737`), `freshContext` (`C:760`), the steer fallback
(`steerFollowUpOfRunId`, `steerFollowUpAfterRunOrdinal`, `C:3369-3370`),
`followsThreadSelection` on the message (`C:1390`) and the queued provider
thread placeholder. Inertia keeps separate `queue-item` entities, because its
compatibility transcript assumes one non-terminal turn per chat (the turn
controller, `isActive` checks, Duo and the watcher rely on it) and G8 assigns
dense ordinals at admission. Behavior stays equal by mirroring each T3 run
field on the item (section 2.2). If the transcript assumption is removed, T3's
queued-run model becomes the default.

### 4.8 Configuration changes while running

**Decided (follows T3 b05c505b).** Replaces the earlier "next-run
configuration" design.

T3 accepts `thread.model-selection.set`, `thread.runtime-mode.set` and
`thread.interaction-mode.set` while a run is active and updates the thread at
once (`O:5061-5071`); the active run keeps its own selection. Same-instance
effort and flags apply live where the adapter supports it (Claude,
`d6e5f2e06`, `5984bbb36`, `O:5180-5208`). A queued message that names no model
takes the queue tail's (`4168c14c7`); automatic items follow the thread; a
promoted item steers with its own selection; a mode change restarts the queue.
The current refusal (`conversation-commands.ts:60`, `:585`, `:623`) is
Inertia's own choice, not an invariant.

Inertia follows T3 as described in section 2.7. Live apply is a separate
provider item per adapter, each with portable fixtures (updated 2026-11-17):
Claude effort and flags, and Codex `serviceTier` through
`thread/settings/update`, which must survive a retried attempt (T3
`8009cd8c3`, `ea6d3fc30`). A Claude `setModel` echo is not a wake
(`3eadb214e`). No
configuration-only rows. Which composer submissions name a selection must
match T3's web composer; check it when Package 3 starts (not verified here).

### 4.9 Steering capability truth

**Decided (follows T3 b05c505b).**

T3 keeps per-session turn flags (`C:293-308`) and added three since the pin:
`activeSteeringAcceptsAttachments` (`C:303`, false for Cursor and Kiro,
introduced with Kiro in `55e253856`), `activeSteeringDuringCompaction` (`C:305`,
true for Codex only, `b3f5d5270`) and `supportsNativeGoals` (`C:294`). Cursor
SDK became actively steerable (`2248ca8db`); Pi steers with a "waiting" state
until read (`871b00907`).

Inertia derives steerability from the manifest only and deletes
`STEERABLE_HARNESS_IDS` (`src/shared/follow-up-steer.ts:1-9`); adds
`steerAcceptsAttachments` and `steerDuringCompaction` to the manifest; enables
Pi and Cursor SDK steering only with portable fixtures (T3's Cursor
`message_steering` fixtures are a template), marking an entry unavailable if
its fixture cannot be made deterministic; and surfaces a steer "waiting for
acceptance" state.

### 4.10 Requeue after a restart

**Decided (follows T3 b05c505b `737afe24b`).**

T3 (`ProviderRuntimeRecoveryService.ts:331-443`): a run that is `starting`,
never started, has no provider turn and no pending request, and whose message
is the user's own, returns to the queue held at positions 1..n ahead of the
existing queued runs; every queued run is held; buffered provider
notifications are exempt; automatic unstarted runs are not retried, and an
unsent usage-limit auto-resume gets a fresh request id (`240446e2d`).

Inertia requeues user items whose run never reached the provider, at the
front in their original order, holds the whole queue, and never requeues
automatic items or anything with evidence of delivery (section 2.9).

Updated 2026-11-17 (T3 `34204a39e`): "never reached the provider" is decided
from provider-turn observations on every attempt, not from the turn status.
Unattended prompts (agent-sent, later scheduled) are resent after boot at
most three times, and never after a recorded Stop on the run or on the run
that delegated it (section 2.9; recovery phase). Delegated deliveries and
notifications are still never requeued.

### 4.11 Decisions added from current T3

| # | Decision | T3 at `b05c505b` | Inertia | Package |
| --- | --- | --- | --- | --- |
| N1 | Send now while the run is preparing | Deferred steer: a queued run with `steerWhenReadyRunId`, promoted by `deliverDeferredSteers` when the provider turn starts, command id `command:deferred-steer:<queued>:<run>:<attempt>`; `/compact`, `/logout`, `/goal` refused as steers (`b20bbc595`, `O:7255-7276`, `O:15650-15700`) | **Decided (follows T3 b05c505b).** Store the item with `steerWhenReady`, deliver on the run's provider-start observation under a per-attempt command id; if the run ends first, the item stays queued at its position. Replaces "This agent cannot take a message while it works…" (`queued-message-runtime.ts:388`) for this case | 2, M |
| N2 | Where a declined direct steer goes | After the runs queued before the steer; earlier declined steers keep their order (`2248ca8db`, `O:7486-7513`); a requeued steer is not shown as delivered (`9fb449232`) | **Decided (follows T3 b05c505b).** A refused composer steer is enqueued by submission order, not at the tail; a refused queue item returns to its own position (equivalent) | 2, S |
| N3 | Steer with attachments the steer cannot take | Forces an interrupt-restart where supported, else the steer is refused (`O:6123-6134`) | **Decided (deliberate difference: cleanup-proof invariant).** Explicit Send now uses stop-and-send (4.6); an automatic composer follow-up queues behind the turn instead of a same-run restart. Manifest flag `steerAcceptsAttachments` | 4, S |
| N4 | Steering during compaction | Only where `activeSteeringDuringCompaction` (Codex) and only during automatic compaction; `/compact` always blocks (`b3f5d5270`) | **Decided (follows T3 b05c505b).** Behind `steerDuringCompaction` with a Codex portable fixture; until it lands the queue keeps skipping compaction (`queued-message-runtime.ts:128`) | 4, S–M |
| N5 | Model for an item that names none | The last queued run's selection (`4168c14c7`) | **Decided (follows T3 b05c505b).** Section 2.7 | 3, S |
| N6 | Fresh-context items | Never steer; reserve a fresh provider thread (`e139768a7`, `C:760`, `C:3356`) | **Decided (follows T3 b05c505b), dormant.** `freshContext` is an item field that never steers; it gets a trigger only when fresh-context sends are adopted | — |
| N7 | What Resume does | Resume continues the stopped or usage-limited run natively first (`manualContinuationOfRunId`, empty prompt; `9e19b7f7e`, `cbb0417df`), then releases the queue; hidden while a request is pending; Enter on an empty composer resumes (`5f4368165`, `packages/client-runtime/src/state/threadExecution.ts:309-336`) | **Decided (follows T3 b05c505b).** `message.queue.resume` continues the interrupted run when its provider can continue it natively, else releases the hold and starts the next item. Hidden while a question or approval is pending. Native continuation per provider is a provider item (adapter `resumeTurn`); until a harness has it, Resume releases and starts. Updated 2026-11-17: Resume is refused while workspace setup is pending or failed ("Retry worktree setup or choose a workspace before resuming the queue.", T3 `3209fa953`); images from a missed run force a prompted start, so the empty-prompt continue is skipped (`c2eb8f336`); Cursor SDK native resume needs the SDK upgrade from 1.0.38 (`0b308312d`) | 2 and 5, M |
| N8 | Usage-limit hold scope | Per provider; automatic starts respect a future reset, an unknown reset lifts, a user start lifts (`8d236998d`, `O:1026-1045`) | **Decided (follows T3 b05c505b).** Section 2.6 | 3, S |
| N9 | Messages after failed or stopped workspace setup | Held, never run in the project checkout, including `start_immediately` (`4225c9dfa`, `O:7317-7330`) | **Decided (follows T3 b05c505b).** Applies to isolated-workspace preparation; Inertia's failure path is not yet checked | 2, S |
| N10 | Agent sends to a stopping chat | Queue (`c192c6786`) | **Decided (follows T3 b05c505b).** Check and align `inertia_send_message` | 4, S |
| N11 | Edit while a question is open | Refused (`editBlockedReason`, `QueuedRunsControl.tsx:140-141`) | **Decided (follows T3 b05c505b).** Refused in the renderer and by `message.queue.edit` | 5, S |
| N12 | Items created on another surface | Guest messages: owner cancels, never edits; mobile items are the owner's own | **Decided (follows T3 b05c505b mobile).** Device items are the user's own and editable on the desktop; the guest rule does not apply because Private Connect has no foreign users. Devices still cannot edit items with attachments (4.4) | 4, S |
| N13 | Reorder surface | Server command and agent tool only; no web or mobile client reorders (`QueuedRunsControl.tsx`, `ThreadQueueControl.tsx`) | **Decided (follows T3 b05c505b).** `message.queue.reorder` exists for the later agent queue tool; the desktop renderer does not offer reorder. This reverses the earlier design, which exposed Move up and Move down | 1 and 5 |

## 5. Deliberate differences from T3 and risks

Kept, each with the reason that forces it:

- **Queue cap** at 20 user items, one delegated delivery, one waiting note per
  watcher and five watcher notes in total (4.1). Reason: AGENTS.md bounded
  input sizes; T3 has no user cap.
- **Never a same-run restart.** Stop and send, and Send now when a restart is
  forced, stop the run and start the item next instead of writing a
  `steering_restart` attempt (4.6, 2.5). An automatic composer follow-up that
  T3 would restart in place queues instead (N3). Reason: AGENTS.md
  process-tree termination together with G8's cleanup-proof attempt
  replacement.
- **Separate queue-item entities**, with runs created at dispatch and dense
  ordinals (4.7). Reason: recorded architecture choice (one non-terminal turn
  in the compatibility transcript, G8 ordinals); T3's run fields are mirrored
  on the item.
- **No attachment operations from Private Connect devices** (4.4). Reason: the
  documented Private Connect boundary ("access files or attachments" is
  excluded at every level) and AGENTS.md boundary validation.
- **Old local queue** needs an explicit Move to queue or Discard (4.5). Reason:
  AGENTS.md identity preservation; T3 has no counterpart.

Closed on 2026-11-14 (Inertia now follows T3):

- Watcher notes after user items: now FIFO, with delegated deliveries merged
  by request time (4.2, updated 2026-11-17).
- Manual Send dispatching a waiting delegated delivery first (Phase 4 rule):
  dropped on 2026-11-17; Send now starts the chosen item (2.6).
- Per-item access ceiling with widening confirmation: removed (4.3).
- Send now never restarting: it now resolves like T3's steering decision,
  with stop-and-send in place of interrupt-restart (2.5).
- Stop and send refused while other user items wait: removed (4.6).
- Next-run configuration: replaced by an immediate chat update with item
  snapshots and queue-tail inheritance (4.8).
- A narrower Private Connect surface than T3 mobile: now the mobile analogue
  for text (4.4).
- Desktop reorder control: dropped, as no T3 client reorders (N13).
- Three visible rows: now two rows and "Show all" (4.1).

Risks:

- **Event-log retention of text.** Item content lives in immutable events, so
  cancelled text is no longer wiped as it is in today's row
  (`queued-message-repository.ts:153`). Inertia keeps the full event log (a
  recorded difference from T3's pruning, delta section A1). Mitigation:
  document it; keep event payloads within the existing size check; consider
  storing attachments by reference only.
- **Concurrent G9 work and the main sync.** Package 2 touches the files G9 is
  editing. Start it after G9 lands and after the main sync, then re-take the
  migration numbers (124 onward after the sync) and the projection version.
- **Compatibility projection drift.** Delegation reads, attachment GC and the
  watcher still read `queued_messages`. Every queue event must write the row
  in the same transaction; a rebuild test must compare both.
- **Receipt id change.** Moving internal dispatch from `queue:<id>` to
  `queue:<id>:<n>` makes receipts written before the upgrade unreachable by
  replay. Boot adoption must treat a `dispatching` legacy row as released, not
  replay its old command.
- **Stop during queued preparation.** G5 accepts Stop during new-turn
  preparation with nothing to stop. A queued item claimed just before Stop can
  start afterwards. Package 2 must check the hold after preparation, inside
  the admitting section; T3 `2de337003` confirms the race is real.
- **Effect worker starvation.** Routing steers through `provider.steer` puts a
  provider-facing kind on a dispatcher whose slots are held until a handler
  resolves. Adopt slot detachment and per-kind caps first (Package 2
  prerequisite).
- **Private Connect grant widening.** Device steering, editing, removal and
  Resume are new powers; the grant text, gateway authorization and audit
  labels must change together.
- **Renderer bundle budget.** The composer queue is a deferred chunk with
  little headroom (`phase4-verification.md` budget table). The rewrite must
  stay lazy.
- **Provider coverage.** Steering for Pi and Cursor SDK, steering during
  compaction, the Pi cleared-queue notice and the Codex turn-ownership guard
  need portable fixtures; Windows and Linux behavior of the stop ladder under
  Stop and send is exercised only where the Electron suite runs
  (`stop-ladder.spec.ts` is POSIX-only).
