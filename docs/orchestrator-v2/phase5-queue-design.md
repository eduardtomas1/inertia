# Phase 5 design: durable queues

**T3 reference:** T3 Code release v0.1.11, `de0466fd8` (2026-11-20). Phase 5
follows this pin for its whole duration, not T3's live `main`. A weekly title
triage of T3 `main` acts only on safety or data-loss fixes, or on contract
changes; everything else waits for the full delta survey at phase exit.
Section 6 lists the rules that are on T3 `main` but not in the pin.

Status: design for review. First written 2026-11-09, re-answered 2026-11-14,
re-checked 2026-11-17, and re-pinned to v0.1.11 on 2026-11-22. Nothing in
this document is implemented.

**Rule for every decision.** T3 Code at the pin is the reference. Inertia keeps
a deliberate difference only where an invariant in `AGENTS.md` forces it, or
where it is an explicitly recorded architecture choice. Section 4 marks each
decision accordingly, and section 5 lists the differences kept.

**Scope.** Phase 5 covers this checklist item of
[implementation-plan.md](implementation-plan.md): "Durable message/configuration
queues, edits/cancellation/reorder, native steering or explicit
interrupt/restart fallback, automatic-result priority, delivery attribution and
retry identities." It also takes:

- the deferred L1 item, per-item queue selection
  ([implementation-progress.md](implementation-progress.md));
- the two upstream items the delta assigned to the queue phase
  ([t3code-delta-2026-10-31.md](t3code-delta-2026-10-31.md) rows `54d0a161bb`
  and `afb8619e1d`).

**Companion documents:**

- [phase5-failure-matrix-pkg1.md](phase5-failure-matrix-pkg1.md) and
  [phase5-failure-matrix-pkg2.md](phase5-failure-matrix-pkg2.md): the
  expected outcome of each step of packages 1 and 2 under crash, Stop,
  rollback, route change, duplicate command and restart.
- [phase5-acceptance-pkg1-2.md](phase5-acceptance-pkg1-2.md): the T3 test
  cases at the pin that serve as acceptance lists for packages 1 and 2, and
  the cases skipped, with reasons.
- The commit-level T3 comparisons:
  [t3code-delta-2026-11-14.md](t3code-delta-2026-11-14.md),
  [t3code-delta-2026-11-17.md](t3code-delta-2026-11-17.md) and
  [t3code-delta-2026-11-22.md](t3code-delta-2026-11-22.md).

**Anchors.**

- T3 anchors are `path:line` at `de0466fd8`, with these abbreviations: `O` =
  `apps/server/src/orchestration-v2/Orchestrator.ts`, `EW` = `EffectWorker.ts`,
  `CP` = `CommandPolicy.ts`, `PTS` = `ProviderTurnStartService.ts`, `PRRS` =
  `ProviderRuntimeRecoveryService.ts`, `QRO` = `QueuedRunOrder.ts` (all under
  `apps/server/src/orchestration-v2/`), `C` =
  `packages/contracts/src/orchestrationV2.ts` and `TE` =
  `packages/client-runtime/src/state/threadExecution.ts`. Test files are named
  in full.
- Inertia anchors in section 1.1 were taken on `orchestrator-v2` at
  `652ba6c18`. Text added on 2026-11-22 anchors at the merged sync
  (`baa6db7c3`). `IP` = `docs/orchestrator-v2/implementation-progress.md`.

## 1. Current state

### 1.1 Inertia

**Storage.** The queue is the `queued_messages` table from
`PersistRuntimeQueuedMessages`
(`src/server/persistence/migrations/queued-messages.ts:6-20`). A row has:

- an autoincrement `sequence` and the client-supplied `id`;
- `content` (at most 20,000 characters), `attachments_json` and an
  `intent_digest`;
- a `route_identity`;
- `state` in `waiting | dispatching | blocked | accepted | cancelled`;
- the `turn_id` and `user_message_id` it became.

Later migrations add `watcher_note_json` (`watcher-links.ts:163`) and
`delegated_completion_json`, with a unique partial index that allows one
active delegated row per chat (`delegated-tasks.ts:78-85`). Accepted and
cancelled rows are wiped of content and pruned to the latest 50 per chat
(`pruneTerminalQueuedMessages`, `queued-message-repository.ts`). Rows cascade
when their conversation is deleted (`queued-messages.ts:9`). The queue is
**not** a V2 entity: no `orchestration_v2_events` row describes an item, an
edit or a dispatch.

**Contract.** `src/shared/queued-messages.ts` caps entries at
`MAX_QUEUED_MESSAGES = 3`, counted by `cappedCount`: active rows, excluding
delegated deliveries and unread follow-up rows (`queued-message-repository.ts:84-88`).
An entry has at most one automatic attribution. The client commands are
`message.queue.get | enqueue | remove | send | stop-and-send`
(`src/shared/contracts/client-command/agent.ts:33-41`). There is no edit,
reorder or resume command.

**Ordering.** `list()` orders delegated results first, then user entries, then
watcher notes. Within the non-delegated rows, unread follow-ups and user
entries are ordered by submission time (`created_at, sequence`). The user
documentation promises "Your own queued messages always go before watcher
notes" (`docs/user/watcher.md:84`). An automatic watcher note may not take
the last user slot.

**Route identity instead of per-item selection.** Each row stores
`queuedRouteIdentity`: project, worktree, provider, model selection, model,
effort, interaction mode and access mode. If the chat's identity differs at
dispatch, the head is blocked with "This chat's model, access or workspace
changed. Remove and queue the message again." Delegated rows always match.
Configuration changes on a running chat are refused outright
(`src/server/runtime/commands/conversation-commands.ts`; projector refusal
`src/server/orchestration-v2/projector.ts:56-58`).

**Dispatch.** `createQueuedMessageRuntime`
(`src/server/runtime/queued-message-runtime.ts`) schedules one loop per chat.
`dispatch` waits for provider cleanup. It skips during compaction, pending V2
cleanup, the update hold and checkout restore. It then releases the queue
only if the latest turn completed, or was interrupted by an app update
(`releasesQueue`, `queued-message-repository.ts`). It claims the head
(`waiting|blocked → dispatching`) and replays it through the ordinary
`message.send` handler with `requestId: first.id`. The admitting transaction
flips the row to `accepted` with the turn and message ids. Transient failures
release the claim; anything else blocks the row with the public error. A
blocked watcher note does not hold back later entries.

**Who dispatches.** Since G5 every internal dispatcher commits under the actor
`runtime`, with an origin-prefixed command id: `queue:`, `limit-reset:`,
`restart-continuation:`, `watcher:` or `delegation:` followed by the request id
(`messageSendSource`, `src/server/runtime/commands/message-send-support.ts:128-133`).
For the queue the request id is the entry id, so the command id is
`queue:<entry id>` for every dispatch attempt of that entry.

**G5 receipts.**

- Queue edits run through `store.orchestration.authority.begin` under the
  `human` actor, with the full command as the receipt source
  (`queued-message-runtime.ts:513-515`).
- `enqueue` commits its receipt in the same transaction as the row;
  `remove` cancels inside the intake section; `send` commits a receipt-only
  result; `stop-and-send` enqueues, records its receipt, then stops with
  `<request id>:stop` and the expected turn.
- Every commit is `events: []`. G5 made the edits ordered and replayable, but
  did not make the queue an event-sourced entity.
- A receipt stores `fingerprint = sha256(durableJson(command))`
  (`src/server/orchestration-v2/json.ts:42-43`, `event-store.ts:144-153`,
  `:223-226`). For queue and send commands that hash is taken over the message
  text. The receipts table has no foreign key to the chat and no delete path
  (`migrations/orchestration-v2.ts:37-49`), so the hash outlives the chat.
  Decision N17 fixes this.

**Steering from the queue.** "Send now" during a turn steers only the first
user entry, through `turns.steer`, not through G5's `provider.steer` effect.
Unconfirmed delivery blocks the entry. A static list
(`STEERABLE_HARNESS_IDS = codex-app-server, claude-agent-sdk, opencode-sdk`,
`src/shared/follow-up-steer.ts:1`), combined with the manifest capability,
decides which providers can steer.

**Stop and steer effects.** G5 records `provider.interrupt` and
`provider.steer` in the outbox but claims them in-process
(`run-control-repository.ts`, `claimControl`). It keeps the claims and waiters
in memory (`#claims`, `#waiters`), and the turn controller runs the stop
ladder. The effect dispatcher never executes either kind.

**In-memory queue state.** The queue runtime keeps six in-memory structures
(`queued-message-runtime.ts:62-67`): `running`, `enqueueing`, `again`,
`deferred`, `manualRetries` and `recovering`. The "Send now" retry pressed
during compaction lives only in `manualRetries` and is lost on restart.

**Delegated delivery row (Phase 4).** The delegation planner commits V2
`delegation.*` events and writes the queue row as their compatibility
projection, in the same transaction
(`src/server/orchestration-v2/delegation-delivery-planner.ts:150-180`). The
row:

- sits outside the user cap and is ordered first;
- cannot be sent during a turn;
- is steered automatically only when every task is armed and steerable.

A direct send to an idle parent with a waiting delivery queues the user
message behind it.

**Unread Claude follow-ups.** A follow-up that Claude accepted but never read
becomes an ordinary `queued_messages` row at settlement. The row's
`user_message_id` names the persisted message (`requeueUnreadFollowUps`,
`queued-message-repository.ts`). Rows are ordered by submission time, so a
follow-up runs after rows queued before it (N2).

- Admission moves the message into the new turn through
  `adoptUnreadFollowUp` (`turn-ledger-repository.ts:373-390`). Its guard
  `user_message_id <> ?` (`:382`) refuses a turn's own prompt.
- Portable history leaves out a message an active row names
  (`portable-history-source.ts:49-51`). Rollback cancels the row
  (`history-rollback-repository.ts:223`).
- At most 64 such rows are kept, outside the cap
  (`MAX_UNREAD_FOLLOW_UP_ROWS`).
- Recorded gaps (`IP:5438-5439`): a crash mid-turn loses the follow-up,
  because the read marks live only on the in-memory active turn
  (`turn-follow-up-coordinator.ts`). Stop shows no "Steer delivery not
  confirmed" notice.

**Managed sends with a mode (#761, merged in the sync).**
`inertia_send_message` takes `mode: auto | queue | steer | restart`
(`src/server/runtime/managed-send-modes.ts`):

- `auto` steers a running turn and starts a turn directly on an idle child.
- `queue` adds an ordinary queue row through `enqueueManagedMessage`
  (`queued-message-runtime.ts:361-370`), with content capped at 20,000
  characters. A full queue (`cappedCount >= 3`) is refused before the
  approval card, and the result says `next` when the queue is held. The row
  is written without a G5 receipt.
- `steer` needs a running turn. It is refused on an idle chat, and refused
  with `STEER_ENDED` when the turn ended before dispatch.
- `restart` captures the exact active turn before approval, stops only that
  turn, then starts a new one directly. It is refused before approval, and
  again before the stop, when a checkout restore or a resumed provider
  terminal would keep the new turn from starting.
- Every mode asks the user through an approval card.

**Watcher, limit reset, restart continuation.** Watcher notes start the next
turn when the main chat is idle and nothing non-blocked waits; otherwise they
are queued (`src/server/runtime/watcher/watcher-delivery.ts`). Limit-reset
plans and restart continuations are separate durable plans with their own
`route_identity` checks. A restart continuation is not planned, and an
existing plan goes stale, when the chat has queued entries. A queued message
sent after an app-update interrupt continues that turn.

**Crash behavior.** At boot `reconcile()` returns `dispatching` rows without a
turn to `waiting`. Delegation recovery runs, then every chat with waiting rows
is scheduled.

**Renderer.** `RuntimeComposerQueuedActions` polls `message.queue.get` every
10 seconds while a turn runs or the queue is not empty. It renders **only the
head**, with Send now and Remove. Enqueue keeps a renderer-local intent
journal of at most three pending ids in `localStorage`
(`runtimeQueueClient.ts`), so a lost acknowledgement can be checked with
`message.queue.get`.

**The old local queue.** Before the durable queue, queued prompts lived in
`localStorage` (`inertia:queued-prompts:v2:<chat>`, with a legacy unversioned
key, `composerQueuedPrompts.ts`). The legacy component still renders next to
the runtime queue, with automatic sending disabled: "Older local drafts
retain their explicit retry control; an unknown old delivery must never be
silently re-admitted as a new runtime intent" (`ComposerQueuedActions.tsx`).
New drafts fall back to it only when no runtime runner is present, and the
main and split scenes always supply one.

**Private Connect.** A Collaborate device's prompt is admitted directly as a
turn, and is refused while the chat is busy: "This conversation already has
an active agent task." (`src/server/private-connect/prompt-admission.ts`).
Devices cannot see or change the queue, and the prompt path uses neither the
queue nor the G5 command authority.

### 1.2 T3 Code at the pin

**A queued message is a run.** A run has `status: queued`, with
`queuePosition` (`C:777`), `queueHeld` (`C:778`), `steerWhenReadyRunId`
(`C:779`), `requestedAt`, `modelSelection`, `providerInstanceId` and
`freshContext` (`C:766-803`). Enqueue (`message.dispatch` with
`queue_after_active`) creates the run, its attempt, its root node and its user
message at once. The capability gate is `supportsQueuedMessages` (`C:313`).

**Commands.** `queued-run.start | reorder | cancel | edit`,
`queued-message.promote-to-steer` and `queue.resume` (`C:3513-3549`).
`message.dispatch` takes a `dispatchMode` and an optional `deliveryIntent`
`auto | steer | restart`. The handlers are:

- promote, `O:11688`;
- reorder, `O:11945-12030`;
- cancel, `O:12031-12090`;
- edit, `O:12091`;
- start and resume, `O:15705-15790`.

**Order.** `queuedRunsInDeliveryOrder` (`QRO:13-50`) splits queued runs into
delegated completions and everything else. Each list keeps its
`queuePosition ?? ordinal` order, and the two are merged by `requestedAt`,
with the completion winning a tie (test `QueuedRunOrder.test.ts:14`). Reorder
refuses to move an automatic item, or to place anything ahead of an automatic
completion delivery (`O:11981`). Edit refuses automatic deliveries,
notifications and guest messages. There is **no cap** on queued runs.

**Hold.** `queueHeld` is a boolean per queued run. Section 2.2 gives all of
T3's hold and release rules.

**Start and renumbering.** `startNextQueuedRun` (`O:2455-2700`) takes the
next unheld run, or the selected one, and resolves its selection
(`queuedRunModelSelection`, `O:1045-1053`). When any run started after the
queued run was queued, it renumbers the run to `max + 1` (`O:2610-2621`).
The start command id is `command:system:start-queued:<run>` (`O:2621`).

**Steering and the restart fallback.** `resolveDeliveryIntent` (`CP:186-224`)
and `resolveMessageDispatchIntent` (`CP:104-126`) steer when the session
supports active steering, queue when it supports queued messages, and
otherwise restart. A provider that can do neither queues. A provider that can
stop a turn but not restart it with new input runs a restart as the next turn:
position 1, with the running turn stopped ("Stopped to send a new message",
`O:7600-7628`). Providers with interrupt-restart restart the same run on a new
attempt of reason `steering_restart`.

**Recovery.** A run that is `running` or `starting` but has no provider turn
on any attempt is rewound (`rewindUnacceptedRuns`, `PRRS:220-280`). The user's
own such runs return to the queue at the front. Every queued run is held
(`PRRS:563-603`). Unread steers are requeued at boot (`O:16572-16590`).
Unattended prompts are resent at most three times when restart continuation
is enabled (`PRRS:62`, `:477-498`).

**Clients.**

- Web shows two rows and "Show all" once more than three items wait
  (`QUEUE_VISIBLE_ROWS = 3`, `apps/web/src/components/chat/QueuedRunsControl.tsx:60`,
  `:250-251`), with a polite live region (`:263`).
- Mobile offers steer, edit, remove and a "Queue paused" banner with Resume
  (`apps/mobile/src/features/threads/ThreadQueueControl.tsx:241-256`).
- No client reorders; only the agent tool does.

## 2. Target model

### 2.1 Queue items: a V2 run in `queued`, if the spike proves it

T3 models a queued message as a queued run. Inertia's earlier design kept
separate `queue-item` entities, because the compatibility transcript allows
one non-terminal turn per chat and G8 assigns dense ordinals at admission.
Both are recorded choices, not invariants (decision 4.7). Package 1 therefore
**starts with a spike** that decides the model.

**Shape of the spike.** A prototype of about 4–5 days on a throwaway branch,
with rebuild and verify tests. A read-only audit cannot answer questions 5
and 8. At day 2 there is a checkpoint: a table of every reader and writer of
`run` entities, plus answers from reading to questions 3, 4, 6, 7, 9 and 10.
If the audit finds a blocker, the spike stops and package 1 takes the
separate-entity model.

**The ten questions.**

1. **Queued runs on any chat.** Can the projector accept a new `run.queued`
   event? It would create `run` and `attempt` entities with `status: queued`,
   `queuePosition`, `queueHeld`, no `ordinal`, and a reserved
   `turnId`/`messageId`. This must work on an idle chat (held items exist
   with no active run, so `activeRunId` is null) as well as behind an active
   run. It must leave `activeRunId`, `latestRunId` and `lastRunOrdinal`
   alone. Today `run.accepted` refuses whenever `activeRunId !== null` and
   assigns the ordinal (`projector.ts:59-90`).
2. **Start event.** Can a separate start event take that run? (`run.accepted`
   refuses an existing run id, `projector.ts:73`.) It must:
   - assign `ordinal = lastRunOrdinal + 1`, which is dense and equals T3's
     renumbered ordinal whenever anything started ahead;
   - set `activeRunId` and keep the `cleanup-pending` refusal (`:63-71`);
   - write the compatibility turn and message rows in the same transaction,
     as `admit()` does today (`turn-repository.ts:118-140`).
3. **Run readers.** Do run readers stay correct while queued runs exist?
   - Readers that join from `agent_turns` stay blind to a run without a turn
     row: `backing-repository.ts:93`, `:143`; `missed-run-attachments.ts:47`,
     `:56`, `:100`; `turn-repository.ts:345`, `:549`.
   - `merge-back-repository.ts:350` joins through the merge-back payload's
     `runId`. It is safe only while no merge-back names a queued run; prove
     that.
   - Readers that read runs without the turn join must be listed and fixed:
     `delegation-reads.ts:242`, `:288`; `run-control-repository.ts`
     `activeTarget`.
4. **Message references.** Does anything dereference `run.messageId` before
   the run starts? The text stays in `queued_messages` until start (N17).
5. **Rebuild.** `rebuildProjections` deletes and replays only
   `orchestration_v2_entities`, and its compatibility callback rebuilds only
   the delegation index (`event-store.ts:255-268`,
   `delegation-repository.ts:400-402`). `queued_messages` is never touched.
   Do replayed queued runs agree with the surviving rows (state, position,
   hold, revision)? Does the N17 verify check catch every disagreement?
6. **Admission checks against package 3.** `run.accepted` requires the run's
   `selection`, `providerId` and `workspaceKey` to equal the thread's
   (`projector.ts:74-77`), and `thread.configured` is refused while a run is
   active (`:56-58`). A queued run that carries its own selection (package 3)
   must start through a check that applies the item's selection first. Design
   the start event so package 3 does not reopen it.
7. **Fork copies.** Fork history copies messages by turn, with no exclusion
   for queued input (`fork-history.ts:38-44`). T3 keeps undelivered queued
   input out of forks (`ProjectionStore.test.ts:11343`). Show that neither
   queued runs nor unread follow-up messages still in their ended turn are
   copied. The second case exists today (correction C2).
8. **G6 verify.** Readable kinds parse `thread`, `run` and `attempt` with the
   strict schemas (`turn-repository.ts:69-73`). A queued run must parse:
   `ordinal` is optional, while `turnId`, `messageId` and `attemptId` are
   required. Define how verify treats a queued run whose content row is
   missing (N17). Exclude deleted conversations: their rows cascade away
   while V2 entities stay.
9. **Delegation planner and recovery.** The planner writes the delegated row
   as the compatibility projection of `delegation.*` events
   (`delegation-delivery-planner.ts:150-180`). Recovery and reads use
   `queued_messages.turn_id` (`delegation-reads.ts:303`, `:315`;
   `task-service.ts:257`, `:405`). Can the planner create a queued run in the
   same transaction, and can recovery find it without the row?
10. **Taking over an existing message.** Unread follow-up rows and the
    crash-after-admission requeue (2.9) name an **existing**
    `user_message_id` from an ended turn, where questions 1 and 4 assume a
    freshly reserved id. Can a queued run point at a message that belongs to
    another, ended run, and can its start move that message into the new
    turn in one transaction? T3 re-dispatches the same message id into a new
    run (`O:3551-3570`).

    `adoptUnreadFollowUp`'s guard refuses a turn's own prompt
    (`turn-ledger-repository.ts:382`). That is right for unread follow-ups,
    but the crash requeue names exactly that prompt. It therefore uses a
    separate `adoptUndeliveredPrompt`:
    - it moves a turn's own prompt only when the turn's run has
      `delivery: not-delivered` and no provider-turn observation on any
      attempt;
    - in the same transaction it retires the emptied turn as superseded:
      hidden from the transcript and skipped by the missed-history and
      missed-image walks.

    If the retired-turn marker cannot be made rebuild-safe, the fallback is
    to requeue by copy (a new message with the same text). The old message is
    then excluded from missed history through `requeued_from_message_id`, and
    both turns stay visible. That fallback is a recorded deviation.

**Outcome.** If all ten answers are yes, a queued item **is** a V2 run in
`queued`, as in T3. If any is no, a separate `queue-item` entity is kept, as a
recorded difference that names the failed question. Either way:

- items use **T3's field names exactly** (2.2);
- runs get dense ordinals at start;
- the run records `requestedAt` from enqueue, so queue wait stays measurable
  (T3 `RunMetrics.test.ts:74`).

Queued items have no ordinal before start. T3's
`steerFollowUpAfterRunOrdinal` placement ("after the runs queued before the
steer", `O:7985-8000`) is therefore computed on submission order:
`requestedAt`, then sequence. The unread follow-up rows already do this. The
recorded G8 ordinal choice forces the adaptation.

### 2.2 Item shape, hold model and order

```
queued item (V2 run in `queued`, or queue-item entity: same fields)
  id                        // client-supplied uuid
  threadId, projectId
  userMessageId             // reserved at enqueue, or an existing message (2.1 Q10)
  createdBy: "user" | "agent" | "system"          // T3 OrchestrationV2Actor
  creationSource: "web" | "mobile" | "mcp" | "server"
                            // desktop renderer = "web", Private Connect device = "mobile",
                            // agent tool = "mcp", runtime owners = "server"
  deviceId?                 // Inertia only; set by the server for "mobile"
  steerFollowUpOfRunId?     // requeue marker: a requeued unread follow-up or declined steer;
                            // it keeps its message's own createdBy/creationSource (O:3557, :3568-3569)
  contentRef: { chars, editRevision }, attachmentIds   // N17; text lives in queued_messages
  modelSelection, providerInstanceId                   // package 3; route identity until then
  followsThreadSelection?: true                        // C:1437
  queuePosition: number | null                         // C:777
  queueHeld?: boolean                                  // C:778; per item, no stored reason
  steerWhenReadyRunId?                                 // C:779 (N1)
  freshContext?: true                                  // C:802; dormant (N6)
  requestedAt, editRevision, editedAt
  state (compatibility row): waiting | dispatching | blocked | accepted | cancelled
  blockedReason?, detail?
  dispatchOrdinal                                      // claims so far (2.4)
  delivery?: { mode: "run" | "steer" | "after-stop", outcome?: "restarted",
               runId, attemptId, turnId, messageId, steerEffectId?, deliveredAt }
  attribution?: watcherNote | delegatedCompletion
```

T3 uses `creationSource: "provider"` together with `createdBy: "agent"` and a
notification for a buffered provider wake (`NotificationMailbox.ts:8-19`).
Inertia has no buffered wakes, so `provider` is unused.

**Selection at the pin.** These follow the thread's selection at start:

- delegated completions;
- monitor notices (watcher notes);
- scheduled deliveries without a model, via `followsThreadSelection`
  (`followsCurrentConversation`, `O:1026-1043`; `O:8101-8103`).

Other items behave as follows:

- An item that names no model takes the queue tail's selection
  (`queueTailModelSelection`, `O:1056-1067`, used at `O:7844`). This includes
  agent items.
- A requeued unread follow-up carries the steer's or the ended run's selection
  (`O:3559`).

There is no access ceiling on an item: a queued item runs under the chat's
access and interaction mode at its start (decision 4.3).

**Hold model.** There is no thread-level hold, no stored hold reason and no
"skip the hold" field. The reason shown to the user ("Stopped", "Provider
failed", "Restart", "Usage limit") is derived for display from the thread's
latest run.

An item becomes held through these rules:

- **H1, Stop.** Stop holds every queued run that is not a buffered wake
  (`O:13135-13165`). A Stop that changes nothing writes no events
  (`ThreadStop.test.ts:895`, `:915`).
- **H2, inherited at creation.** A new queued run is created held when any
  queued run is held (`queueIsHeld`, `O:7971-7973`; `O:8023-8031`). It is not
  held when the same command releases holds (R1), when it is a buffered wake
  (`O:7976-7980`), or when it is the stop-and-send run (`skipsHeldQueue`,
  `O:7621-7627`).
- **H3, created held.** A run whose worktree is missing is created held, and
  so is a declined steer's follow-up whose source run was cancelled
  (`O:8025-8026`).
- **H4, failure at start.** A provider failure on the same instance, a
  disabled instance or a missing worktree at queued start holds every queued
  run except wakes (`O:2579-2606`).
- **H5, restart.** Recovery holds every queued run (`PRRS:592-603`).
- **H6, busy replaced session (package 3).** When a queued start needs a
  provider switch of type `restart_and_resume`, and the replaced session
  still runs background work, every queued run is held (`O:2775-2804`).
  Nothing releases it by itself; any of R1–R4 does. In packages 1–2 no
  switch happens at queued start.
- **Usage limit.** The usage-limit hold is computed, not stored
  (`usageLimitHoldsQueue`, `O:1074`; decision N8).

A hold is released through these rules, none of which needs a stored reason:

- **R1, a user's client send.** A message with `createdBy: user`, a
  `web`/`mobile` source, no `scheduledTaskId` and no `steerFollowUpOfRunId`
  that starts or queues releases every held run, except while workspace
  setup is unresolved (`O:7849-7870`). A `turn-ended` composer steer is
  re-dispatched with its message's own source and without
  `steerFollowUpOfRunId` (`EW:383-420`), so it releases too.
- **R2, a later run completes.** When the newest executed run completes, was
  not stopped, and workspace setup is not pending, held agent, server and
  scheduled items are released. The user's own items never are
  (`releaseUnattendedHolds`, `O:3407-3450`; test `runtimeLayer.test.ts:9225`).
- **R3, Resume.** `queue.resume` and `queued-run.start` release every queued
  run (`O:15766-15777`).
- **R4, preparation retry.** Retrying a failed preparation releases every held
  run while the failed run is still the latest executed one; once a newer run
  exists it releases nothing (`O:12574-12584`). In Inertia this is the
  isolated-workspace retry (N9).

Two cases start past a held queue:

- **P1.** An agent's or scheduled send to an idle chat with a held queue starts
  at once, past the held items, which stay held (`ThreadStop.test.ts:714`, at
  `:739-776`).
- **P2.** A user's client send to such a chat starts, and the released items
  follow it (`:788-799`).

In Inertia, R1's "client send" is the desktop renderer (`web`) or a Private
Connect device (`mobile`). Managed sends, watcher, delegation, limit-reset and
requeued items never release.

**Order.** Delivery order is a pure function, tested on its own: T3 `QRO:13-50`.
A blocked watcher note is skipped, and a blocked user item stops the queue
until it is sent, edited or removed. A watcher note whose source review is
stale is cancelled at queued start (decision 4.2).

**Caps** (decision 4.1):

- 20 user plus agent items;
- one delegated delivery;
- watcher notes: at most one waiting note per watcher, five in total.

Requeued items (carrying the requeue marker) do not count.

### 2.3 Events

All are thread events committed through the existing event store. The
`queued_messages` row is written in the same transaction, as the
compatibility projection and as the content store (N17), which is the pattern
Phase 4 uses for delegated rows. No event carries message text or a digest of
it.

| Event | Written by | Effect |
| --- | --- | --- |
| `queue.item-enqueued` | enqueue, refused follow-up, unread follow-up at settlement, watcher, delegation planner, managed send `mode: queue`, Private Connect | New item with `contentRef` and `attachmentIds`. Position: end of the queue; position 1 for stop-and-send; for a declined steer or unread follow-up, after the items queued before the steer (N2). Created held under H2/H3 |
| `queue.item-edited` | edit | New `contentRef`, attachments and optionally selection; bumps `editRevision` |
| `queue.reordered` | reorder (server command; no client offers it, N13) | Full new order, bounded by the caps |
| `queue.item-cancelled` | remove, delegation withdrawal, watcher coalescing, stale drop | Terminal; reason `user`, `withdrawn`, `superseded`, `stale` |
| `queue.items-held` | Stop, inherited, created held, failure at start, restart, busy session | `queueHeld: true` on the listed items, cause H1–H6. Nothing is written when nothing changes |
| `queue.items-released` | user send, run completed, Resume, preparation retry | `queueHeld: false` on the listed items, cause R1–R4 |
| `queue.send-requested` | Send now, Resume while not yet dispatchable | Durable manual intent; replaces `manualRetries` |
| `queue.item-claimed` | dispatcher | `dispatching`, `dispatchOrdinal + 1`, mode |
| `queue.item-released` | dispatcher, boot | Back to `waiting`; reason `transient`, `runtime-lost`, `steer-declined`, `turn-ended` |
| `queue.item-blocked` | dispatcher, verify | `blocked`, with reason and public detail |
| `queue.item-delivered` | run admission, steer settlement | Terminal; full delivery attribution |
| `queue.item-requeued` | boot reconciliation | A delivered item whose run never reached the provider goes back to the front, held (2.9) |
| `run-control.steer-read` | steer settlement path | The provider read an accepted steer (Claude lifecycle `started`). This durable read mark replaces the in-memory `unreadFollowUpMessageIds` as the source for requeue at settlement and at boot |

`run.accepted` (or the spike's start event) adds `queueItemId` and
`afterStopOf` (the run that stop-and-send stopped).
`run-control.steer-requested` already carries the queued message id. The
interrupt that stop-and-send records carries the reason "Stopped to send a new
message" (T3 `O:7625`).

### 2.4 Commands, receipts and identities

The existing commands keep their names and gain real events. New commands:

- `message.queue.edit {conversationId, id, expectedRevision, content,
  attachments?, selection?}`: refused for automatic kinds and for items no
  longer `waiting` or `blocked` (T3 `O:12091`).
- `message.queue.reorder {conversationId, id, beforeId | null}`: refuses to
  move an automatic item or to place anything ahead of a delegated delivery
  (T3 `O:11945-11981`). It exists for the later agent queue tool; no client
  offers it (N13).
- `message.queue.resume {conversationId}`: Resume (N7).

**Identities.**

- Every user command is receipted under `human` with the renderer's request
  id, and device commands under `device:<id>`.
- Internal dispatch uses `queue:<item id>:<dispatchOrdinal>`, and the
  admitted message id is fixed at claim time. Each dispatch attempt has its
  own identity, a replay of the same attempt is idempotent, and a later retry
  of a released item can never be answered by an earlier attempt's receipt.
  This is Inertia's form of T3's per-dispatch start effect ids (`737afe24b`).
- A deferred steer is delivered under
  `queue:<item id>:steer-when-ready:<run id>:<attempt id>`, Inertia's form of
  T3's `command:deferred-steer:<queued>:<run>:<attempt>` (`O:16404`).
- The managed-send queue path commits through the command authority under
  `runtime`, with `agent-queue:<operation id>` from the host-tool
  reservation, so a replayed tool call returns the original answer. The item
  has `createdBy: "agent"` and `creationSource: "mcp"`.
- A requeued unread follow-up uses `unread-follow-up:<turn id>:<message id>`
  (T3 `command:unread-steer:<run>:<message>`, `O:3554`).

Refusals keep G5's rule: internal dispatch never records a rejected receipt,
and user commands record only deterministic, non-user-correctable refusals.

**Receipt fingerprints carry no text (N17).** From package 1, queue commands
(enqueue, edit, stop-and-send, managed `mode: queue`) and send commands are
fingerprinted over a canonical form in which `content` is replaced by
`{chars}` and attachments by their ids. A replay with the same id and form
returns the original answer only after a **text check** against the row the
command created; a mismatch is `command-conflict`.

| Command | What the text check compares |
| --- | --- |
| Enqueue | The row's `creation_digest` (digest at enqueue, never rewritten). Edits rewrite `intent_digest`, so a replay of the original enqueue after an edit still succeeds |
| Edit | `intent_digest`, but only while the row's `edit_revision` still equals the revision this edit produced. After a later edit, the check falls back to length |
| Direct send | The admitted message's content |

Rules for the check:

- A concurrent same-id duplicate joins the first command on the fingerprint
  alone (`command-authority.ts:73-77`), so the joined path runs the same row
  check after `await start.result` (`queued-message-runtime.ts:518-520`).
- A receipt whose queue row was pruned at 50 falls back to a length check,
  which is acceptable because request ids are fresh UUIDs.
- No column marks a receipt as written before the upgrade. Replays of these
  command types therefore accept either fingerprint form (the old
  full-command hash or the new text-free one); a mismatch with both is
  `command-conflict`.
- Receipts of other command types replay unchanged.

**Receipts are purged on deletion.** Once a chat is gone, a replay that
targets it is refused anyway, so idempotency loses nothing.

- Conversation delete (`conversation-repository.ts:364`) deletes
  `orchestration_v2_receipts WHERE thread_id = ?` in its transaction.
- Project delete (`project-repository.ts:157`) cascades to `conversations`
  without passing through the conversation delete, so `remove()` also
  deletes `orchestration_v2_receipts WHERE project_id = ?` in its
  transaction.
- Migration 127 deletes receipts of chats deleted before the upgrade (2.10).

### 2.5 Steering and the interrupt/restart fallback

Send now on a running chat resolves like T3's `resolveDeliveryIntent`
(`CP:186-224`) and `resolveMessageDispatchIntent` (`CP:104-126`). Inertia's
stop-and-send takes the place of T3's same-run `interrupt_restart`.

1. **Direct steer.** The steer is direct when the active run's harness can
   steer (decision 4.9) and nothing forces a restart. That means the item's
   selection is on the run's provider instance and can apply on the next
   turn, and any attachments are accepted by the steer
   (`steerAcceptsAttachments`). The runtime commits
   `queue.item-claimed (mode steer)` and G5's `run-control.steer-requested`
   with its `provider.steer` effect. The outcome decides what happens next:
   - `accepted` delivers the item.
   - `refused` (declined) re-enqueues it after the items queued before the
     steer's first effect (N2). T3 passes the placement only when declined
     (`EW:383-396`, applied at `O:7985-8000`).
   - `turn-ended` re-dispatches it as a start. It waits behind every unheld
     item (`O:15953-15969`) and, being the user's own client send, releases
     every held item (R1). It does not keep its place; placement for
     `turn-ended` is T3 `main` only (section 6).
   - `unconfirmed` and `unavailable` block the item, as today.

   While the run is preparing, or running without a provider turn, the item
   is stored with `steerWhenReadyRunId` and steered when the provider turn
   starts (N1).
2. **Stop and send.** When a restart is forced, or the harness cannot steer
   but can interrupt, Send now uses the stop-and-send mechanism (decision
   4.6): the run is stopped and the item runs next. The renderer labels the
   action **Stop and send**, so the user sees what will happen before
   choosing it.

   Exception: the only reason for the restart may be that the item's
   selection is on another provider instance, on a target harness that
   cannot interrupt-restart. T3's test is `providerSwitchWaitsForTurn` =
   `supportsQueuedMessages && !(supportsInterrupt &&
   supportsSteeringByInterruptRestart)` (`CP:161-168`); today that means
   Claude and Pi. Then the item queues behind the turn, and the action is
   labelled as queueing. Codex, OpenCode and Cursor SDK keep stop-and-send.
3. **Refusal.** When the harness can neither steer nor interrupt, Send now is
   refused, as T3 refuses.
4. **Execution and Stop.** Provider steers are executed by the effect
   dispatcher's `provider.steer` handler, not claimed in-process (package 2).
   A steer into a run that Stop reached is refused (T3 test
   `SteeringCompletion.integration.test.ts:2801`). An accepted steer still
   unread when Stop ends the run is cancelled, and leaves the notice "Steer
   delivery not confirmed" with its text (`O:3484-3524`; N14).

**Composer submissions.** A composer submission while a run is active (T3
`deliveryIntent: "auto"`) steers when step 1 applies and otherwise queues
behind the turn. Where T3 would force a same-run restart for an automatic send
(a selection that must apply now, or attachments a steer does not accept),
Inertia queues instead (section 5). A message that is native maintenance (T3
`isNativeMaintenanceCommand`, `CP:73`, applied at `CP:111-115`) never takes a
steer.

Delegated deliveries move from the direct `turns.steer` call to the same
`provider.steer` effect, which closes the G5 follow-up. Steering during
automatic compaction follows N4.

### 2.6 Automatic-result priority and dispatcher precedence

**At a turn boundary**, a waiting limit-reset resume runs first, because the
queue stays held after a failed turn (T3 `cbb0417df`). The queue follows in
delivery order (`QRO:13-50`):

- delegated deliveries and the other items each keep their own order;
- the two lists merge by request time, with a delivery winning a tie;
- the request time of Inertia's coalesced per-conversation delivery is that
  of its earliest undelivered completion;
- a stop-and-send item is stamped with the time of the Send, so results that
  arrived before it still go first.

Watcher notes are not a class after user items (decision 4.2). A restart
continuation keeps today's rule: it is not planned while items wait, and an
app-update interrupt releases the queue instead.

**Settlement order** follows T3 (`O:16285-16305`): R2 first, then requeue of
unread steers, then start the next item. An agent's requeued unread steer is
therefore created held under H2 while any user item is still held.

**Manual Send.** Send now on a chosen item starts that item. `queued-run.start`
starts the selected item, refuses automatic items, and refuses while any run
is active ("A queued user message can only be sent now while the thread is
stopped.", `O:15719-15740`). On a running chat, Send now is a steer (2.5). A
Send to an idle chat while unheld items wait starts the next item first, and
the new message waits behind it; restart continuations are exempt
(`O:15953-15969`). The Phase 4 rule "a manual Send of a user item dispatches
a waiting delegated delivery first" is dropped: it was never T3's, and no
invariant requires it. The drain after settlement is asynchronous today, so
package 2 needs a race test for that gap.

Holds follow H1–H6, R1–R4 and P1–P2 (2.2).

### 2.7 Configuration changes while running

Follows T3 (decision 4.8). A provider, model, effort, interaction-mode or
access-mode change on a running chat is accepted and committed to the chat at
once, as T3's `thread.model-selection.set`, `thread.runtime-mode.set` and
`thread.interaction-mode.set` are. The active run keeps the selection it
started with. Queued items:

- an item enqueued with a selection keeps it;
- an item enqueued without one takes the selection of the last queued item
  that has one, else the chat's current selection (T3
  `queueTailModelSelection`, `O:1056-1067`, used at `O:7844`);
- delegated completions, watcher notes and scheduled deliveries without a
  model take the chat's selection at their start (`O:1026-1053`,
  `O:8101-8103`);
- a promoted item steers with its own selection (T3 `a732caa7d`);
- a requeued unread follow-up keeps the steer's or the ended run's selection
  (`O:3559`).

Ordered configuration changes therefore ride on items. When item 1 runs under
model A and item 2 under model B, the switch happens at item 2's start,
through the existing provider switch and backing path. A switch whose replaced
session still has background work holds the queue instead of ending that work
(H6, T3 `6049196c5`). There are no configuration-only queue rows. A mode
change restarts a stalled queue, as T3 does.

Applying effort and flags live to a running turn is a separate provider item
per adapter, with portable fixtures: Claude effort and flags (T3 `d6e5f2e06`,
`5984bbb36`), and Codex `serviceTier` through `thread/settings/update` (T3
`8009cd8c3`, `ea6d3fc30`). Until an adapter has it, such a change takes effect
on the next run.

### 2.8 Projections and publication

The queue is projected by a new `src/server/orchestration-v2/queue-projector.ts`
(or by the run projector, if the spike adopts queued runs), and the projection
version increases by one.

- The `message.queue` result gains `position`, `editRevision`, `selection`,
  `queueHeld`, a derived `holdReason`, `delivery`, `steerWhenReady` and
  `editable` flags. The caps follow decision 4.1.
- The server pushes a `conversation.queue.changed {conversationId, revision}`
  event so the renderer stops polling. This is a narrow slice of L4, not
  general V2 publication.
- Queue rows stay off the token stream.

### 2.9 Crash and restart

Boot reconciliation runs before admission, per chat, in one lane section. It
follows T3 `rewindUnacceptedRuns` and recovery (`PRRS:220-280`, `:563-603`):

- **`dispatching` with no accepted run:** `queue.item-released (runtime-lost)`.
- **"Never reached the provider"** means that no attempt of the run has a
  provider-turn observation and none has a pending request. It is never
  decided from the turn status, because a run is marked running before its
  provider accepts the prompt.
- **Crash after admission, before provider start.** The run is ended
  (`interrupted`, `delivery: not-delivered`). Its compatibility turn and
  message rows stay. The user item is requeued at the **front**, held,
  ahead of items already waiting, in original order. It names that message,
  so re-admission moves it into the new turn through
  `adoptUndeliveredPrompt`, and the emptied turn is retired as superseded
  (2.1 Q10). The text is never duplicated in the transcript or in missed
  history. The ended turn's `checkpoint.capture-requested` effect is
  replay-safe, so the turn is captured with no file changes. T3 instead
  rewinds the same run to `queued` (`PRRS:264-268`, `:563-603`).
- **Unread follow-ups.** An accepted steer with no `run-control.steer-read`
  mark, on a run that boot ends, is requeued at its N2 place in the same lane
  section (T3 `O:16572-16590`; test `ProviderRuntimeRecoveryService.test.ts:422`).
- **Unattended prompts** that never reached the provider (agent-sent, and
  scheduled once it exists) are resent after boot, as T3 does when restart
  continuation is on (`command:restart-resend:<run>`, `PRRS:477-498`):
  - at most three times (`MAX_RESENDS`, `PRRS:62`);
  - never after a Stop recorded on the run or on its delegating run;
  - each resend is a new attempt, admitted only after boot confirms cleanup,
    so no same-run restart is written.

  This is the recovery phase; package 2 only records the marks.
- **The whole queue is held** (H5).
- **Automatic items** are not requeued; their owners (delegation recovery,
  watcher) re-plan. An unsent usage-limit resume gets a fresh request id in
  the recovery phase (T3 `240446e2d`).
- **A steer whose effect was retired as `runtime-lost`** blocks the item with
  the existing "did not confirm" detail; it is never resent.
- **A `queue.send-requested` intent without a later claim** stays recorded
  but starts nothing; the restart hold wins until the user resumes (T3
  `runtimeLayer.test.ts:10879`).
- **Requeued items over the cap.** A requeued item is admitted even when it
  takes the queue over the cap; the cap bounds enqueue.

**Stop before acceptance.** A run the user stopped before its provider
accepted the turn keeps today's rule. At the pin, a Stop during a pending
provider start ends the run `interrupted` with no provider turns
(`runtimeLayer.test.ts:11586`, assertions at `:11643-11653`). Such runs are
missed runs, and their history and images ride on the next prompt
(`PTS:1149-1155`; `prepareRetryHandoff`, `PTS:1182-1210`; images at
`PTS:2002-2025`). Inertia handles harnesses in two ways:

- **Codex**, the only harness that declares `turn-acceptance`, marks the run
  `not-delivered` and resends its text, which matches T3. Its images are
  carried once correction C1 lands.
- **Other harnesses** credit prompts they never confirmed, so nothing is
  resent where T3 would resend (the recorded open item at `IP:3372`).

### 2.10 Migrations

After the sync onto `main`'s 119, the branch holds migrations 120–126
(`OrchestrationV2EventStore` through
`OrchestrationV2ReceiptStatusAndProjectionMetadata`,
`database-migration-lineage.json`). Phase 5 starts at **127**.

**127 `PersistQueueItemOrderAndDelivery`** (package 1). It adds nullable or
defaulted columns to `queued_messages`, so no table rebuild is needed:

- `queue_position INTEGER` and `queue_held INTEGER NOT NULL DEFAULT 0`;
- `kind TEXT CHECK (kind IN ('message','watcher-note','delegated-results'))`,
  backfilled from the attribution columns;
- `created_by TEXT` and `creation_source TEXT`, with CHECKs on the T3
  literal sets;
- `steer_follow_up_of_run_id TEXT`, the requeue marker;
- `edit_revision INTEGER NOT NULL DEFAULT 0`, `edited_at TEXT` and
  `creation_digest TEXT`;
- `dispatch_ordinal INTEGER NOT NULL DEFAULT 0` and `run_id TEXT`;
- `delivery_mode TEXT CHECK (delivery_mode IS NULL OR delivery_mode IN
  ('run','steer','after-stop'))`;
- `steer_when_ready_run_id TEXT`.

It backfills, in order:

- `queue_position` for active rows other than delegated deliveries, by
  submission order. A delegated delivery is ordered by its request time and
  needs no position.
- `creation_digest` from `intent_digest`.
- For unread follow-up rows (`user_message_id` set):
  - `steer_follow_up_of_run_id` from the run of the turn that holds the named
    message (`messages.turn_id`);
  - `created_by`/`creation_source` from the named message's own attribution.

It adds an index on `(conversation_id, state, queue_position)`. The `state`
CHECK is unchanged: "held" is a column and "delivered" stays `accepted` in the
table.

In the same transaction, 127 deletes receipts of chats deleted before the
upgrade:

- It deletes receipts whose `thread_id` is a registered V2 thread (a
  `thread.registered` event exists, so the id is proven to be a conversation
  id) and matches no row in `conversations`.
- Receipts whose `thread_id` is neither are left alone and counted in the
  migration test. None is expected: every `authority.begin` and `reject` call
  passes a conversation id.

**128 `PersistQueueItemSelection`** (package 3). It adds `selection_json`
(JSON-valid, bounded). There is no `access_ceiling` column (decision 4.3).
Existing rows get a selection derived from their `route_identity` when it
still parses, else `NULL`, which the runtime resolves as "follow the queue
tail" for a user item. If packages 1 and 3 land in the same checkpoint, fold
128 into 127.

**Rules for both.** Both are transactional and append-only. V2 events for
legacy active rows are not written by SQL: at boot an idempotent adoption
commits `queue.item-enqueued (origin legacy)` under `queue-adopt:<item id>`,
before scheduling. Tests use a representative fixture at migration 126 with:

- waiting, blocked, dispatching, accepted and cancelled rows;
- a watcher note, a delegated row, unread follow-up rows (waiting and
  blocked), a managed-send `mode: queue` row and image attachments;
- receipts of a live chat, a deleted chat and a deleted project.

They check that a rebuild reproduces the same entities.

## 3. Packages

Order: **1 core → 2 runtime → 3 per-item model → 4 integrations → 5
renderer**.

- Package 1 starts after the main sync, because it owns migration 127.
- Package 2 starts after package 1 is merged, after the smoke session (3.0)
  and after G9 has landed.
- Package 5 can start its list and edit slices after package 2. Its model chip
  waits for package 3, and its Private Connect slice for package 4.

### 3.0 Process

- Packages 1 and 2 are **serial**, with one owner each.
- Before any code that touches queue, delivery or settlement, the package has
  a one-page **failure matrix**:
  [package 1](phase5-failure-matrix-pkg1.md),
  [package 2](phase5-failure-matrix-pkg2.md).
- **T3's own tests are the acceptance list**
  ([phase5-acceptance-pkg1-2.md](phase5-acceptance-pkg1-2.md)). A skipped case
  needs a written reason.
- **No in-memory state outlives a lane section.** In-process caches rebuilt
  from durable state at the start of each section are allowed. Package 2
  removes:
  - `manualRetries`, `again`, `deferred` and `recovering`
    (`queued-message-runtime.ts:62-67`). Boot reconciliation runs inside the
    lane section (2.9).
  - G5's `#claims` and `#waiters`.
  - The turn-held `unreadFollowUpMessageIds` and `followUpMessagesBySteerId`
    as the source of truth.

  The per-chat drain promises (`running`, `enqueueing`) stay only as wake-ups
  whose work is recomputed from the database.
- **One signed commit per behaviour**: each acceptance row lands in one commit
  with its tests.
- **Live-provider smoke session before package 2.** Each result is recorded
  with its observed event sequence, so it can become a portable fixture. It
  covers at least:
  - a Claude follow-up that is cancelled, discarded or refused before it is
    read, and the read mark;
  - a Codex steer that is accepted, and one that hits `turn-ended`;
  - Stop before provider acceptance on Codex, Claude, OpenCode, Pi and Cursor
    SDK, with the terminal status and delivery each reports (the gate for C1
    on non-Codex harnesses);
  - Stop confirmation time and outcome per provider;
  - stop and send on Claude and on Codex.

  Secrets stay in the vault; only redacted fixtures are committed.

### Package 1: core

**Scope:**

- the §2.1 spike;
- queued items (runs or entities, per the spike), the event family and the
  projector;
- the FIFO delivery order function;
- caps and per-watcher coalescing;
- edit, cancel, reorder and send-intent commands, and the per-item hold and
  release events;
- the compatibility projection and content store (N17);
- text-free receipt fingerprints and the receipt purges (2.4);
- migration 127 and boot adoption;
- the new dispatch identity scheme (definitions only).

**Files likely touched:**

- new `src/shared/orchestration-queue.ts`;
- `src/shared/orchestration-v2.ts` (event union);
- new `src/server/orchestration-v2/queue-projector.ts` and
  `queue-repository.ts`;
- `projector.ts` (version, dispatch), `command-authority.ts`, `json.ts`;
- `src/shared/queued-messages.ts` and
  `src/shared/contracts/client-command/agent.ts`;
- `src/server/persistence/queued-message-repository.ts`,
  `conversation-repository.ts` and `project-repository.ts`;
- new `src/server/persistence/migrations/queue-items.ts`,
  `recent-migrations.ts`, `database-migration-lineage.json` and
  `database-recovery-required-tables.ts`.

**Tests:** a new `tests/server/orchestration-queue-core.test.ts`; the
migration fixture in `tests/server/database-migrations.test.ts`; receipts in
`orchestration-command-authority.test.ts`.

**Acceptance** (full list in
[phase5-acceptance-pkg1-2.md](phase5-acceptance-pkg1-2.md)):

- **Delivery order.** Delegated deliveries and the other items, each in their
  own order, merge by request time, with a delivery winning a tie. Watcher
  notes are ordinary items, and a blocked watcher note is skipped (port of T3
  `QueuedRunOrder.test.ts:14`).
- **Reorder** refuses automatic items and positions ahead of delegated
  results (T3 `O:11945-11981`; T3 has no test, so the test is written from
  that code). Reorder of a dispatched item is refused.
- **Edit.** A stale `expectedRevision` is refused, as is an edit of a
  dispatching item. An edit replaces attachments only when given.
- **Replay.** An exact replay of every command returns the original answer and
  writes nothing. A different payload under the same id is
  `command-conflict`, and so is different text with the same length, through
  the row's text check. This holds for a concurrent duplicate that joins too.
- **Caps** hold under concurrent enqueues: 20 user plus agent items, one
  delegated delivery, one waiting note per watcher (a newer note supersedes
  the older) and five watcher notes in total. Requeues are exempt.
- **Holds** follow H1–H5 and R1–R4.
- **Queue events never carry text.** Deleting a chat or a project deletes its
  receipts, and migration 127 removes those of chats deleted earlier.
- **G6 verify** flags a non-terminal item whose row is missing or whose
  `chars`/`editRevision` disagree. Terminal rows pruned at 50, and items of
  deleted chats, are not flagged.
- **Upgrade.** Upgrading from the 126 fixture, plus boot adoption, yields the
  queue the old repository listed, in FIFO positions; a rebuild reproduces it.
- **The spike's ten answers** and its reader table are recorded in the
  progress log, with the model chosen.

### Package 2: runtime

**Scope:**

- rewrite `queued-message-runtime.ts` on the core: claim with
  `queue:<item>:<n>`, `queueItemId` on the run, delivery attribution;
- steer through `provider.steer`;
- durable Send now, hold and Resume (N7);
- stop-and-send at position 1 for every provider, with T3's edge rules (4.6);
- deferred steer (N1) and declined-steer placement (N2);
- the failed-workspace-setup hold (N9);
- boot reconciliation (2.9) and dispatcher precedence (2.6);
- the effect dispatcher executes `provider.interrupt` (Stop) and
  `provider.steer`, with the 30 s slot detachment (T3 `EW:1047`, `:1078`) and
  a per-kind running cap (T3 `maxRunningTitleGenerations`, `EW:1064`). Both
  land before the handlers are registered;
- the durable steer-read mark, requeue of unread follow-ups at settlement and
  at boot, and the "Steer delivery not confirmed" notice (N14);
- the managed-send contract from #761 (N19), including N10 and `0a159c9fb`;
- the hold model H1–H5, R1–R4, P1–P2;
- correction C2.

**Files:**

- `src/server/runtime/queued-message-runtime.ts`, `managed-send-modes.ts`,
  `agent-thread-manager.ts` (send modes only);
- `commands/message-send-command.ts`, `message-follow-up-command.ts`,
  `message-send-support.ts`, `agent-stop-command.ts`;
- `src/server/runtime/turns/turn-follow-up-coordinator.ts`;
- `src/server/persistence/turn-ledger-repository.ts` (`adoptUndeliveredPrompt`)
  and `transcript-repository.ts`;
- `src/server/orchestration-v2/turn-repository.ts`,
  `run-control-repository.ts`, `effect-outbox.ts`, `effect-runtime.ts`,
  `fork-history.ts`;
- `restart-continuation-scheduler.ts`;
- `src/server/index.ts` (boot order).

**Tests:**

- extend `tests/server/queued-message-runtime.test.ts`,
  `follow-up-delivery-uncertainty.test.ts`,
  `turn-restart-continuation.test.ts`, `limit-reset-turn-dispatch.test.ts`,
  `agent-thread-manager.test.ts` and `claude-follow-up-settlement.test.ts`;
- new `tests/server/orchestration-queue-recovery.test.ts`;
- Electron: update `tests/e2e/composer-stop-and-send.spec.ts` and add
  `tests/e2e/queue-restart.spec.ts` (queue and hold survive a relaunch).

**Acceptance** (full list in
[phase5-acceptance-pkg1-2.md](phase5-acceptance-pkg1-2.md)):

- **Retry identity.** A released item retried later gets a new command id;
  its first attempt's receipt never answers the second.
- **Run attribution.** A run accepted from an item carries `queueItemId`, and
  its ordinal is dense.
- **Steer outcomes.** `accepted`, `refused`, `turn-ended`, `unconfirmed` and
  `runtime-lost` each give the documented item state, and nothing is sent
  twice.
- **Stop and holds.** Stop holds the queue. A user send or Resume releases it;
  an agent's send starts past it (P1) and releases nothing (T3
  `ThreadStop.test.ts:714`).
- **Stop and send** with other user items queued puts the new item first,
  shifts the rest, starts it even when an older hold exists, runs an earlier
  delegated delivery first, and reports `restarted` (T3
  `SteeringCompletion.integration.test.ts:3222`, `:3256`, `:3323`). The
  refusal "Send or remove the queued message first." is gone.
- **Stop and send edge rules.** Into a turn that already ended, it starts the
  item immediately. Into a run that Stop already reached, it queues as a start
  behind the stopping run. An explicit steer into that run is refused (T3
  `:2886`, `:2989`, `:3042`, `:2801`).
- **Deferred steer.** Send now while the run is preparing, or running before
  its provider turn, stores `steerWhenReadyRunId` and steers once on provider
  start, under a per-attempt command id (T3 `:894`).
- **Placement.** A declined composer steer, and an accepted steer the provider
  never read, are placed after the items queued before the steer's first
  effect, and earlier ones keep their order. A `turn-ended` steer is
  dispatched as a start, behind unheld items, and releases held items. A
  refused Send now leaves no delivered transcript row, and forks leave queued
  items out (T3 `ProjectionStore.test.ts:11343`).
- **Crash.** A crash after claim, after admission before provider start,
  during a steer, or with an unread follow-up mid-turn reconciles as in 2.9.
  Requeued items come first and the queue is held. A pending send intent
  starts nothing after boot.
- **Stop on the effect dispatcher.** A Stop committed before a crash is
  retired `runtime-lost` at boot, and the run is interrupted by boot recovery;
  nothing in memory is needed to settle it.
- **Force stop** never tears down an item whose run started during cleanup (T3
  `ThreadManagementService.test.ts:971`). A Stop that lands while a queued
  item is being admitted holds it, checked inside the admitting section.
- **Workspace.** Messages sent after an isolated workspace failed or was
  stopped wait held and never run in the project checkout.
- **Settlement retries.** The settle path of a claimed effect retries a busy
  database before giving up, so a `running` row cannot block later items.
- **#761 contract.** Every contract test passes, changed only as N19 says.

### Package 3: per-item model (L1)

**Scope:**

- selection snapshot at enqueue, with queue-tail inheritance (N5);
- per-item selection in place of `route_identity` blocking;
- provider switch at item start, through the existing switch, backing and
  coverage path, including H6;
- configuration changes while running, per T3 (2.7);
- automatic kinds follow the current selection; a steered item keeps its own;
- the per-provider usage-limit hold (N8);
- the coverage watermark (N18) is a prerequisite.

There is no access ceiling (decision 4.3).

**Files:**

- `queued-message-repository.ts`: remove `queuedRouteIdentity` from the
  queue; limit-reset and continuation keep their own copy;
- `commands/conversation-commands.ts`: drop the refusal "Stop the active run
  or review before changing its agent configuration.";
- `orchestration-v2/projector.ts`: accept `thread.configured` while a run is
  active;
- `turns/turn-request-preparation.ts`, the provider switch and backing
  repositories, and `src/server/usage/limit-reset-scheduler.ts`;
- migration 128.

**Tests:** a new `tests/server/orchestration-queue-selection.test.ts`; extend
`orchestration-backings.test.ts` (a switch between queued items keeps
coverage; a switch-back delivers only the intervening items) and the
provider-switch fallback suites.

**Acceptance:**

- **Two items under different models** run in order and switch between them.
  The second's switch does not end background work; it holds the queue (H6).
- **Configuration changes while running.** Changing the model, effort,
  interaction or access mode while running is accepted, updates the chat at
  once, and does not alter the active run.
- **Selection inheritance.** An item enqueued without a selection takes the
  last queued item's selection, and an automatic item takes the chat's
  selection at start.
- **Access.** A queued item runs under the chat's access mode at its start,
  and agent-created items stay within the managed-chat ceilings.
- **Missing instance.** An item whose provider instance was removed or
  disabled blocks with a named reason instead of failing the run.
- **Usage limits.** A usage-limited provider holds only its own items. It
  keeps them held after another provider's turn succeeds while its reset is in
  the future, lifts the hold when the reset is unknown, and a user start lifts
  it (T3 `usageLimitHoldsQueue`, `O:1074`).
- **Long chats.** A switch-back on a chat with more than 2,048 covered items
  reuses the native session (N18).

### Package 4: integrations

**Scope:**

- watcher delivery on queue events, with FIFO order, per-watcher coalescing
  and the stale-note drop (decision 4.2);
- the delegation mailbox on queue events;
- the Private Connect queue (decision 4.4);
- steering capability truth with T3's flags (decision 4.9, N3, N4);
- the two assigned upstream items: Pi clears its native queue before abort,
  and the cleared texts become a notice (`afb8619e1d`); Codex `turn/start`
  must not adopt a turn owned by another attempt (`54d0a161bb`);
- a read model the later agent queue tool can wrap (T3 `t3_queue`);
- rewrite `docs/user/watcher.md` (`:84`, `:92` and the automatic-sending
  paragraph), because it promises user-first order and a three-item queue.

**Files:**

- `src/server/runtime/watcher/watcher-delivery.ts`;
- `src/server/orchestration-v2/delegation-delivery-planner.ts`,
  `delegation-repository.ts` and `delegation-reads.ts`;
- `src/server/runtime/delegation/task-service.ts`;
- `src/server/private-connect/prompt-admission.ts` and `runtime-gateway.ts`;
- `src/shared/private-connect/*` (projection schema);
- `src/shared/follow-up-steer.ts` and
  `src/server/provider/capability-manifest.ts`;
- `src/server/provider/pi-rpc-harness.ts` and
  `src/server/codex/app-server-run.ts`;
- `docs/user/watcher.md` and `docs/PRIVATE_CONNECT.md`.

**Tests:**

- `watcher-delivery.test.ts`, `delegation-queue.test.ts`,
  `orchestration-delegation-*.test.ts`;
- Private Connect gateway tests, `pi-rpc-harness.test.ts` and the Codex
  app-server tests;
- `npm run test:portable` (provider protocol changes);
- Electron `delegation-wake.spec.ts` and a Private Connect scenario.

**Acceptance:**

- **Watcher notes.** A watcher note queues at the end, after items queued
  before it and before items queued after it. A newer note from the same
  watcher supersedes its waiting note. A stale note is cancelled at start, and
  its card says **Not sent** with the reason. Removing a note still reports
  "Not sent" to the watcher card. Delegated deliveries merge by request time.
- **Collaborate device.** A device's text prompt to a busy chat is queued with
  server-side `device:<id>` attribution and CRLF-normalized text. The device
  can Send now (start or steer), edit text-only items, remove and Resume. It
  cannot reorder, add or remove attachments, or edit an item that carries
  attachments.
- **Monitor device.** It sees the queue read-only, with text within the
  transcript budget and attachment counts only.
- **Steerable set.** It equals the manifest's wired steer support, including
  `steerAcceptsAttachments` and `steerDuringCompaction`. Portable fixtures
  cover steer success, refusal, turn-ended, malformed response and
  cancellation for every harness newly marked steerable (Pi, Cursor SDK).
- **Pi Stop** clears its queue first and surfaces the cleared texts.

### Package 5: renderer

**Scope:**

- the full queue list (two rows and "Show all N queued" when more than three
  items wait, as T3 `QueuedRunsControl.tsx:60`, `:250-251`);
- edit in the composer, and remove;
- Send now (start or steer, labelled **Stop and send** when that is what it
  will do), and Stop and send;
- Resume as the composer's primary action on a held chat: Enter on an empty
  composer resumes, and Resume is hidden while a question or approval is
  pending;
- a steer "waiting for acceptance" state;
- the per-item model chip and attribution labels;
- push invalidation in place of polling;
- the old local queue migration (decision 4.5), and the user docs.

There is no reorder control (N13).

**Files:**

- `src/renderer/src/components/composer/RuntimeComposerQueuedActions.tsx`
  (rewrite), `runtimeQueueClient.ts`, `runtimeQueueEvents.ts`;
- `ComposerQueuedActions.tsx`, `composerQueuedPrompts.ts`, `Composer.tsx`,
  `useComposerStopAction.ts` and the keybinding registry;
- `src/renderer/private-connect/src/workspace/ConversationPane.tsx`;
- `docs/user/chats-and-agents.md`, `watcher.md` (final check after package
  4), `keyboard-shortcuts.md` and `docs/PRIVATE_CONNECT.md`.

**Tests:**

- Happy DOM: `tests/renderer/runtime-composer-queue.dom.test.tsx`,
  `composer-queued-actions.dom.test.tsx` and
  `composer-queued-prompts.dom.test.tsx` (focus after edit and remove;
  labels; a live region for errors);
- Electron: `tests/e2e/queue-edit.spec.ts` (real geometry, restart) and the
  updated `composer-stop-and-send.spec.ts`.

**Acceptance:**

- **Keyboard and labels.** Every action is reachable by keyboard, focus
  returns to a sensible row after remove, and each row has a readable label
  ("Queued message 2 of 4, Claude Sonnet"). A polite live region announces the
  queue (T3 `QueuedRunsControl.tsx:263`). Rows the server has not confirmed
  render as pending, with their actions disabled.
- **Editing.**
  - Editing keeps an unrelated composer draft and mention chips; cancelling
    an edit with changes keeps them.
  - Recovery moves an edit into the thread draft only when that draft is
    empty; otherwise it shows a toast.
  - A cancelled or replaced edit releases its staged uploads.
  - Removing an attachment counts as an edit, and a cleared edit can only be
    discarded.
  - Every "add to chat" entry point targets the edit being made (T3
    `queuedMessageEdit.ts`; client-runtime `queuedRunEdit.test.ts`).
- **Edit timing.** Edit is allowed during compaction and refused while a
  question or approval is open (T3 `queuedRunEditBlockedReason`, N11).
- **Resume** shares the Stop pending state and latch.
- **Push updates.** The queue updates without polling after a server push,
  and a reconnect refetches once.
- **Legacy queue.** A legacy local item can be moved into the durable queue
  only by an explicit action, and is never sent automatically.

## 4. Decisions

Each decision is marked **Decided (follows T3 v0.1.11)** or **Decided
(deliberate difference: <reason>)**, and re-checked against the pin
`de0466fd8`.

### 4.1 Queue cap

**Decided (deliberate difference: AGENTS.md "Bound runtime, output, and input
sizes").**

T3 has no cap on queued user runs. It bounds automatic and foreign sources:

- 20 queued webhook runs per scheduled task (`WEBHOOK_MAX_QUEUED_PER_TASK`,
  `apps/server/src/scheduledTasks/ScheduledTaskService.ts:93`);
- one queued occurrence per recurring task;
- coalesced and stale-dropped pull request wakes (`Orchestrator.ts:1127-1190`);
- three pending guest messages (`GUEST_PENDING_MESSAGE_LIMIT`,
  `packages/contracts/src/guestShare.ts:21`).

An unbounded queue with retained attachments would break the bounded-input
invariant, so a cap stays, set high enough not to shape normal use:

- **20 user plus agent items per chat** (`createdBy` `user` or `agent`).
  Agents get no separate uncapped bucket, because agents can loop.
- **One delegated delivery** (unchanged).
- **Watcher notes:** at most one waiting note per watcher (a newer note
  supersedes the waiting one, as T3 coalesces recurring and pull request
  wakes) and five in total. At the total, a new note is not queued, and its
  card says **Not sent** with the reason.
- **Requeues do not count:** unread follow-ups and crash requeues carry the
  requeue marker and are not new input. Unread follow-up rows keep their own
  bound of 64. The managed-send room check counts the same set as the cap.

Watcher notes no longer compete for user slots, so the "leaves the last place
for you" rule (`docs/user/watcher.md:92`) goes; its anti-loop rule stays.

### 4.2 Watcher order

**Decided (follows T3 v0.1.11).**

T3 orders queued runs FIFO and merges delegated completions by request time
(`QRO:13-50`). Monitor notes follow the current selection
(`O:1026-1043`), and stale pull request wakes are cancelled at queued start
(`isStalePullRequestWatchWake`, `O:1164`). User-first order was an Inertia
product promise (`docs/user/watcher.md:84`), not an invariant.

Inertia follows T3:

- Watcher notes take positions with user items, and delegated deliveries
  merge with them by request time.
- A watcher note whose source review is stale is cancelled at queued start
  with reason `stale`. A review is stale when a newer note from the same
  watcher exists, or when the turn it reviewed was rolled back.
- A note can still be removed.

This removes a priority class from the order function and from migration
127's index. `docs/user/watcher.md` is rewritten in package 4.

### 4.3 Access widening

**Decided (follows T3 v0.1.11).**

A T3 queued run carries `modelSelection` but no runtime mode (`C:766-803`), and
starts under the thread's current mode. Agent-originated dispatch is limited
by `DispatchModeLimit` (`DispatchModeLimit.ts:21-41`). No invariant forces a
per-item ceiling:

- access changes are desktop user actions;
- Private Connect cannot enable Full Access;
- delegated children keep their own ceilings.

A queued item runs under the chat's access and interaction mode at its start.
There is no `accessCeiling` field, no migration column, and no "Access widened
since this was queued" block. Items created by agents stay within the
managed-chat ceilings. The user guide says a queued message runs with the
chat's settings when it starts.

### 4.4 Private Connect

**Decided (follows T3 v0.1.11 mobile client; deliberate difference: no file or
attachment access from devices, the documented Private Connect boundary).**

T3 has two foreign surfaces:

- **Mobile** is a full owner client: steer, edit, remove, Resume queue and a
  "Queue paused" banner, no reorder (`ThreadQueueControl.tsx:241-256`).
- **Guest share** is a foreign-user surface: at most three pending messages,
  owner admission, server-prefixed text, cancel but no edit.

Private Connect devices are the user's own paired devices, so mobile is the
analogue.

- **Monitor:** a read-only queue, with text within the transcript budget and
  attachment counts only.
- **Collaborate:** for text items, enqueue to a busy chat, Send now (start or
  steer), edit, remove and Resume. No reorder, as T3 mobile. No attachment
  operations: a device cannot add or remove attachments, or edit an item that
  carries them, though it may remove it.
- **Attribution:** a server-side `device:<id>` attribution that a client
  cannot claim, and CRLF normalization (T3 `6bce2226d`).
- **Authority:** the prompt path moves onto the queue command authority with
  the actor `device:<id>`; payloads are validated at the gateway (AGENTS.md).

This **widens the documented Collaborate grant** ("supervised text prompts,
answers to non-secret agent questions, and stopping the exact active run").
Steering, editing, removing and resuming queued text are new device powers.
`docs/PRIVATE_CONNECT.md` must say so in the same release, and the gateway's
authorization tests must cover each new command per level.

### 4.5 The old local queue

**Decided (deliberate difference: AGENTS.md "Preserve … identities across
every command boundary"; T3 has no desktop counterpart).**

T3's only analogue is the mobile durable outbox. It resends automatically,
because its command and message ids are stable and delivery is idempotent.
Legacy local items have no idempotent identity, and their earlier delivery is
unknown, so automatic import could resend a prompt.

The local write path stops and refuses instead. Legacy items show under "Saved
from an earlier version", with two actions:

- **Move to queue:** a fresh id through `message.queue.enqueue`, then delete
  the local copy.
- **Discard:** release the attachments.

The component and keys are removed one release after Phase 5 ships.

### 4.6 Stop and send

**Decided (follows T3 v0.1.11 for every provider; deliberate difference: never
a same-run restart, because of the cleanup-proof invariant).**

T3 has two restart paths, chosen by capability. Providers with
interrupt-restart restart the same run on a new attempt of reason
`steering_restart`. Providers without it stop the running turn and run the
message next (`O:7600-7628`, placement `O:8023-8045`):

- position 1;
- stop reason "Stopped to send a new message";
- created without hold;
- delivery reported as `restarted`;
- a delegated result requested earlier still runs first, by the order
  function.

Inertia uses T3's second path for every provider:

- stop the target run with interrupt reason "Stopped to send a new message",
  enqueue the item at position 1 with the others shifted, and start it next;
- the item is created without hold, while older items stay held;
- report delivery `restarted`; the new run records `afterStopOf`;
- the refusal "Send or remove the queued message first." is removed;
- edge rules:
  - a target turn that already ended makes it a start;
  - a run that Stop already reached makes it a start queued behind the
    stopping run;
  - an explicit steer in that situation is refused (T3 tests
    `SteeringCompletion.integration.test.ts:2886`, `:2989`, `:3042`,
    `:2801`).

**The invariant.**

- AGENTS.md requires terminating complete process trees on timeout or
  cancellation.
- Inertia's stop ladder can end `unconfirmed-released`.
- G8 replaces an attempt only after confirmed cleanup.

A same-run `steering_restart` on an attempt whose process tree may still be
alive is therefore never written by the queue; `steering_restart` stays
reserved.

**Managed `mode: restart`** uses this same path. Its `expectedTurnId` is the
turn captured before approval, so a late approval never stops a newer turn.
**Recorded deviation:** T3 restarts whatever run is the latest steerable one
at dispatch (`latestSteerableRun`, `ThreadManagementService.ts:878-905`). T3
has no approval window, so for T3 dispatch time is request time. Inertia keeps
the identity captured at request time, because the approval and tool-call
window lets a newer turn start in between, and stopping that turn would act on
work the agent never saw.

### 4.7 Queued items as runs or as their own entities

**Open until the §2.1 spike.** T3 v0.1.11 models a queued message as a queued
run (`C:766-803`). The one-non-terminal-turn rule and dense ordinals are
recorded choices, not invariants. Most run readers join from `agent_turns`, so
a queued run without a turn row is invisible to them. If the spike fails,
Inertia keeps separate entities as a recorded difference, names the failed
question, and uses T3's field names exactly (2.2).

### 4.8 Configuration changes while running

**Decided (follows T3 v0.1.11).**

T3 accepts `thread.model-selection.set`, `thread.runtime-mode.set` and
`thread.interaction-mode.set` while a run is active, and updates the thread at
once; the active run keeps its own selection. The behaviour of queued items is
given in section 2.7. Inertia's current refusal is Inertia's own choice, not
an invariant.

- Live apply is a separate provider item per adapter, each with portable
  fixtures: Claude effort and flags, and Codex `serviceTier`, which must
  survive a retried attempt. A Claude `setModel` echo is not a wake (T3
  `3eadb214e`).
- There are no configuration-only rows.
- Which composer submissions name a selection must match T3's web composer;
  check it when package 3 starts.

### 4.9 Steering capability truth

**Decided (follows T3 v0.1.11).**

T3 keeps per-session turn flags (`C:304-313`):

- `supportsNativeResume`;
- `activeSteeringInterruptsTools`;
- `activeSteeringAcceptsAttachments`;
- `activeSteeringDuringCompaction`;
- `supportsSteeringByInterruptRestart`;
- `supportsQueuedMessages`.

Cursor SDK is actively steerable. Pi steers with a "waiting" state until the
steer is read.

Inertia:

- derives steerability from the manifest only, and deletes
  `STEERABLE_HARNESS_IDS`;
- adds `steerAcceptsAttachments`, `steerDuringCompaction` and `native-resume`
  to the manifest;
- enables Pi and Cursor SDK steering only with portable fixtures, marking an
  entry unavailable if its fixture cannot be made deterministic;
- surfaces a steer "waiting for acceptance" state.

### 4.10 Requeue after a restart

**Decided (follows T3 v0.1.11).**

T3 rewinds a `running` or `starting` run with no provider turn on any attempt
(`PRRS:220-280`). The user's own such runs return to the queue, held, at
positions 1..n ahead of the existing queued runs. Every queued run is held,
and automatic unstarted runs are not retried (`PRRS:563-603`).

Inertia requeues user items whose run never reached the provider:

- at the front, in their original order;
- the whole queue is held;
- the item names the original message and is re-admitted through
  `adoptUndeliveredPrompt` (2.9);
- automatic items, and anything with evidence of delivery, are never
  requeued;
- unattended prompts are resent at most three times, and never after a
  recorded Stop (recovery phase).

### 4.11 Decisions from current T3

| # | Decision | T3 at `de0466fd8` | Inertia | Package |
| --- | --- | --- | --- | --- |
| N1 | Send now while the run is preparing | Deferred steer: a queued run with `steerWhenReadyRunId` (`C:779`), promoted by `deliverDeferredSteers` when the provider turn starts, command id `command:deferred-steer:<queued>:<run>:<attempt>` (`O:16379-16404`); test `SteeringCompletion.integration.test.ts:894` | **Decided (follows T3).** Store the item with `steerWhenReadyRunId` and deliver it on the run's provider-start observation under a per-attempt command id. If the run ends first, the item stays queued at its position. It replaces the refusal "This agent cannot take a message while it works…" for this case | 2, M |
| N2 | Where a declined or unread steer goes | A declined steer is placed after the runs queued before it (`EW:383-396`, `O:7985-8000`). An accepted steer the provider never read is placed the same way (`requeueUnreadSteers`, `O:3455-3570`), including when a send beats the run-end reaction (`O:15953-15969`). A `turn-ended` steer is re-dispatched as a start, not placed | **Decided (follows T3).** A refused composer steer and an accepted-but-unread follow-up go after the items queued before the steer's first effect; earlier ones keep their order. A `turn-ended` steer is dispatched as a start, behind unheld items, and releases held items (R1). The landed unread follow-up rows are these items; package 2 adds the read mark and boot requeue | 2, S |
| N3 | Steer with attachments the steer cannot take | Forces an interrupt-restart where supported (`C:309`; test `SteeringCompletion.integration.test.ts:1297`) | **Decided (deliberate difference: cleanup-proof invariant).** Explicit Send now uses stop-and-send (4.6); an automatic composer follow-up queues behind the turn. Manifest flag `steerAcceptsAttachments` | 4, S |
| N4 | Steering during compaction | Only where `activeSteeringDuringCompaction` (`C:311`) and only during automatic compaction | **Decided (follows T3).** Behind `steerDuringCompaction`, with a Codex portable fixture; until it lands the queue keeps skipping compaction | 4, S–M |
| N5 | Selection for an item that names none | The queue tail's (`O:1056-1067`, `:7844`) | **Decided (follows T3).** Section 2.7 | 3, S |
| N6 | Fresh-context items | Never steer; reserve a fresh provider thread (`C:802`). Three `/clear` edge rules (`975b9577a`, `66235c7f2`, `455a60aa3`) | **Decided (follows T3), dormant.** `freshContext` is an item field that never steers. It gets a trigger, with the three rules, only when fresh-context sends are adopted | – |
| N7 | What Resume does | Resume continues the stopped or usage-limited run natively first, then releases the queue. It is hidden on a provider without native resume (`supportsNativeResume`, `C:304`) unless the stopped run's message never reached the provider (`orchestrationV2ManualContinuation.ts:3-33`). A prompted Resume sends "Continue where you left off." (`PTS:217`, used at `PTS:2013`). It is refused with "Retry worktree setup or choose a workspace before resuming the queue." or "Continue the limited thread before resuming its queue." (`O:15742-15763`) and while a request is pending (`canResumeThread`, `TE:363-369`) | **Decided (follows T3).** `message.queue.resume` continues the interrupted run when its harness declares `native-resume` (Pi does not), else releases the hold and starts the next item. It is hidden where the capability is false unless the stopped item's message never reached the provider, hidden while a question or approval is pending, and refused with T3's two messages. Images from a missed run force a prompted start, which sends T3's text. Cursor SDK native resume needs the SDK upgrade | 2 and 5, M |
| N8 | Usage-limit hold scope | Per provider: automatic starts respect a future reset, an unknown reset lifts the hold, and a user start lifts it (`usageLimitHoldsQueue`, `O:1074`) | **Decided (follows T3).** Section 2.2 | 3, S |
| N9 | Messages after failed or stopped workspace setup | Held, never run in the project checkout; release is blocked while setup is unresolved (`O:7849-7858`); a preparation retry releases the queue (R4) | **Decided (follows T3).** Applies to isolated-workspace preparation | 2, S |
| N10 | Agent sends to a stopping chat | Queue (`ThreadStop.test.ts:803`) | **Decided (follows T3).** `inertia_send_message` `mode: auto` to a stopping chat queues | 2, S |
| N11 | Edit while a question is open | Refused in the client only (`queuedRunEditBlockedReason`; client-runtime `queuedRunEdit.test.ts:45`) | **Decided (follows T3).** Refused in the renderer. There is no server refusal: T3 has none, and no invariant needs one | 5, S |
| N12 | Items created on another surface | Guest messages: the owner cancels, never edits. Mobile items are the owner's own | **Decided (follows T3 mobile).** Device items are the user's own and editable on the desktop. Devices still cannot edit items with attachments (4.4) | 4, S |
| N13 | Reorder surface | Server command and agent tool only (`O:11945-11981`); no web or mobile client reorders | **Decided (follows T3).** `message.queue.reorder` exists for the later agent queue tool; the desktop renderer does not offer reorder | 1 and 5 |
| N14 | Unread steer at Stop | A steer the provider had not read when Stop ended the run is cancelled, with the notice "Steer delivery not confirmed … Resend it if needed: "<text>"" (`O:3484-3524`) | **Decided (follows T3).** It closes the recorded difference at `IP:5439` | 2, XS |
| N15 | Managed-chat mutations in Full Access | No per-call approval on orchestrator tools; the caller's runtime and interaction modes are the ceiling, rechecked under the command lock (`DispatchModeLimit.ts:21-41`) | **Decided (user, 2026-11-22; follows T3).** When the calling chat runs in Full Access, `mutate()` skips the approval card for create, send (every mode) and stop. It keeps the reservation, idempotency, budget and `assertAccessWithinParent`. Supervised and auto-edit keep the card. `inertia_answer_question` is checked separately | D.7, before 2, S |
| N16 | Stop before provider acceptance | The run ends `interrupted` with no provider turns (`runtimeLayer.test.ts:11643-11653`), and its text and images ride on the next prompt (`PTS:1149-1155`, `:1182-1210`, `:2002-2025`) | **Decided (user, 2026-11-22; follows T3).** The earlier "no longer resend the text" decision is dropped. Codex already matches T3 for text; correction C1 adds the images. Non-Codex harnesses keep the open acceptance item (2.9) | 2.9, C1 |
| N17 | Queued text in the event log, and receipts | T3 prunes covered events after a day (`ProjectionMaintenance.ts:42`, `:97-183`) | **Decided: content by reference, text-free receipts, receipt purge.** See below | 1, S |
| N18 | Covered-id cap | Coverage comes from id lists stored per delivered handoff, `delivery.itemIds` and `omittedItemIds` (`C:1248-1256`, read at `PTS:1073-1079`), with no cap. `coveredRunOrdinals` only labels the handoff text (`handoffBudget.ts:283-290`) | **Decided (deliberate difference: bounded input).** A watermark; see below | 3 prerequisite, M |
| N19 | #761 managed-send modes | `ThreadManagementService.sendToThread` (`ThreadManagementService.ts:870-990`) | **Decided (contract).** See below | 2, S |
| N20 | An imported Claude session the provider refuses | Falls back to a fresh session with the full summary (`2c4622efb`) | **Decided (user, 2026-11-22; follows T3).** Not Phase 5: a G9/D.4 item that replaces the recorded difference at `IP:4304` | outside Phase 5, XS–S |

**N17: queued text in the event log.**

Nothing deletes from `orchestration_v2_events`; the only deletes touch effects
and, on rebuild, entities. Deleting a chat cascades to `queued_messages` but
leaves its V2 events, which already hold some text (fork history parts,
delegated results).

The options were:

- prune covered events as T3 does, which reverses the recorded G6/G8 choice
  to rebuild from the full log ([t3code-delta-2026-11-14.md](t3code-delta-2026-11-14.md),
  section E);
- purge a deleted thread's V2 rows, where cross-thread references need their
  own design;
- carry queue content by reference.

Decision: **content by reference**.

- Queue events carry `{chars, editRevision}` and attachment ids. They carry
  no digest, because an unkeyed digest of a short message is a confirmable
  fingerprint that would outlive the chat.
- The text lives only in the `queued_messages` row. That row is wiped at
  `accepted`/`cancelled`, pruned to 50 terminal rows, and deleted with the
  chat. Rebuild never touches it. For queue content it is the authoritative
  store, not a projection.
- **Verify check.** G6 verify flags a non-terminal queued item whose row is
  missing, or whose `chars` or `editRevision` disagree with the row. Such an
  item is blocked ("This queued message's text was lost; remove it") and is
  never dispatched with empty or stale text. Terminal items whose rows were
  pruned, and items of deleted conversations, are excluded.
- `editRevision` is bumped in the same transaction as the row update.
- **Receipts** follow 2.4: text-free fingerprints for queue and send commands,
  a row text check, and purges on chat delete, project delete and in
  migration 127. Together these remove the existing exposure of today's send
  receipts.
- Purging deleted chats' V2 events (fork and delegation text) is a separate
  privacy item outside Phase 5.

**N18: coverage watermark.**

Today the cap bites in three ways:

- `portableHistorySource` throws above 2,048 excluded ids
  (`portable-history-source.ts:173`).
- Backings keep only the last 2,048 covered ids and set `coverageComplete:
  false` beyond that. An incomplete backing is not usable, so on a long chat
  every switch-back starts a fresh session with a budgeted full restore.
- Each `provider.backing-recorded` event carries the full id list, so with a
  full log the log grows by up to about 80 KiB per turn on long chats.

Raising the cap only moves the cliff toward the 1 MiB event-payload limit.
Copying T3's unbounded lists breaks the bounded-input invariant.

Decision: **a watermark** (recorded deviation). Coverage becomes
`coveredThroughOrdinal: N` (every user and assistant item of the chat's own
turns with run ordinal ≤ N), plus `coveredItemIds` for items after N and a
bounded `uncoveredItemIds` list of exceptions at or below N. Rules:

1. **Rollback lowers N.** Rollbacks are suffixes
   (`history-rollback-repository.ts:58-66`), and ordinals are never reused
   (`projector.ts:61`, `:91`). A rollback therefore sets N to the retained
   turn's ordinal and drops `coveredItemIds` after it. A native rewind that
   keeps the session follows the same rule.
2. **Exceptions at or below N** are only items never delivered into the
   native session although their turn was: unread follow-ups before adoption,
   and handoff items omitted without being marked covered.
3. **Inherited items.** Items a fork or merge-back brought into the child have
   no ordinal in the child's space. `inheritedCoverage: { forkId, throughPart }
   | complete` covers them, or else they are covered by id within the same
   bounds.
4. **Old events stay projectable.** `provider.backing-recorded` events with id
   lists remain valid input under a full-log rebuild. The projector derives no
   watermark from an old event; the schema change is additive, and no event is
   rewritten.
5. **Converting an old list.** At the backing's next coverage write (in the
   runtime, which can read the transcript, not the projector), N is the
   highest ordinal k such that every user and assistant item of the
   non-rolled-back turns with ordinal ≤ k is in the old list. The old list
   holds at most 2,048 ids. Remaining old ids after N stay in
   `coveredItemIds`.
6. **Raising N.** After every coverage update (a completed run's own items,
   or a delivered handoff's `itemIds` and `omittedItemIds`), N advances over
   each next turn whose items are all covered or excepted, and those ids are
   dropped. A rolled-back turn counts as covered for advancing. A session
   created by a provider switch therefore gets a watermark from its first
   handoff.
7. **Turns without a V2 run.** Imported and pre-V2 turns have no ordinal
   (`missed-run-attachments.ts:85-86`). They precede the chat's first V2 turn,
   and are covered by `legacyCovered: true` once every legacy item is covered;
   until then their ids count in `coveredItemIds`. Package 3 verifies that no
   V2 turn is ever ordered before a legacy turn.
8. **Bounds.** `coveredItemIds` after N stays capped at 2,048, and exceptions
   at 256. Overflow of either sets `coverageComplete: false`, as today.

**N19: the #761 contract.**

The cases under "inertia_send_message modes" in
`tests/server/agent-thread-manager.test.ts`, and "wait in the child's own
queue behind the running turn, refuse a fourth, and send after the turn
completes" in `tests/server/queued-message-runtime.test.ts`, are the
compatibility contract.

T3's reference is `sendToThread`:

- `auto`, `steer` and `restart` target `latestSteerableRun`;
- `queue` becomes `queue_after_active`, and `auto` on an idle chat becomes
  `start_immediately`;
- a restart on a provider without interrupt-restart is reported as
  `restarted`, with the run left `queued`.

Line numbers below are from `origin/main` `e37ff42bd`.

| # | Difference | T3 at the pin | #761 test | Test change |
| --- | --- | --- | --- | --- |
| a | `mode: queue` to an idle child after a failed turn starts at once. The test's queue is empty there, and T3 holds only runs already queued (H4, `O:2579-2606`) | `ThreadStop.test.ts:714`; `runtimeLayer.test.ts:9225` | "reports a queue that filled while the approval was open, and one held by an unfinished turn" | **Yes**, the held half: `disposition: "new-turn"`, not `queued` with `next`. The filled half stays |
| b | `mode: restart` goes through stop-and-send: the new item waits at position 1 until the stopped run's cleanup is confirmed | `ThreadManagementService.ts:960-980`; `SteeringCompletion.integration.test.ts:3222`, `:3323` | "restarts by stopping exactly the running turn and starting a new one with the message" | **Yes**: `disposition: "restarted"`, `stoppedTurnId`, and an item that starts after the Stop settles |
| c | Restart targets the turn captured before approval | `ThreadManagementService.ts:878-905` | "does not stop or replace a newer turn when a restart is approved late" | **No**: recorded deviation (4.6) |
| d | The cap is 20 user plus agent items | No cap | "queues behind the running turn in the chat's own queue, and refuses a fourth message before asking"; the queue-runtime case | **Yes**: "the 21st item", still refused before the approval |
| e | Full Access shows no approval card (N15) | No approval on orchestrator tools | "auto steers a running chat, starts a new turn on an idle one, and says so on the card" | **No**: the fixtures run supervised. A new Full Access case shows no card and keeps the ceiling |
| f | `auto` on a running turn queues when the provider cannot steer, or the run is compacting, preparing or stopping | `CP:186-224`, `:104-126`; `ThreadStop.test.ts:803` | – | New cases |
| g | `auto` does not steer past a waiting agent item | `0a159c9fb`; `SteeringCompletion.integration.test.ts:1721` | – | New case |
| h | A `mode: queue` item enqueued while items are held is created held (H2) and released by the next completed run (R2) | `O:7971-7973`, `:8023-8031`, `:3407-3450` | – | New case on a running chat |
| i | Items are receipted under `agent-queue:<operation id>` | Receipts per command | – | New replay case |

These are unchanged and match T3:

- `steer` on an idle chat is refused before asking
  (`ThreadManagementService.ts:884-891`).
- A steer approved after the turn ended is refused.
- The 20,000-character limit for queued content stays, an Inertia bound.
- "does not cancel the turn a restart was waiting to stop when the parent
  fails before approval".

The agent-sender note on agent-originated turns (T3 `b0b2c4f95`) is a D.1
item. It changes provider-visible text, not these tests.

### 4.12 Corrections outside the queue

| # | Correction | T3 at the pin | Inertia today | When |
| --- | --- | --- | --- | --- |
| C1 | **Decided (user, 2026-11-22).** Carry the images of a Codex run the user stopped before provider acceptance | Such a run ends `interrupted` (`runtimeLayer.test.ts:11643-11653`); interrupted runs without a delivered attempt are missed, and their images ride on the next prompt (`PTS:1149-1155`, `:2002-2025`) | A user Stop settles `cancelled` (`IP:1805`), and `missedStatus` counts `cancelled` only with `promptDropped` (`missed-run-attachments.ts:22-23`), so the images are dropped (`IP:5197-5198`) | XS–S, before package 2. Codex: treat a cancelled run with `delivery: not-delivered` and a recorded user Stop as missed in the walk and the eviction pin. Non-Codex harnesses are gated per harness on the smoke session: they never mark such a run `not-delivered`, so C1 reaches each one only with its own acceptance evidence |
| C2 | Keep unread follow-up messages out of forks | Undelivered queued input stays out of forks (`ProjectionStore.test.ts:11343`) | Fork history copies messages by turn (`fork-history.ts:38-44`), so a message an active unread row names is copied | XS, package 2 or earlier: apply the `NOT_QUEUED` exclusion there |

## 5. Deliberate differences from T3 and risks

**Kept**, each with the reason that forces it:

- **Queue cap** at 20 user plus agent items, one delegated delivery, one
  waiting note per watcher and five watcher notes in total (4.1). Reason:
  AGENTS.md bounded input; T3 has no cap.
- **Never a same-run restart.** Stop and send, and Send now when a restart is
  forced, stop the run and start the item next, instead of writing a
  `steering_restart` attempt (4.6, 2.5). An automatic composer follow-up that
  T3 would restart in place queues instead (N3). Reason: AGENTS.md
  process-tree termination, together with G8's cleanup-proof attempt
  replacement.
- **Restart targets the turn captured at request time** (4.6). Reason: the
  approval and tool-call window.
- **Queue model pending the spike** (4.7). If separate entities are kept, the
  reason is the failed spike question; T3's field names are used either way.
- **Placement by submission order** instead of ordinal comparison (2.1).
  Reason: dense ordinals assigned at start (G8).
- **Coverage as a watermark** (N18). Reason: bounded input; T3 stores
  unbounded id lists.
- **Content by reference, no digest in events, text-free receipt
  fingerprints** (N17). Reason: a digest of short text is a fingerprint that
  outlives deletion, and Inertia keeps the full event log (recorded G6/G8
  choice).
- **No attachment operations from Private Connect devices** (4.4). Reason: the
  documented Private Connect boundary and AGENTS.md boundary validation.
- **Old local queue** needs an explicit Move to queue or Discard (4.5).
  Reason: AGENTS.md identity preservation; T3 has no counterpart.
- **Automatic stop escalation** instead of T3's manual Force stop. Reason:
  AGENTS.md process-tree termination (recorded in G5).
- **Non-Codex harnesses credit unconfirmed prompts.** This is not a decision
  but the recorded open item (`IP:3372`): each harness needs its own
  acceptance evidence.

**Risks:**

- **Pin drift.** Phase 5 follows v0.1.11 while T3 `main` moves. The weekly
  triage acts only on safety, data-loss or contract changes; the exit survey
  re-checks section 6.
- **Spike outcome.** The queue model, migration 127's shape and the run
  readers all depend on it (2.1).
- **Compatibility projection drift.** Delegation reads, attachment GC and the
  watcher still read `queued_messages`. Every queue event must write the row
  in the same transaction, and a rebuild test must compare both.
- **Receipt id change.** Moving internal dispatch from `queue:<id>` to
  `queue:<id>:<n>` makes receipts written before the upgrade unreachable by
  replay. Boot adoption treats a `dispatching` legacy row as released and
  never replays its old command.
- **Stop during queued preparation.** A queued item claimed just before Stop
  can start afterwards. Package 2 checks the hold after preparation, inside
  the admitting section.
- **Stop and steer on the effect dispatcher.** Slot detachment and the
  per-kind cap land in the same package, before the handlers are registered.
- **Private Connect grant widening.** Device steering, editing, removal and
  Resume are new powers; the grant text, gateway authorization and audit
  labels must change together.
- **Renderer bundle budget.** The composer queue is a deferred chunk with
  little headroom; the rewrite must stay lazy.
- **Provider coverage.** Steering for Pi and Cursor SDK, steering during
  compaction, the Pi cleared-queue notice and the Codex turn-ownership guard
  need portable fixtures. Windows and Linux behaviour of the stop ladder under
  Stop and send is exercised only where the Electron suite runs
  (`stop-ladder.spec.ts` is POSIX-only).

## 6. Rules on T3 `main` that wait for the next pin

These commits are not ancestors of `de0466fd8`, and their rules are absent
from the pinned source.

| Commit | Rule on `main` | Rule Phase 5 uses (pin) | Affects |
| --- | --- | --- | --- |
| `90f0bac19` | A steer whose turn ended keeps its place, and bumped held items are released by a releasing client send | A `turn-ended` steer is dispatched as a start, behind unheld items; only declined steers are placed (`EW:383-396`) | 2.5, N2 |
| `08804b217` | Any queued message that names no model follows the thread at start | Queue-tail inheritance (`O:1056-1067`); `followsThreadSelection` only for scheduled deliveries (`O:8101-8103`) | 2.2, 2.7, N5 |
| `c38537754` | A message that is only a slash command never steers | Only native maintenance commands queue steers (`CP:73`, `:111-115`) | 2.5 |
| `c5fa33b27` | "Accepted" means a *delivered* provider turn (`promptDropped`), and a cancelled run with a dropped prompt is missed | Accepted = any provider turn (`PTS:173`, `:1080-1082`); missed = `failed`/`interrupted` (`PTS:1149-1155`). The branch already has the Cursor SDK half; Phase 5's requeue predicate is "no provider-turn observation on any attempt" | 2.9 |
| `87707319c` | A provider runtime exit wakes the run whose background work it killed | – | D.6 |

## 7. Not verified

- Whether T3 has an approval-free equivalent of `inertia_answer_question`
  (N15).
- The spike questions (2.1) are design questions; nothing was executed.
- That no V2 turn is ever ordered before a legacy turn (N18 rule 7).
- Windows and Linux behaviour of Stop on the effect dispatcher; the stop
  ladder E2E is POSIX-only.
