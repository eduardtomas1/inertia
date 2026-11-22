# Phase 5 package 2 (runtime): failure matrix

Companion to [phase5-queue-design.md](phase5-queue-design.md); decision
numbers (N…, C…, H/R/P rules) refer to it. T3 pin v0.1.11 `de0466fd8`. Columns are as in the package 1 matrix: **Crash**
(B = before the commit, A = after), **Stop**, **Rollback**, **Route**,
**Dup**, **Restart**. Hold rules H1–H6, R1–R4 and P1–P2 are in
[phase5-queue-design.md](phase5-queue-design.md) §2.2.

Note: H6 is package 3.

**Refs.**

- Source: `O` = Orchestrator.ts, `EW` = EffectWorker.ts, `CP` =
  CommandPolicy.ts, `PTS` = ProviderTurnStartService.ts, `PRRS` =
  ProviderRuntimeRecoveryService.ts.
- Tests: `TS` = ThreadStop.test.ts, `SC` = SteeringCompletion.integration.test.ts,
  `RL` = runtimeLayer.test.ts, `PRT` = ProviderRuntimeRecoveryService.test.ts,
  `EWT` = EffectWorker.test.ts, `FP` = FoundationPersistence.test.ts, `TMS` =
  ThreadManagementService.test.ts, `PS` = testkit/ProviderSwitch.integration.test.ts,
  `CAD` = ClaudeAutomaticDelivery.integration.test.ts.

Stop and steer run on the effect dispatcher. No in-memory state outlives a
lane section.

| Step | Crash | Stop | Rollback | Route | Dup | Restart |
| --- | --- | --- | --- | --- | --- | --- |
| **1. Claim** next unheld item (`queue:<item>:<n>`; `dispatching`) | A, no run yet: boot releases it (`runtime-lost`) and holds (H5) [PRRS:220-280] | Hold re-checked inside the admitting section; a claimed item Stop reached stays queued and held [O:2455-2700] | Refused while a run is active; the item is unaffected [—] | Admission re-validates the route; a mismatch blocks (pkg 2). At start, a failed provider, disabled instance or missing worktree holds all (H4) [O:2579-2606]. Pkg 3: a switch whose replaced session is busy holds all (H6) [O:2775-2804] | One claim per terminal run; a second drainer is a no-op [RL:8408, RL:2058] | Released and held [RL:10879] |
| **2. Admission** (`run.accepted`, compatibility turn and message rows, item `delivered`: one transaction) | B: as step 1. **A, before the first provider-turn observation:** boot ends the run `interrupted` with `delivery: not-delivered`. The compatibility turn and message rows stay. The item is requeued at the front, held, naming that message (`user_message_id`), so re-admission moves it into the new turn through `adoptUndeliveredPrompt` (spike Q10). It cannot use `adoptUnreadFollowUp`, whose guard refuses a turn's own prompt (`turn-ledger-repository.ts:382`). The emptied turn is retired as superseded; portable history leaves the named message out, so its text is never sent twice. The turn's `checkpoint.capture-requested` is replay-safe: captured with no file changes, a valid rollback boundary. T3 instead rewinds the same run to queued [PRRS:264-268, PRRS:563-603, PRT:525] | The run ends without a provider turn. T3 ends it `interrupted` with no provider turns and carries its text and images as missed history [RL:11586 at `:11643-11653`; PTS:1149-1155, `:1182-1210`, `:2002-2025`]. **Codex** (declares `turn-acceptance`): Inertia marks it `not-delivered` and resends the text, matching T3; its images drop because Inertia settles it `cancelled` (correction C1, decided by the user on 2026-11-22; non-Codex harnesses are gated per harness on the smoke session). **Other harnesses:** the prompt is credited and nothing is resent, unlike T3 (recorded open item on non-Codex acceptance). Resume is offered where the provider lacks native resume [`orchestrationV2ManualContinuation.ts:3-33`] | — | Refused while running (pkg 1–2) [—] | Receipt replay returns the same turn and message (`turn-repository.ts:128-133`) [RR:47] | As crash A [PRT:525] |
| **3. Provider start** (first provider-turn observation) | Accepted but unobserved: requeued held; the user decides, so no automatic duplicate. Observed: boot interrupts the run, no requeue [PRRS:220-280] | `provider.interrupt` on the dispatcher. Unconfirmed: G5 automatic escalation (T3 flags it for Force stop: kept difference) [EW:249-327, EWT:187] | — | Refused while running [—] | `provider.start` is process-bound, never retried [FP:2079] | Interrupted and held [RL:10405] |
| **4. Steer** (Send now, composer auto, delegated; `provider.steer` effect) | Effect running at the crash: retired `runtime-lost`; the item blocks ("did not confirm") and is never resent. Accepted without a read mark: requeued at its N2 place at boot [O:16572-16590, PRT:422] | A steer into a run Stop reached is refused [SC:2801]; a promoted item stays queued [SC:2746]. Accepted but unread at Stop: cancelled, with the notice "Steer delivery not confirmed" and its text (N14) [O:3484-3524] | The ended run rolled back: its unread rows are cancelled (branch) [—] | Another instance on Claude/Pi: queues behind the turn [CP:104-126, PS:3255, PS:3366]. Others: stop and send (2.5) | Accepted steer replays after the turn ended [SC:3366]. Declined: placed after the items queued before it; created held if its source run was cancelled (H3) [EW:383-396, O:8025-8026, SC:1442]. **Turn-ended: re-dispatched as the user's client send without `steerFollowUpOfRunId`, so it goes behind unheld items and releases every held item (R1)** [EW:383-420, O:7849-7870, O:15953-15969] | Unread steers: requeued at their place, then held [CAD:1037] |
| **5. Deferred steer** (`steerWhenReadyRunId`) | The run ends at boot; the field is dropped and the item stays queued, held [O:16379-16404] | Held with the queue (H1) [TS:658] | — | Keeps the selection it was queued with [SC:1357] | Per attempt: `queue:<item>:steer-when-ready:<run>:<attempt>` [O:16404, SC:894] | Held [RL:10879] |
| **6. Settlement and drain** (in T3's order: R2 if completed and not stopped, then requeue unread steers, then start next [O:16290-16300]) | A: unread rows are in the settle transaction; boot holds the queue [O:16285-16305]. Because R2 runs **before** the requeue, an agent's requeued unread steer is created held under H2 while any user item is still held, and waits for R1 or R3 | A completed run that Stop reached releases nothing (R2) [O:3422-3428]. Failed or usage-limited run: held (H4) or computed hold [RL:8942, RL:9347] | Rolling back the settled turn cancels its unread rows [—] | An idle change is allowed; the item blocks (pkg 1–2) [—] | A send in the drain gap waits behind unheld items; restart continuations are exempt [O:15953-15969, RL:10565]. R2 releases agent, server and scheduled items only [RL:9225] | Held [RL:10879] |
| **7. Stop** (interrupt recorded, `provider.interrupt` effect and per-item holds: one transaction) | A: the effect is retired `runtime-lost`; boot interrupts the run; held [EW:249-327, FP:3839] | A repeated Stop holds nothing new; delegated work is still stopped [TS:614] | Refused until the run is terminal [—] | Refused while stopping [—] | Same command id replays. **An idle Stop with nothing to stop or hold writes 0 events**; with unheld queued items it holds them (H1) [TS:895 at `:915`, O:13135-13165] | Held until R1 or R3 [TS:714] |
| **8. Stop and send** (Stop, the item at position 1 created unheld, `afterStopOf`: one transaction) | A: position 1 is kept, but boot holds every item, this one included (H5) [PRRS:592-603] | A second Stop holds it too (H1) [O:13135-13165] | — | Instance switch on Claude/Pi: queues behind, no stop [PS:3255] | Replay. Target already ended: a start [SC:2886]. Stop already reached: queued behind the stopping run [SC:2989, SC:3042]. A delegated result requested earlier still goes first [SC:3222, SC:3256, SC:3323] | Held [RL:10879] |
| **9. Resume** (native continue, else release all (R3) and start) | Atomic; a replay re-kicks [O:15900-15905] | Holds again (H1) [TS:537] | — | — | Refused while workspace setup is pending or failed, or while a usage limit holds the next provider [O:15742-15763]. Resumes once only [RL:12767] | Releases the H5 hold [RL:10879] |
| **10. Agent or scheduled send to an idle, held chat** (P1) | Atomic [—] | Starts past the held items, which stay held; the next completed run releases held agent and scheduled items (R2) [TS:714 at `:739-776`, RL:9225] | — | Agent item naming no model: queue tail [O:7844] | Receipt replay [—] | Held items stay held [—] |
| **11. Boot reconciliation** (per chat, one lane section, before admission) | Idempotent: rerun with the same command ids [—] | A Stop recorded before the crash: unattended resends are skipped [PRRS:477-498] | — | — | `MAX_RESENDS` = 3 (recovery phase) [PRRS:62] | Same result [PRT:525] |

**Managed sends (#761, see the design's N19).**

- `mode: queue` follows rows 1–2 and 10: it is created held under H2 on a
  running chat, and starts at once on an idle held chat (P1).
- `mode: steer` follows row 4; when the turn has ended it returns
  `STEER_ENDED`.
- `mode: restart` follows row 8, with the turn captured before approval (a
  recorded deviation).

**Force stop.** A run that started during cleanup is never torn down
[TMS:971].
