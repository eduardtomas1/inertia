# Phase 5 package 1 (core): failure matrix

Companion to [phase5-queue-design.md](phase5-queue-design.md); decision
numbers (N…, C…, H/R/P rules) refer to it. T3 pin v0.1.11 `de0466fd8`. Package 1 starts nothing. It owns:

- enqueue, edit, cancel and reorder;
- the send intent;
- per-item hold and release (rules H1–H5, R1–R4, P1–P2 in
  [phase5-queue-design.md](phase5-queue-design.md) §2.2; H6 is package 3);
- adoption and rebuild.

Each cell gives the expected outcome, then the T3 reference in brackets.
`—` means T3 has no counterpart and the test is written from Inertia's rule.

**Columns.**

- **Crash**: the process is killed during the step. B = before the commit,
  A = after it.
- **Stop**: Stop lands during the step, or the chat is stopping.
- **Rollback**: a history rollback of a turn the item depends on.
- **Route**: the chat's model, provider, access or workspace changes while
  the item waits. Packages 1–2 keep today's route-identity block; package 3
  moves to per-item `modelSelection`.
- **Dup**: the same command id is replayed, or a concurrent second command
  carries the same intent.
- **Restart**: a clean quit and relaunch after the step committed.

**Refs.**

- Source: `O` = Orchestrator.ts, `PRRS` = ProviderRuntimeRecoveryService.ts.
- Tests: `TS` = ThreadStop.test.ts, `SC` = SteeringCompletion.integration.test.ts,
  `RL` = runtimeLayer.test.ts, `TMI` = ThreadMessageIntake.test.ts, `RR` =
  Orchestrator.receipt-race.test.ts, `PR` = ProjectionRecovery.test.ts, `FP` =
  FoundationPersistence.test.ts, `DCD` = DelegatedCompletionDelivery.test.ts.

| Step | Crash | Stop | Rollback | Route | Dup | Restart |
| --- | --- | --- | --- | --- | --- | --- |
| **1. Enqueue, user** (receipt, item event with `{chars, editRevision}`, and the `queued_messages` row: one transaction) | B: nothing written; the renderer journal checks `get` and resends the same id, so one item. A: the item exists [FP:1771] | Waits behind the stopping run. A user's client send releases every held item (R1) [TS:714, SC:3042, O:7849-7870] | Unaffected: not tied to a turn [—] | Keeps its route identity; blocked at dispatch with today's text (pkg 1–2). At the pin, an item naming no model takes the queue tail [O:1056-1067, O:7844] | Same id and text-free form: the original answer, after the text check against the row's `creation_digest` (enqueue) or `intent_digest` at the same `edit_revision` (edit). A concurrent duplicate that joins runs the same check after `await start.result` (`command-authority.ts:73-77`). Old receipts: either fingerprint form is accepted. Other text or payload: `command-conflict`. The receipt holds no text-derived hash (N17). Same id on two chats at once: one wins [RR:47, RL:7512] | Kept and held (H5) until Resume or a user send [RL:10879, PR:141] |
| **2. Enqueue, automatic** (watcher, delegation, managed `mode: queue`, unread follow-up in the settle transaction) | B: the owner re-plans under the same command id. An unread follow-up lost mid-turn is requeued at boot (pkg 2) [O:16572-16590] | Created held when any item is held (H2) [O:7971-7973, O:8023-8031]. An agent's or server send never releases a hold (R1) [TS:714, TS:803] | An unread row of a rolled-back turn is cancelled (`history-rollback-repository.ts:223`). A watcher note whose reviewed turn rolled back is cancelled `stale` at start [RL:7140] | At the pin only delegated completions, monitor notices and scheduled sends without a model follow the thread [O:1026-1043]. Agent items naming no model take the queue tail [O:7844]. A requeued unread follow-up carries the steer's or the ended run's selection [O:3559]. Until pkg 3: a delegated row matches; a watcher note blocks and is skipped; an unread row blocks with its text | `watcher:<id>`, delegation events, `agent-queue:<op>`, `unread-follow-up:<turn>:<msg>`: one item. A requeued unread follow-up keeps its message's own `createdBy`/`creationSource` and carries `steerFollowUpOfRunId` [O:3554-3569] | Held (H5). Owners re-plan; automatic items are never requeued [PRRS:592-603] |
| **3. Edit** (`expectedRevision`; content, attachments) | Atomic: row and `editRevision` change together. Removed attachments are released after the commit, skipping files history still references [RL:692, TMI:434] | Allowed on a held item, which stays held [O:12091+, no hold check] | A requeued unread follow-up is an ordinary user item and can be edited [O:12091+] | pkg 3: an edit may carry a selection [—] | Replay returns the original. A stale revision is refused. An item already `dispatching` is refused ("is not queued") [O:12091-12115] | The edit persists [—] |
| **4. Cancel / remove** | Atomic. Content is wiped (N17) and attachments are released after the commit [RL:11402] | Allowed [RL:11402] | — | — | Replay returns the same answer. Cancelling a delivered or cancelled item is refused (deterministic, receipted) [RL:11402] | Stays cancelled and is never sent. A delegated cancel disposes its cohort (pkg 4) [DCD:1910] |
| **5. Reorder** (server command; no client) | Atomic [—] | Allowed; holds unchanged [—] | — | — | Replay is a no-op. Moving an automatic item, or placing one ahead of a delegated delivery, is refused [O:11945-11981] | Order persists [—] |
| **6. Send intent** (Send now or Resume that cannot start yet, for example during compaction) | A: the intent is recorded, but the H5 hold wins and nothing starts until Resume [RL:10879] | Stop holds (H1); the intent is closed with reason `stopped` [TS:537] | — | — | Replay re-kicks the queue without a second start [O:15900-15905] | As crash A |
| **7a. Hold: H1 Stop, H2 inherited, H3 created held, H6 busy replaced session (pkg 3)** | The hold is in the same transaction as its cause [—] | H1: every queued non-wake item is held. A Stop with nothing to change writes **0 events** [O:13135-13165, TS:537, TS:895] | H3: a declined steer's follow-up whose source run was cancelled is created held [O:8025-8026] | H3: an item whose worktree is missing is created held [O:8025]. H6 (pkg 3): a queued start needing a `restart_and_resume` switch while the replaced session runs background work holds every item; only R1 or R3 releases [O:2775-2804] | Holding an already held item writes nothing [O:13158] | Re-held at boot (H5) [PRRS:592-603] |
| **7b. Release: R1 user send, R2 run completed, R3 Resume, R4 preparation retry** | Atomic with the releasing command or settlement [—] | R2 does not fire when the completed run was stopped [O:3422-3428] | — | R1 does not fire while workspace setup is unresolved [O:7849-7858, RL:9298] | R1: only `createdBy: user` from a client, without `scheduledTaskId` or `steerFollowUpOfRunId` [O:7852-7858]. R2: releases only agent, server and scheduled items, never the user's [O:3407-3450, RL:9225]. R3: everything [O:15766-15777]. R4: releases **every** held item while the failed run is still the latest executed run; it releases nothing once a newer run exists (test with a Stop on a newer run, no stored reason needed) [O:12574-12584] | After boot only R1 or R3 releases the H5 hold [RL:10879] |
| **7c. Pass-through: P1, P2** | — | P1: an agent's or scheduled send to an idle stopped chat starts past the held items, which stay held. P2: a user's send starts and the released items follow it [TS:714 at `:739-747`, `:758-776`, `:788-799`] | — | — | Replay returns the same start [—] | — |
| **8. Boot adoption** (legacy rows at 126 → items at 127) | A per-row transaction under `queue-adopt:<id>`; a rerun adopts the rest [—] | Runs before admission [—] | A row naming a rolled-back message is cancelled [—] | The route identity is copied to the item [—] | Replay is a no-op. A legacy `dispatching` row is released; its old `queue:<id>` receipt is never replayed [—] | Idempotent [—] |
| **9. G6 rebuild and verify** | The rebuild replays only entities, in one transaction, and never touches `queued_messages` (`event-store.ts:255-268`); it is retried at the next boot [—] | — | Reproduces cancelled unread rows [—] | — | Deterministic. Verify flags a non-terminal item whose row is missing or whose `chars`/`editRevision` differ; the item blocks ("text was lost"). Not flagged: terminal rows pruned at 50, and items of deleted conversations (rows cascaded away) [—] | Same entities as before [—] |

**Invariants every cell relies on.**

- Queue events carry no text and no digest. Receipts hold no text-derived
  fingerprint and are purged with the chat (N17).
- Every user command is receipted. Internal dispatch never records a rejected
  receipt.
- `queueHeld` is per item; there is no thread-level hold.
- The order function is pure (`QueuedRunOrder.ts:13-50`).
