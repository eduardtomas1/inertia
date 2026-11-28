# Phase 5 packages 1 and 2: acceptance lists from T3's tests

Companion to [phase5-queue-design.md](phase5-queue-design.md); decision
numbers (N…, C…, H/R/P rules) refer to it. T3 pin v0.1.11 `de0466fd8`. These paths are under
`apps/server/src/orchestration-v2/` unless a full path is given. `file:line`
is the case's declaration at the pin, read with `git archive de0466fd8`. The
case names are quoted exactly; `%s` and `$x` are T3's parameters, and the
parameter values to port are listed after the name.

Rules:

- A ported case keeps T3's name, with "(T3 <file>:<line>)" in the Inertia test
  title, and lands in one commit with the behaviour it proves.
- Skipped cases are listed with a reason. "Inverted" means that a recorded
  Inertia difference changes the expected outcome; the case is still ported,
  with Inertia's expectation.
- When T3 has no test for a rule (marked "Inertia-authored"), the test is
  written from the pinned code anchor.

## Package 1: core

### Port

| T3 file:line | Case | Notes |
| --- | --- | --- |
| `QueuedRunOrder.test.ts:14` | "delivers completions and queued messages in request order, keeping manual queue order" | Pure order function, including the coalesced mailbox's earliest request time |
| `runtimeLayer.test.ts:11402` | "edits and removes queued runs" | `message.queue.edit` and `remove`; `expectedRevision` added |
| `runtimeLayer.test.ts:692` | "a queued edit's cleanup keeps a file earlier history still shows, with %s" | All parameter values; Inertia attachment GC |
| `ThreadMessageIntake.test.ts:434` | "refuses a queued edit that keeps a file another edit already deleted" | |
| `runtimeLayer.test.ts:7512` | "persists rejected command receipts across retries" | Queue commands under G5 |
| `Orchestrator.receipt-race.test.ts:47` | "a command id reused concurrently for two threads succeeds for only one" | The cross-thread race test the 11-14 delta found missing |
| `FoundationPersistence.test.ts:1771` | "rolls back events, projections, receipts, and effects after a projection failure" | A queue event and its compatibility row commit or roll back together |
| `ProjectionStore.test.ts:1626` | "SQL queue readiness skips held runs without bypassing active work" | Per-item `queueHeld` |
| `packages/client-runtime/src/operations/commands.test.ts:147` | "distinguishes sending a selected queued message from resuming queue order" | Contract: `message.queue.send {id}` vs `message.queue.resume` |
| `packages/client-runtime/src/state/threadWorkflows.test.ts:88` | "sorts queued messages and gates promotion from capabilities" | Order half here; promotion gating goes to package 2 |

### Inertia-authored (no T3 test at the pin)

- Reorder refuses moving an automatic item or placing one ahead of a delegated
  delivery (`Orchestrator.ts:11945-11981`); reorder of a dispatched item is
  refused.
- Caps: 20 user plus agent items, one delegated delivery, one waiting note
  per watcher, five notes in total. Requeues (requeue marker) are exempt
  (design 4.1).
- Content by reference: no queue event payload contains the text, and
  deleting a chat leaves no queued text behind (N17).
- Upgrade from the 126 fixture plus boot adoption gives the old `list()`
  order. A G6 rebuild reproduces the same items, including unread follow-up
  rows.
- The spike's ten answers and its reader table (2.1) are recorded.
- Receipts (N17):
  - Queue and send receipts hold no text-derived fingerprint.
  - A same-id replay with other text is `command-conflict` through the row's
    text check. This includes a concurrent duplicate that joins the first
    command.
  - Replaying the original enqueue after a later edit still succeeds
    (`creation_digest`).
  - A receipt written before the upgrade replays under its old fingerprint.
  - Deleting a chat, or a project with chats, deletes their receipts.
  - Migration 127 deletes receipts of chats deleted before the upgrade and
    leaves live chats' receipts alone.
- Verify: an item of a deleted chat is not flagged; a waiting item with a
  missing or mismatched row is (N17).

### Skipped

| T3 file:line | Case | Reason |
| --- | --- | --- |
| `ThreadMessageIntake.test.ts:482` | "a queued /logout edit without provider management must keep an attachment" | Inertia has no text maintenance commands |
| `GuestShare.test.ts` (all) | – | No guest share (4.4, N12) |
| `runtimeLayer.test.ts:11660`, `:11848` | snooze cases | No snooze |
| `runtimeLayer.test.ts:7810` | "keeps a linked environment's sender on started and queued messages" | No linked environments |
| `Orchestrator.control-reads.test.ts:2671`, `:580` | "queued-message commands read a long thread's history without walking all of it"; "dispatches metadata, queue resume and request controls without hydrating unrelated history" | T3 projection-read performance. Optional: a query-plan snapshot for the queue reads |
| `FoundationPersistence.test.ts:4145` | "allocates collision-free positions beyond 100 items and rebuilds equivalently" | Turn-item positions, not queue positions |
| `DispatchModeLimit.test.ts:311` | "starts a queue that waited above the ceiling once the mode is lowered" | No organization ceiling |
| `DelegatedCompletionDelivery.test.ts:1910`, `:1135` | queued completion wake cancel and rewrite | Package 4 |
| `packages/client-runtime/src/queuedRunEdit.test.ts` (all) | – | Renderer edit state: package 5 (`:45` is N11, renderer only) |

## Package 2: runtime

### Port: Stop, hold and Resume

| T3 file:line | Case | Values / notes |
| --- | --- | --- |
| `ThreadStop.test.ts:537` | "%s Stop ends watches, holds queues, and stops the delegated tasks under the thread" | `run.interrupt`, `thread.stop`; only the queue-hold and delegated-stop assertions (no watches) |
| `ThreadStop.test.ts:658` | "%s cancels buffered wakes and preserves durable queued messages" | Durable half only (no buffered wakes) |
| `ThreadStop.test.ts:714` | "a message the user sends after Stop releases the held queue; an agent's does not" | All four steps: an agent send starts past the held item (P1, `:739-747`); a scheduled send likewise (`:758-776`); a user send starts and the held item follows it (R1/P2, `:788-799`). This is also #761 difference (a) |
| `ThreadStop.test.ts:803` | "an agent's auto send queues behind a run that is still stopping instead of steering it" | N10, moved to package 2 |
| `ThreadStop.test.ts:895` | "thread.stop ends an idle thread's watches and accepts a thread with nothing to stop" | The idle half: a Stop with nothing to stop or hold writes 0 events (`:915`); with unheld queued items it holds them (H1) |
| `ThreadStop.test.ts:1056`, `:1108` | "thread.stop keeps a restart continuation of the stopped run from starting"; "a successful %s blocks a newer restart continuation when completion timestamps tie" | Inertia's app-update continuation |
| `ThreadStop.test.ts:1764` | "%s ends a running run whose provider turn already completed" | `Stop` only (see skipped) |
| `ThreadManagementService.test.ts:971` | "Force stop refuses once a newer run has started, before killing anything" | Adapt to G5 escalation: never tears down a run that started during cleanup |
| `runtimeLayer.test.ts:10405` | "keeps the queue after a user interrupts the active run" | |
| `runtimeLayer.test.ts:10879` | "preserves and holds queued messages across $trigger with started=$started until explicitly resumed" | All 4 rows |
| `runtimeLayer.test.ts:12767` | "manually resumes an %s run ahead of its queued message only once" | `interrupted`; `usage_limit` adapted to the limit-reset resume |
| `packages/client-runtime/src/operations/commands.test.ts:309` | "sends fallback text only on empty manual continuations for servers without native resume" | Server side of N7: "Continue where you left off." |
| `packages/client-runtime/src/state/threadExecution.test.ts:240` | "offers to resume an interrupted run on $name" | As a `native-resume` capability read-model test |

### Port: claim, start and drain

| T3 file:line | Case | Values / notes |
| --- | --- | --- |
| `runtimeLayer.test.ts:1882` | "resolves delivery intent against the active run and starts after it completes" | |
| `runtimeLayer.test.ts:2058` | "starts an idle thread's queued run while another thread's lock is busy" | |
| `runtimeLayer.test.ts:8408` | "promotes only one queued run after each terminal run (notification: %s)" | `false` only (no notifications) |
| `runtimeLayer.test.ts:8942` | "handles a queued message after a %s failure" | `usage_limit`, `provider_error` |
| `runtimeLayer.test.ts:9225` | "releases held agent messages once a later run completes, not the user's" | R2 (`releaseUnattendedHolds`); #761 queue items (difference h) |
| `runtimeLayer.test.ts:9298` | "keeps held agent messages while the thread's worktree setup is unresolved" | N9 |
| `runtimeLayer.test.ts:10457` | "places held queued messages after a continuation that started first" | |
| `runtimeLayer.test.ts:10565` | "starts the queue before a send that arrives as the active run ends (worktree failed: %s)" | Both values; the 7a72fe301 race test |
| `runtimeLayer.test.ts:11586` | "interrupts a pending provider start without launching provider work" | T3 asserts `interrupted` with no provider turns (`:11643-11653`). On **Codex**, Inertia's run is `cancelled` with `delivery: not-delivered`: assert that its text is carried as missed history (matches T3) and, after C1, its images too. On other harnesses, assert today's behaviour (prompt credited) and reference the open acceptance item |
| `ProjectionStore.test.ts:11343` | "keeps undelivered queued input out of forks taken after a later run" | |
| `packages/client-runtime/src/state/threadWorkflows.test.ts:88`, `:181` | promotion gating; "does not offer send now while a turn is %s" | As server refusals: "A queued user message can only be sent now while the thread is stopped." |

### Port: steering, stop and send, unread follow-ups

| T3 file:line | Case | Values / notes |
| --- | --- | --- |
| `SteeringCompletion.integration.test.ts:57` | "delivers $label when completion wins $timing" | Rows `during delivery`, `before dispatch`, `after delivery`, `without native steering`, `settled only`, `during continuation` |
| `SteeringCompletion.integration.test.ts:803` | "sends a selected held message once and preserves the remaining queue order" | |
| `SteeringCompletion.integration.test.ts:894` | "delivers a deferred steer for a $status run (direct: $direct)" | Every row except `starting, direct:false` (T3 restarts the same run there) |
| `SteeringCompletion.integration.test.ts:1116` | "force sends multiple queued messages and can force send a requeued message again" | |
| `SteeringCompletion.integration.test.ts:1186` | "keeps a message queued when send now races with a running turn" | |
| `SteeringCompletion.integration.test.ts:1442` | "persists a declined steer without blocking the worker: %s" | `complete`, `stop-before-decline`, `stop-after-decline`, `two-steers`; `queued-model` goes to package 3 |
| `SteeringCompletion.integration.test.ts:1647` | "queues a steer until the turn ends when the provider cannot steer it" | |
| `SteeringCompletion.integration.test.ts:1721` | "delivers agent messages queued behind /compact before a later one steers" | `0a159c9fb`; `/compact` becomes Inertia's compaction state |
| `SteeringCompletion.integration.test.ts:2324` | "rejects expanded steering input before commit: %s" | `auto`, `deferred`, `promote-edited`; bounded input |
| `SteeringCompletion.integration.test.ts:2746` | "keeps a queued message queued when promoted into a run that Stop reached" | |
| `SteeringCompletion.integration.test.ts:2801` | "refuses a steer after Stop (provider turn ready: %s)" | Both |
| `SteeringCompletion.integration.test.ts:2886` | "starts a restart that missed the turn ($status, run settled: $settled) as a new turn" | All 5 rows |
| `SteeringCompletion.integration.test.ts:2989` | "queues a restart sent into a provider turn that failed before its run settled" | |
| `SteeringCompletion.integration.test.ts:3042` | "queues a plain send behind the stopped queue and releases its hold" | |
| `SteeringCompletion.integration.test.ts:3222` | "restarts by stopping the running turn when the provider cannot interrupt-restart" | Inertia uses this for every provider (4.6) |
| `SteeringCompletion.integration.test.ts:3256` | "starts a restart that stops the running turn ahead of an older held queue" | |
| `SteeringCompletion.integration.test.ts:3323` | "reports a restart that stops the running turn as restarted" | Plus the #761 `mode: restart` result |
| `SteeringCompletion.integration.test.ts:3366` | "replays an accepted steer after its target turn completes" | `f69b3a27a` |
| `ClaudeAutomaticDelivery.integration.test.ts:1037` | "handles an unread steer when %s" | All four: "Claude cancels it twice", "the Claude process exits", "the server restarts", "Claude cancels it and the user stops" (N14 notice) |
| `ProviderRuntimeRecoveryService.test.ts:422` | "recovery closes a secret card but leaves a link card and an unread steer open" | Unread-steer half |
| `ProviderRuntimeRecoveryService.test.ts:525` | "recovers $0 work after restart" | `queued`, `preparing`, `starting`, `starting-other-request`, `starting-own-request`, `starting-steered`, `running`. Delegated, scheduled and resume rows go to the recovery phase |
| `ProjectionRecovery.test.ts:141` | "%s cancels queued buffered wakes and holds durable messages" | Durable half |
| `CommandPolicy.test.ts:68`, `:123`, `:170`, `:255` | "resolves automatic message delivery from authoritative provider capabilities"; "queues an automatic message while the handoff run is %s"; "queues a steer for a provider that cannot steer either way"; "queues a steer sent while %s runs" | `:255` as compaction, not text |
| `testkit/ProviderSwitch.integration.test.ts:3255`, `:3366` | "runs a provider switch steered into a Claude turn that %s after that turn"; "refuses a provider switch steered into a Claude turn that Stop reached" | `0597532f1` (2.5 step 2) |

### Port: Stop and steer on the effect dispatcher

| T3 file:line | Case | Values / notes |
| --- | --- | --- |
| `EffectWorker.test.ts:187` | "$name" | Row 1 "settles a stopped run when its adapter has already lost the native turn". Row 2 is **inverted**: G5 escalates automatically instead of flagging Force stop |
| `EffectWorker.test.ts:340`, `:411`, `:486`, `:543`, `:607` | "requeues a claim when a pre-execution worker check fails"; "keeps requeueing a failed claim while the database is locked"; "interrupts $name settlement retries when the worker shuts down"; "arms cancellation before the durable pre-execution check"; "terminalizes a process-bound claim when success settlement fails" | |
| `FoundationPersistence.test.ts:2079`, `:2211`, `:2535`, `:2596`, `:2655`, `:2708`, `:3134`, `:3202`, `:3415`, `:3839` | "does not publish a stale provider start after an interrupt wins"; "refuses a run-current write once an unpaired interrupt request is stored"; "interrupts a running process-bound effect when it is cancelled"; "does not resolve awaitSettled waiters until the cancel is signalled"; "does not start an effect that was cancelled during claim registration"; "allows only one worker to claim an available effect"; "keeps later thread effects behind an earlier effect waiting to retry"; "runs distinct threads concurrently while serializing effects within a thread"; "does not reclaim a running effect after its process-local lease expires"; "atomically cancels stale runs and their process-bound effects" | |
| `FoundationPersistence.test.ts:3385`, `:3485`, `:3569` | "holds pending titles at the running-title cap without waking idle workers"; "starts later thread work behind a delegated-task stop that never returns (replayed: $replayed)"; "starts another thread's turn while every worker holds a start that never returns" | Per-kind cap and 30 s slot detachment |

### Inertia-authored hold cases (T3 rules without a dedicated T3 test)

- H2: a new item is created held while any item is held (`O:7971-7973`,
  `:8023-8031`).
- H3: an item whose worktree is missing is created held, as is a declined
  steer's follow-up whose source run was cancelled (`O:8025-8026`).
- R1 via a `turn-ended` composer steer releases every held item
  (`EW:383-420`, `O:7849-7870`).
- R4: a preparation retry releases every held item while the failed run is
  still the latest executed run, and nothing once a newer run (for example
  one Stop reached) exists. The test needs no stored hold reason
  (`O:12574-12584`).
- R2 before requeue: an agent's requeued unread steer is created held while
  a user item is held (`O:16290-16300`, H2).
- Unread follow-ups keep their message's own `createdBy`/`creationSource`,
  carry `steerFollowUpOfRunId`, and never release holds (`O:3557`,
  `:3568-3569`, `:7850-7854`).
- H6 (busy replaced session) is listed for package 3, not ported here.
- C2: a message named by an active unread row is not copied into a fork
  (`fork-history.ts:38-44`; T3 `ProjectionStore.test.ts:11343`).

### Inertia contract tests (must keep passing)

- `#761`, `origin/main:tests/server/agent-thread-manager.test.ts:2090-2300`:
  all nine "inertia_send_message modes" cases, changed only as the design's N19
  says. Must change: `:2196` (held half, difference a), `:2240` (restart,
  b) and `:2164` (cap, d). Unchanged: `:2115` (fixtures run supervised, `atm.test.ts:37-39`), `:2130`, `:2150`, `:2224`, `:2267` (recorded deviation c),
  `:2284`. New cases: e (Full Access, no card), f, g, h (running chat), i.
- `origin/main:tests/server/queued-message-runtime.test.ts:1042`: "wait in
  the child's own queue behind the running turn, refuse a fourth, and send
  after the turn completes", with "a fourth" becoming the 21st user or agent
  item.
- The branch's unread follow-up cases in
  `tests/server/claude-follow-up-settlement.test.ts` and
  `tests/server/queued-message-runtime.test.ts` (landed in `799ddb00f`), plus
  a new crash-mid-turn case: the follow-up is requeued at boot.

### Skipped

| T3 file:line | Case | Reason |
| --- | --- | --- |
| `ThreadStop.test.ts:1652` | "an unanswered Stop is flagged until Force stop ends the run with its own reason" | Recorded difference: automatic stop escalation (AGENTS.md process-tree termination) |
| `ThreadManagementService.test.ts:840` | "Force stop $name" | Same reason |
| `ThreadStop.test.ts:1990` | "Force stop keeps only the session of a queued follow-up that $followUp" | Force stop; the `fresh context` row is dormant (N6) |
| `ThreadStop.test.ts:168`, `:513`, `:614`, `:1203`, `:1273`, `:1355`, `:1844` | delegated and native-child Stop cases | Phase 4/D.1 scope; `:614` "a repeated Stop that changes nothing" is covered by the matrix row 7 test |
| `ThreadStop.test.ts:919`, `:975`, `:1310` | watch cases | No pull-request watches |
| `SteeringCompletion.integration.test.ts:1224`, `:2699` | "steers a changed turn-scoped selection into a running turn the provider could restart"; "marks the model switch on a promoted message that restarts the turn" | Same-run restart is never written (4.6) |
| `SteeringCompletion.integration.test.ts:1297` | "restarts the turn for an image when native steering takes text only" | **Inverted** (N3): explicit Send now becomes stop-and-send; automatic follow-up queues. Ported in package 4 with `steerAcceptsAttachments` |
| `SteeringCompletion.integration.test.ts:1357`, `:2470` | missed-steer selection; promoted queued message keeps its selection | Package 3 (per-item selection) |
| `SteeringCompletion.integration.test.ts:712`, `:2510`, `:2633`, `:2665`, `:3156`, `:3184`, `:3455`, `:3475`, `:3508`, `:3596`, `:3647`, `:3688` | goal, scheduled-delivery and side-chat cases | No text `/goal`, no scheduled deliveries, no side chats |
| `SteeringCompletion.integration.test.ts:2090`, `:2154`, `:2181` | completion-wake restart cases | Same-run restart; delegation is package 4 |
| `SteeringCompletion.integration.test.ts:2220` | "keeps a held commentary draft before the steer when turn end flushes it" | Stream rendering; optional in package 5 |
| `CommandPolicy.test.ts:217`, `:239`, `:291`, `:304`, `:325` | Grok; Cursor steer in place; forks | No Grok harness; Cursor steering is package 4; forks are D.5 |
| `runtimeLayer.test.ts:9347`, `:9511`, `:9645`, `:9758`, `:9867`, `:9949`, `:10124`, `:10215`, `:10306`, `:13681` | selection, usage-limit-per-provider and disabled-instance cases | Package 3 |
| `runtimeLayer.test.ts:10697`, `:11070` | restart continuation before prompt; delegated prompt resent after a cut | Recovery phase (unattended resend, `MAX_RESENDS`) |
| `runtimeLayer.test.ts:11186`, `:11261`, `:8014`, `:8302`, `:2996` | buffered provider wakes; settle; archive; merge-back targets | No buffered wakes or settle; archive and merge-back are outside Phase 5 |
| `EffectWorker.test.ts:259`, `:304`, `:675`, `:717`, `:786` | checkpoint-restore failure texts; answer delivery; delegated restart; native subagent stop; process-loss count | Not queue or Stop behaviour |
| `packages/client-runtime/src/state/threadExecution.test.ts:439`, `:505` | "presents a held queue as the stopped run instead of queued work"; "does not expose a queued-only run as interruptible" | Package 5 renderer |
| `DelegatedCompletionDelivery.test.ts` (queue cases) | – | Package 4 |

### Note on `main`

`SteeringCompletion.integration.test.ts` changed after the pin in `90f0bac19`
(turn-ended placement). Port the **pinned** version of `:1442` and `:2886`,
not `6f49071a3`'s.
