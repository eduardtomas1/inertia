# T3 Code delta `15fe2832` → `b05c505b` against ORCHESTRATOR V2

Recorded 2026-11-14. This document re-baselines ORCHESTRATOR V2 onto T3 Code's
current orchestrator. It merges three slice reviews (core command, event,
effect and run model; queues, steering, delegation and clients; context
handoff, backings, forks and providers), removes their overlap, and keeps only
claims that were read in the upstream code. It supplements
[t3code-delta-2026-10-31.md](t3code-delta-2026-10-31.md), whose format it
follows, and it is the source for the decisions in
[phase5-queue-design.md](phase5-queue-design.md) section 4.

Updated by [t3code-delta-2026-11-17.md](t3code-delta-2026-11-17.md), which
covers T3 `b05c505b` → `b387e3a17` and supersedes rows of sections D and E
where it says so (for example the delegated-wait times).

**Rule.** T3 Code's current orchestrator is the reference for every decision.
Inertia keeps a deliberate difference only where an invariant in `AGENTS.md`
forces it, or where it is an explicitly recorded architecture choice. Section
E lists each difference with that reason, or marks it for closing.

## Range and conventions

| Item | Value |
| --- | --- |
| Upstream start | `15fe2832727893cbdd2214383f9f971474849695`, committed 2026-10-31 14:54:48 UTC (the previous pin) |
| Upstream end | `b05c505b9c72336e0f0e1b5b39b1d9811a925cc3`, committed 2026-11-14 15:15:39 UTC |
| First-parent commits | 2,669 (whole repository) |
| Inertia comparison base | branch `orchestrator-v2` at `652ba6c18`, plus the uncommitted G9 working tree of 2026-11-14 (`implementation-progress.md`, entry "G9") |

### Release boundaries

| Release | Tag commit | Date (UTC) | In this range |
| --- | --- | --- | --- |
| v0.1.7 | `322f6544d` | 2026-11-04 00:41 | `15fe2832..322f6544d` |
| v0.1.8 | `bf469bb19` | 2026-11-09 20:17 | `322f6544d..bf469bb19` |
| v0.1.9 | `24e77473e` | 2026-11-11 09:11 | `bf469bb19..24e77473e` |
| unreleased `main` | `b05c505b` | 2026-11-14 15:15 | `24e77473e..b05c505b` |

Most of the behavior that matters here landed after v0.1.9 and is not yet in a
stable T3 release: of the 227 upstream commits cited by the slice reviews, 41
are in v0.1.7, 27 in v0.1.8, 14 in v0.1.9 and 145 only on `main`. Tables give
the release as `0.1.7`, `0.1.8`, `0.1.9` or `main` where it matters for
sequencing. Unreleased behavior is still the reference under the rule, but it
is the part most likely to change again; a later re-pin should re-check rows
marked `main` first.

### Conventions

- T3 anchors are `path:line` at `b05c505b`, relative to the T3 repository
  root. Abbreviations: `O` = `apps/server/src/orchestration-v2/Orchestrator.ts`,
  `C` = `packages/contracts/src/orchestrationV2.ts`,
  `CP` = `apps/server/src/orchestration-v2/CommandPolicy.ts`,
  `M` = `apps/server/src/mcp/OrchestratorMcpService.ts`.
- Inertia anchors are `path:line` in the `orchestrator-v2` worktree. Other
  packages are editing that tree; cited symbols are the reference if lines
  move.
- Method: every first-parent title in the range was triaged by slice
  keywords. Diffs were read for every commit touching the core services
  (EffectWorker, EffectOutbox, EventSink, ProjectionMaintenance,
  CommandPolicy, DispatchModeLimit, ProviderRuntimeRecoveryService,
  RestartContinuation, ProviderTurnControlService, the Stop paths,
  ScheduledTaskService), the context services (ContextHandoffService,
  ContextHandoffDelivery, ProviderTurnStartService, ProviderSwitchService,
  CheckpointRollbackService, ThreadForkService, `handoffBudget.ts`), and for
  about 110 queue, steering, delegation and client commits. Provider-package
  commits were triaged by title and read where they touch session identity,
  resume, fork, rollback, history or cwd. Upstream code and tests were read,
  not executed.
- Status vocabulary: **satisfied** (an Inertia file or test proves it),
  **partial**, **different** (a deliberate Inertia design, section E),
  **not satisfied**, **adopted** (in progress in a named package),
  **assigned** (deferred to a named phase), **not started**, **not assessed**
  (Inertia code not compared; no claim either way), **n/a**.

### Scope facts

Byte-unchanged in the range: `apps/server/src/scheduling/` (Scheduler,
DueHint), `QueuedRunOrder.ts`, `ThreadCommandExecutor.ts`,
`CommandReceiptStore.ts`, `EventStore.ts`, `ProviderSessionTransitionPolicy.ts`,
`CheckpointRestoreSafety.ts`, `AttachmentClaims.ts`, `LiveStreamBudget.ts`
(all under `apps/server/src/orchestration-v2/`) and
`apps/server/src/mcp/delegatedTaskModes.ts`.

Unchanged in substance:

- `OrchestrationV2RunAttempt` (`C:770-793`): reasons are still
  `initial | steering_restart | retry | provider_recovery`, statuses still
  include `superseded`. Only `initial` and `steering_restart` are written;
  no non-test source writes `provider_recovery` or `retry`. Inertia's G9
  `provider_recovery` replacement remains an Inertia extension.
- `OrchestrationV2RunStatus` (`C:638-649`) and the contract of
  `writeIfRunCurrent` (active attempt plus expected status).
- Stop still ends in `thread.interrupt.unresponsive` and a user Force stop,
  with no automatic escalation (`apps/server/src/orchestration-v2/EffectWorker.ts:200-230`).
- Delivery order: delegated completions first, then `queuePosition ?? ordinal`
  (`QueuedRunOrder.ts:12-31`). T3 still has no cap on queued user runs.
- `resolveDeliveryIntent` (`CP:154-192`) and `decideSteeringExecution`
  (`CP:267-289`).
- `decideProviderSessionTransition` still returns `restart_and_resume` for an
  instance, runtime-mode or workspace change of a continuation-compatible
  session (`ProviderSessionTransitionPolicy.ts:55`, `:73-75`).
- History injection: there is no `historyInjection` capability. It is the
  optional adapter method `ProviderAdapterV2SessionRuntime.injectHistory`
  (`packages/provider-core/src/server/ProviderAdapter.ts:730-736`), implemented
  only by Codex (`Adapters/CodexAdapterV2.ts:7852-7871`). Both predate the pin.

New contract fields:

| Field | Where | Commit |
| --- | --- | --- |
| `steerWhenReadyRunId` | run, `C:737` | `b20bbc595` (main) |
| `freshContext` | run `C:760`, dispatch `C:3356` | `e139768a7` (0.1.8) |
| `manualContinuationOfRunId` | run | `9e19b7f7e` (main) |
| `usageLimitContinuationOfRunId` | run | `240446e2d` (0.1.8) |
| `steerFollowUpOfRunId`, `steerFollowUpAfterRunOrdinal` | dispatch, `C:3369-3370` | `2248ca8db` (main) |
| `followsThreadSelection` | message, `C:1390` | `beb528ce4` (main) |
| `thread.settle.expectedLatestRunId` | command | `6f54322e4` (0.1.8) |
| `activeSteeringAcceptsAttachments` | turn capabilities, `C:303` | `55e253856` (0.1.7, with Kiro) |
| `activeSteeringDuringCompaction` | turn capabilities, `C:305` | `b3f5d5270` (main) |
| `supportsNativeGoals` | turn capabilities, `C:294` | `0e2841d5a` (0.1.9) |

Steering capabilities at `b05c505b`:

| Provider | Active steer | Interrupt-restart | Anchor |
| --- | --- | --- | --- |
| Codex | yes, also during automatic compaction | yes | `Adapters/CodexAdapterV2.ts:278-286` |
| Claude | yes, interrupts tools | no | `Adapters/ClaudeAdapterV2.ts:527-533` |
| Cursor SDK | yes (new, `2248ca8db`), text only | yes | `packages/provider-cursor/src/server/adapter.ts:104-110` |
| Pi | yes | no | `packages/provider-pi/src/server/adapter.ts:124-126` |
| OpenCode | yes | yes | `packages/provider-opencode/src/server/adapter.ts:135-137` |
| Kiro | yes, text only | not declared | `packages/provider-kiro/src/server/adapter.ts:77-80` |
| Generic ACP | no | yes | `packages/provider-acp/src/server/adapter.ts:740-742` |
| Grok | no | no (`08b8689a8`) | `packages/provider-grok/src/server/adapter.ts:121` |

## A. Core: commands, events, effects, runs, recovery, tools

### A1. Projections became the source of truth; events are pruned

`550c5fa34` (#29806, 0.1.7) is the largest architectural change in the range.

- `ProjectionMaintenanceV2` lost `verify` and `rebuild`; it offers only
  `pruneEventStore` (`apps/server/src/orchestration-v2/ProjectionMaintenance.ts:24-34`).
- A pass deletes events already covered by projections once older than
  `RETAINED_EVENT_HISTORY = Duration.days(1)` (`:42`), with a two-pass mark so
  at least a day of history remains. It publishes the pruned-through sequence
  first, so a resuming client falls back to a snapshot.
- It keeps each stream's newest event, every `thread.created`, every
  `run.updated` with `status: running` (Codex usage history) and prompt
  anchors referenced by retained subagent rows. Command receipts stay for
  idempotency (`:256`); only v1 receipts of imported legacy threads are
  deleted (`:186-245`).
- It runs every 6 h and from the "reclaim space" action (`8969e1d8d`).
- `docs/internals/overview.md:60-64` now states that projections cannot be
  rebuilt from the log, so a projection schema change needs an SQL migration.

Inertia: **different**. G6 verifies at every open and rebuilds from the full
log when a cheap check fails or the projector version changes
(`src/server/orchestration-v2/turn-repository.ts:107-112`,
`src/server/orchestration-v2/event-store.ts:255`, `:277`); G8's
`ORCHESTRATION_V2_PROJECTION_VERSION = 2` recomputes ordinals and superseded
marks by replay. Kept (section E). If ever adopted, the preconditions are:
projector changes ship as SQL migrations, G6's rebuild becomes "restore from
backup", and the newest event per stream, `thread.created`-equivalent anchors
and receipts are kept.

### A2. Event sink write guards

| Commit | Semantics | Inertia |
| --- | --- | --- |
| `52c1491c8` (#24545, main) | `writeIfRunCurrent.unlessInterruptRequested`: refuse while a run-interrupt request item exists without its result item (`apps/server/src/orchestration-v2/EventSink.ts:133-136`, `:557-574`). Used when a run writes a synthesized terminal, where a worktree handoff turns `interrupted` into `completed`, so that a racing Stop stays authoritative | **n/a**: no synthesized-completion handoff. Inertia's settlement keeps the first requested outcome (`deferredSettlement ??=`, G5). Any future synthesized terminal must refuse when `run-control.interrupt-recorded` has no `interrupt-settled` |
| `70833b2f5` (#29036, main) | `writeIfTurnItemUnchanged`: compare-and-set on a stored turn item's payload inside the commit transaction (`EventSink.ts:174-184`, `:707-726`), so tool calls cut off by a released session no longer keep the thread Waiting. `writeIfSubagentUnchanged` (`:185`, `:727-745`) came separately with `4b99420d8` | **satisfied in kind**: writes are guarded by entity and thread revision in the same synchronous transaction (`src/server/orchestration-v2/event-store.ts`, `expectedRevision`) |
| `bb29ca114` (#31656, 0.1.8) | `ProviderCommitBatch`: one transaction per provider pump with per-snapshot savepoints | **n/a**: performance for T3's async SQLite client |
| `a530cab2b` (#18385, 0.1.8) | A command id reused for two threads at once succeeds for only one (`OrchestratorCommandIdConflictError`) | **satisfied**: receipts keyed by `(actor, command id)`, thread or project mismatch is `command-conflict` (`src/server/orchestration-v2/event-store.ts:126-131`, `command-authority.ts:71-76`). Missing: a cross-thread race test |

### A3. Effects: outbox and worker

| Commit | Semantics | Inertia |
| --- | --- | --- |
| `cbc38a1b0` (#35027, main) | A worker slot waits at most `EFFECT_WORKER_SLOT_WAIT = 30 s` (`EffectWorker.ts:963`) for its execution, then claims other work while the execution keeps its `running` row and settles later. One hung provider request no longer stalls every thread | **not satisfied**: a claimed task holds its slot until the handler resolves (`src/server/orchestration-v2/effect-outbox.ts:288-305`; four slots). Harmless while only `checkpoint.capture-requested` is dispatched; required before a provider-facing kind such as `provider.steer` is |
| `20584babc` (#26272, main) | `thread-title.generate` may hold at most `concurrency − 1` slots | **not started**; adopt the per-kind cap with the slot wait |
| `5ba3a84db` (#36635, main) | Settling or requeueing after a failure retries `LockTimeoutError` every 100 ms, interruptibly; otherwise a `running` row blocks the thread's later effects until restart | **not satisfied**: if `settle` throws (for example `SQLITE_BUSY` after the 5 s busy timeout), `.catch(() => undefined)` swallows it (`effect-outbox.ts:296-297`) and the row stays `running` until the next boot, holding every later effect of that thread |
| `5984bbb36`, `d6e5f2e06` (main) | Process-bound `provider-session.apply-model-selection`; a Claude steer can carry a selection | assigned to Phase 5 (section B) and a Claude provider item |
| `2248ca8db` (main) | A declined steer is re-dispatched as a queued follow-up under `command:steer-follow-up:<effect id>` | Phase 5 decision N2 |
| `7462f234e` (main) | `checkpoint.capture` also runs delegated-task recovery for the completed run | **partial**: Inertia's delegation recovery is boot-time (`src/server/orchestration-v2/delegation-recovery.ts`) |
| `096182450` (0.1.8) | `awaitSettled` waiters resolve only after the post-commit cancel signal | **satisfied by construction** (wake is a microtask after the synchronous transaction) |

Retention, process-bound retirement and replay-safe requeue at boot are
unchanged in T3 and match G7. T3 retries every effect type; Inertia only
replay-safe kinds (kept).

### A4. Commands and policy

| Commit | Semantics | Inertia |
| --- | --- | --- |
| `d897d3f3f` (#27197, 0.1.7) | Organization `maxRuntimeMode` ceiling checked over the planned events of every command (`DispatchModeLimit.ts:42-111`) | **n/a** (no managed policy). The event-level check is a pattern for Inertia's delegation ceilings, now checked per tool call |
| `ed57b9b5e` (#26776) | A follow-up to a finished child binds to the latest active run, else the last executed (`CP:129-136`) | n/a (remote follow-up tasks) |
| `cc578d5f9` (#28360) | Resume at a usage-limit reset is refused on a settled thread; settling disarms limit recovery | assigned to the recovery phase |
| `6f54322e4` (#31815, 0.1.8) | `thread.settle.expectedLatestRunId` | n/a (no settlement) |
| `e1f5b6828`, `c64117dc8`, `7370b92c3`, `7057a74d0` | Tools and "Run now" report the orchestrator's refusal cause | agent-tools phase; Inertia's `RuntimeRequestError` already carries public messages |

G5's rejected-receipt policy is unaffected: T3 still records dispatch
failures as rejected except mode and policy-ceiling refusals.

### A5. Run and attempt lifecycle (G8, G9)

| Commit | Semantics | Inertia |
| --- | --- | --- |
| – | Attempt schema, reasons, `superseded`, ordinals unchanged | **satisfied** (G8) |
| – | `provider_recovery` still never written; a rejected resume is recovered inside the same attempt | **different** (G9): Inertia's fallback starts a second harness process, which needs its own attempt |
| `a445272c7` (#21045, 0.1.7) | Codex `-32600 … already has an active writer` becomes `ProviderAdapterThreadInUseError`; the turn fails and never falls back to a fresh session (`Adapters/CodexAdapterV2.ts:357-378`; `ProviderTurnStartService.ts:1334-1341`) | **adopted** in the G9 working tree (2026-11-14): `thread-in-use` continuation error, excluded from the two-strike rule and every fallback (`src/server/codex/app-server-run.ts`, `src/server/codex/types.ts:140-143`) |
| `ddc4f5760` (#34762, main) | A Claude query that ends before the turn attaches counts as a refusal before the prompt; the native session is kept (`ProviderTurnStartService.ts:107-126`) | **partial**: agrees with G9's choice to keep a session on a transient rejection (two-strike `savedSessionKeepsFailing`, `src/server/persistence/turn-ledger-repository.ts:389`). Inertia's Claude start-failure classification is **not assessed** |
| `7d8f6c948` (#28195, main) | A resume fallback records a visible "Recovered context" `handoff` turn item, committed with the replacement session's running transition (`ProviderTurnStartService.ts:1370-1413`) | **satisfied in kind**: the turn shows "Saved session no longer available · N earlier messages restored" (`src/renderer/src/utils/sessionRecovery.ts`; G9 entry). A portable handoff item kind belongs to G10 |
| `37e0fd378` (#35013, main) | An unreadable runtime-recovery projection at start fails the run ("Couldn't read thread state") instead of leaving it `starting` (`ProviderTurnStartService.ts:702-717`) | **partial**: the start path throws and the run settles failed, but no test covers it |
| `2de337003` (#34912, main) | A provider turn that starts as Stop lands is interrupted under the thread lock | **satisfied** (`src/server/provider/run-coordinator.ts:892-901`, `:735`) |
| `9e19b7f7e` (#36526, main) | `manualContinuationOfRunId`: Resume of a stopped run continues the provider thread natively, with an empty prompt; unsupported adapters fail with `ProviderResumeUnsupportedError` (`apps/server/src/orchestration-v2/manualContinuation.ts`) | **not started**; Phase 5 decision N7, adapter side per provider |
| `e139768a7`, `99e361e41`, `4aab23cd7` (0.1.8) | `freshContext` runs start a new provider conversation; earlier runs stay visible but never reach a provider | **not started**; Phase 5 N6 keeps the item field dormant |
| `737afe24b` (#30560, 0.1.8) | Queued-run start effect ids gain a per-dispatch suffix (`O:3202`) | **satisfied by design**: runs are created at dispatch, so a requeued item gets a new run and start id. The requeue itself is in A7 |

### A6. Stop, interrupt, force stop (G5)

| Commit | Semantics | Inertia |
| --- | --- | --- |
| `15d1ef5e0` (#35948, main) | Stop waits for settlement by streaming updates, bounded to 2 s, instead of polling | **satisfied in kind** (the run state coordinator settles the interrupt) |
| `2e0bd97e8` (#31038, main) | Force stop releases a session only if no later run is active on it, so a queued follow-up promoted during cleanup survives | **satisfied by design**: escalation targets the stopped attempt and a stale `expectedTurnId` is `superseded`. Missing: a regression test |
| `b5b470542`, `28b4ceeef`, `7195b6995` | More adapters raise `ProviderAdapterInterruptTimeoutError`, mapped to `unresponsive` and a user Force stop | **different** (G5 escalates automatically after the grace wait) |
| `009c9e6bd` (#33420, main) | An agent's Stop records "Stopped by an agent[: <reason>]" (`M:268-270`) | **not satisfied**: `run-control.interrupt-recorded` has no cause (`src/shared/orchestration-run-control.ts:41-43`), and `inertia_stop_conversation` stops through the managed-thread path (`src/server/runtime/agent-thread-manager.ts:351-361`) |
| `00766e2c0`, `362ac8d6d` (main), `66a40c7ca` (main) | Two retry deadlines. Claude and Codex fail a turn whose provider retries span more than `PROVIDER_RETRY_BUDGET_MS = 10 min` (`packages/provider-core/src/server/failure.ts:341`). Every provider: a turn that announced a retry and then stays silent on its thread for `PROVIDER_RETRY_STALL_TIMEOUT = 15 min` plus the retry delay is interrupted and settled `failed`, not retryable (`apps/server/src/orchestration-v2/ProviderSessionManager.ts:91`, `:2725-2726`) | **partial**: only the general 6 h inactivity timeout (`src/server/runtime/turns/turn-timeout-coordinator.ts:46-71`) |
| `5f2c27e70` | Stop ends a run whose provider turn already finished | **different** (G5: run and attempt change status in one event) |
| `c192c6786` (0.1.9) | An automatic send while a turn is stopping queues instead of steering | **satisfied** for user sends (G5); agent sends are Phase 5 N10 |
| `694076dcf` | A Claude steer left unconfirmed by Stop is shown | **satisfied** (G5 `steer-settled: unconfirmed`) |

### A7. Restart recovery and reconciliation

| Commit | Semantics | Inertia |
| --- | --- | --- |
| `737afe24b` (#30560, 0.1.8) | A never-started user run returns to the queue held at positions 1..n ahead of the existing queued runs; every queued run is held; automatic, scheduled, notification and delegated-completion runs are not requeued (`ProviderRuntimeRecoveryService.ts:331-443`, `:440-441`) | **not satisfied**: boot marks queued and starting turns interrupted (`src/server/persistence/recovery-repository.ts:14-30`). Phase 5 decision 4.10 |
| `240446e2d` (0.1.8) | An unsent usage-limit auto-resume survives restart with a fresh request id | assigned to the recovery phase |
| `d80625118` (#27192, main) | Runs cancelled by restart get a visible "Server restarted" or "Server shut down" notice | **partial**: `terminalReason: runtime-restart` and a note on workspace runs (`recovery-repository.ts:54-64`); the chat timeline is **not assessed** |
| `5bb50dca8` (#27836, 0.1.7) | The continuation prompt says the last action may have finished or still be running and to confirm before repeating a state-changing step (`apps/server/src/orchestration-v2/RestartContinuation.ts:33-34`) | **not satisfied**: Inertia sends "Continue from where you stopped." (`src/server/runtime/restart-continuation-runtime.ts:36`) |
| `7a03a7418` (0.1.7) | Messages cut by restart no longer stay streaming | **not assessed** |
| `e4025c852` | Reap recorded Linux Claude survivors before recovery | **satisfied** (`src/server/runtime-startup-recovery.ts:70-86`) |
| `577c52408` (0.1.9), `c15e49a77`, `e66c3168a` (0.1.8) | Detaching cancels a pending approval; older questions stay answerable when paging; user-input-only threads can be snoozed | assigned to persisted questions |
| `8d236998d` (main) | A usage-limited provider keeps the queue held after another provider's turn succeeds, while its reset is in the future (`usageLimitHoldsQueue`, `O:1026-1045`) | Phase 5 decision N8 |
| `95414cf1a`, `144b78ae6`, `90f0158e6`, `e96c96eaf` | Auto-resume never arms children of settled, archived or deleted parents; resume messages are agent-attributed | assigned to the recovery phase |

T3's crash continuation (`MAX_CONTINUATION_CHAIN = 3`) is otherwise
unchanged; Inertia's continuation is still limited to app-update
interruptions (`src/server/runtime/restart-continuation-scheduler.ts:105`).

### A8. Idle compaction and background work

Inertia has no idle compaction. T3's rules for whoever adds it: ignore
cancelled never-started runs when choosing the latest run (`7f17f5153`,
0.1.7); retarget the timer when a late update arrives for an earlier run
(`79f3ee139`, 0.1.7); no compaction while a delegated result is pending or
just sent (`e8afdb062`); read only the latest run, live work and newest usage
(`bad610bec`, 0.1.7).

Background work: T3 reports `pendingBackgroundTasks` and `blockedOnThreadWait`
in thread reads (`91712ee56`, `43ba62b9f`), and commands that would detach a
live session refuse while it holds background work, except archive and settle
(`805251b67`, `6049196c5`, `2ed6f109f`). Inertia settles every live trace at
turn end (`src/server/runtime/turns/turn-settlement-coordinator.ts:140-147`),
so most of this is n/a; the switch-holds-queue rule is carried into Phase 5
package 3. **Not assessed in depth.**

### A9. Scheduled tasks

`apps/server/src/scheduling/` is unchanged; `ScheduledTaskService` grew by
about 700 lines. Inertia has no general scheduled tasks, so each row is
**not started** and becomes a requirement of that phase: `once` schedules
(`4ac97be2b`, 0.1.7); a bracketed busy reservation (`ce9e01640`, 0.1.7); one
queued occurrence per recurring task (`1d61dd3fd`); success at acceptance
followed by failure tracking for up to 24 h (`5c0eb5124`); thread modes
including a fresh session per run (`4aab23cd7`, `18866e52e`, `bd7d26440`,
`2ed6f109f`); deliveries that name no model follow the thread
(`beb528ce4`); workspace and branch rules on edit (`46afd69a8`, `4773ab7a7`,
`8e6a73230`); error text and refusal causes (`741bcaea1`, `c64117dc8`,
`7370b92c3`, `629242b8d`); webhook prompt and filter fixes (`b492e28c7`,
`ec6020e88`). Anchors are in
`apps/server/src/scheduledTasks/ScheduledTaskService.ts`; 20 queued webhook
runs per task is `WEBHOOK_MAX_QUEUED_PER_TASK` (`:90`).

### A10. Agent tools

| Commit | Semantics | Inertia |
| --- | --- | --- |
| `184bb3950` | Tools reject undeclared top-level arguments | **satisfied** (`src/server/runtime/agent-thread-schemas.ts:28-46`) |
| `cdd1c6a2a` (main) | Deferred exposure: a few tools listed up front, the rest found by `tool_search` (`apps/server/src/mcp/McpToolExposure.ts:7-12`) | agent-tools phase |
| `aab388ddb` (main) | `send_to_user` shows verbatim Markdown mid-turn | agent-tools phase |
| `59e64eef8`, `6237824a2`, `85b160658` | `t3_thread_read` reads newest first and fits client output limits | agent-tools phase |
| `91712ee56`, `34e7b6601` | Reads expose `pendingBackgroundTasks` | agent-tools phase |
| `613d1ac4f` | A background wait fails when none of its task ids exist | agent-tools phase |

## B. Queues, steering, delegation and clients

The decisions these changes drive are recorded in
[phase5-queue-design.md](phase5-queue-design.md) section 4; this section keeps
the evidence.

### B1. Queue and steering server changes

| Commit | T3 change and anchors | Inertia | Action |
| --- | --- | --- | --- |
| `631ea1b6d` (0.1.9) | A restart to a provider that can interrupt and queue but not interrupt-restart (Claude, Pi) stops the running turn; the message becomes position 1, stop reason "Stopped to send a new message", `skipsHeldQueue`, delivery `restarted`; an unheld delegated result still runs first (`O:7110-7140`, `:7525-7540`) | **partial**: stop-and-send enqueues, stops and starts, but refuses when another user item waits (`src/server/runtime/queued-message-runtime.ts:342-347`); no position 1, no skip-hold | Phase 5 package 2, decision 4.6, for every provider |
| `f12bb6229` (0.1.9) | A restart into a turn that already ended starts immediately; a restart that Stop reached starts behind the stopping run; an explicit steer there fails (`O:6960-7008`) | **partial**: `SUPERSEDED_STOP_CODE` is treated as "schedule" (`queued-message-runtime.ts:366`); ended or failed turns are not covered | package 2 acceptance |
| `b20bbc595` (main) | Deferred steer: a steer while the run is preparing or starting, or running with no provider turn, is stored with `steerWhenReadyRunId` and promoted by `deliverDeferredSteers` (`O:15659`) under `command:deferred-steer:<queued>:<run>:<attempt>` | **not satisfied**: follow-ups are refused until the run accepts provider events (`src/server/runtime/turns/turn-follow-up-coordinator.ts:55-61`) | package 2, N1 |
| `2248ca8db` (main) | A declined steer becomes a queued follow-up placed after the runs queued before it, earlier declined steers keeping order (`O:7486-7513`); Cursor SDK becomes actively steerable | **partial**: a refused queue item returns to its own position (equivalent); a refused composer follow-up goes to the tail | package 2, N2 |
| `9fb449232` (main) | A steer that fell back to the queue stays hidden until it runs; undelivered queued input is kept out of forks | **not assessed**; likely satisfied by construction (queue items are not transcript rows until accepted) | package 2 test |
| `55e253856` (0.1.7) | A steer with attachments forces a restart where `activeSteeringAcceptsAttachments` is false (`O:6123-6134`) | **different in effect**: images on a model without follow-up images wait for the turn end (`queued-message-runtime.ts:393-395`) | package 4, N3 |
| `b3f5d5270` (main) | During automatic compaction only Codex steers; `/compact` always blocks | more conservative: the queue skips compaction (`queued-message-runtime.ts:128`) | package 4, N4 |
| `4168c14c7` (0.1.9) | A queued message that names no model takes the last queued run's selection (`queueTailModelSelection`, `O:1008-1019`, used at `:7347`) | **not satisfied**: route identity blocks instead (`src/server/persistence/queued-message-repository.ts:34`) | package 3, N5 |
| `beb528ce4` (main) | Scheduled deliveries that named no model follow the thread's selection (`followsThreadSelection`) | satisfied in effect for delegated rows (`queued-message-repository.ts:131-135`) | package 3 (`follow-current`) |
| `d6e5f2e06`, `5984bbb36` (main) | Claude effort and flags apply to the running turn; a steer carrying a selection applies it live (`O:5180-5208`) | **not satisfied**: configuration changes on a running chat are refused (`src/server/runtime/commands/conversation-commands.ts:60`, `:585`, `:623`) | package 3 (accept and apply next run), separate Claude provider item for live apply |
| `8d236998d` (main) | Per-provider usage-limit hold that respects a future reset | **partial**: the queue releases only after a completed turn (`queued-message-runtime.ts:33-35`) | package 3, N8 |
| `4225c9dfa` (main) | Messages sent after failed or stopped worktree setup wait held, never run in the project checkout (`O:7317-7330`) | **not assessed** (isolated-workspace path) | package 2, N9 |
| `c192c6786` (0.1.9) | Agent `t3_thread_send` in `auto` mode queues on a stopping thread | **not assessed** (`inertia_send_message`) | package 4, N10 |
| `e139768a7` (0.1.8) | Fresh-context sends never steer; a queued fresh run reserves its provider thread | not started | N6, dormant |
| `9e19b7f7e`, `5f4368165`, `0acca1de2` (main) | Resume continues the stopped run natively and releases the hold; hidden while a request is pending | **not satisfied** (no Resume) | packages 2 and 5, N7 |
| `d897d3f3f` (0.1.7) | Organization ceiling makes the queue wait without a hold; a mode change restarts the queue (`O:2436-2439`, `:15461-15468`) | n/a; the queue restart on a mode change is adopted with 4.3 | package 3 |
| `42ca7c001`, `1a43f4870`, `a86ffacc3`, `e726a0898` | `/goal` fixes (size bound, no double create, skill mentions, no-op clear) | different surface: goals go through `ChatGoalControl`, not queued text | none |

Unchanged rules, re-anchored: Stop holds every queued run and cancels
buffered wakes (`O:12560-12588`); holds also come from provider failure, a
disabled instance or a missing worktree (`O:2440-2486`) and background work in
a replaced session (`O:2655-2680`); a client user send releases holds, server
continuations do not (`O:7350-7370`); renumbering at queued start and the
start command id (`O:2488-2500`); reorder refusals (`O:11394-11440`); edit
refusals (`O:11540-11600`); cancel (`O:11480-11540`); `queue.resume` and
`queued-run.start` (`O:15039-15060`, `:15227-15232`); a forced restart when
the instance changes, the selection cannot apply next turn, or attachments are
not accepted (`O:6116-6134`). Already assigned and unchanged: `a732caa7d`,
`5731c0222`, `6049196c5`, `7f17f5153`, `cbb0417df` (all 0.1.7).

### B2. Delegation and mailbox

Most of about 53 delegation commits concern hidden subagent threads, remote
delegation, thread settlement or background work outliving a turn, none of
which Inertia has (it keeps a Claude turn open until background delegates
report, `src/server/provider/claude-delegate-lifecycle.ts:17-23`).

| Commit | T3 change | Inertia | Action |
| --- | --- | --- | --- |
| `ac781dcb7` (main) | `delegate_task` wait default drops to 4 min because Node fetch cuts a silent call at 300 s; maximum 60 min (`M:139-142`) | **risk**: `DELEGATION_WAIT_DEFAULT_MS = 300_000` (`src/shared/orchestration-delegation.ts:15`) and the host MCP HTTP server sends headers only at completion (`src/server/provider/host-tool-mcp-http.ts:57`). Whether Claude and Codex MCP clients actually cut at 300 s is **not verified** | adopt 240 s; reconsider the 30 min maximum or send headers early |
| `41e69ffa0` (main) | The running-task hint says completion wakes the thread; do not wait or poll | **partial**: `TASK_RUNNING_WAKE_NEXT` still invites `inertia_wait_for_task` (`src/server/runtime/delegation/task-view.ts:18-19`) | adopt wording |
| `2f2730c11` | Task status says `starting` until the child's provider starts | partial | optional |
| `fd9b2c3ea`, `fdcf27211` | `task_cancel` cancels a queued-only task after Stop held it | unclear: `prepareCancel` refuses a task with no active turn (`src/server/runtime/delegation/task-service.ts:201-211`) | test |
| `1e438c8f8` | A Codex goal pauses while a delegated task will wake it | **not assessed** (`src/server/codex/app-server-run.ts`) | check |
| `7462f234e` (main) | Completion bookkeeping retried after checkpoint capture | partial (boot-time only) | low priority |
| `e2bb9e63e` (0.1.7), `86c379d07` (main) | Child questions steer into a busy parent; question wakes of finished children are dropped | **different**: no child-question wakes | revisit with persisted questions |
| `70f475f51` (0.1.7), `60514be91` (0.1.8), `664123179` | Child approvals and secret requests appear in the parent UI | partial (panel chip) | optional renderer item |
| `ac1cb9232` | Archiving a parent with running delegated tasks is refused | different (archive disarms wakes) | optional confirmation |
| `6b96956c3` (0.1.9), `4dff7de3f` (0.1.8), `8d54c8b1a` (0.1.9) | Removing a completion wake keeps its siblings | satisfied by construction | – |
| `36d0dcbf5` (0.1.8), `303903acd` | Late results wake an idle parent; a wait that ends without a result upgrades the wake | satisfied in effect | – |
| `931cd3afa`, `aaa3dbabb`, `24e77473e`, `d91915db9` | Monitor wakes never start follow-ups; other sends to a finished child create follow-ups | different (only an approved send creates a follow-up) | keep |

Mode step-down is unchanged upstream (`delegatedTaskModes.ts`); the Phase 4
deferral stands.

### B3. Client surfaces

Web (`apps/web/src/components/chat/QueuedRunsControl.tsx`):
`QUEUE_VISIBLE_ROWS = 3` (`:57`); with more than three items it shows two rows
and "Show all" (`:238-239`); unconfirmed rows render pending with actions
disabled; a polite live region and "Queued message i of n" labels; Send steers
when running and starts when idle; Edit is blocked while a question is open
and for guest messages; no reorder and no per-item model; `mod+shift+enter`
sends the first item and `alt+arrowup` edits the last
(`packages/shared/src/keybindings.ts:94-95`); a held queue has no banner, and
Resume becomes the composer's primary action (Enter on an empty composer
resumes, `ComposerPrimaryActions.tsx:364-373`).

Mobile (`apps/mobile/src/features/threads/ThreadQueueControl.tsx`): every row,
Send now, Edit and Remove, swipe to remove, a "Queue paused" banner with Resume
(`:219-245`); no reorder.

Guest share: a guest cannot see the queue, steer or retract; at most three
pending messages of 4,000 characters (`packages/contracts/src/guestShare.ts:19-28`);
the owner admits each, the server prefixes the text, and the owner can cancel
but not edit (`GuestShareDecider.ts:198-255`).

Changes since the pin, all Phase 5 package 5 acceptance rows unless noted:
`cebdf3998` (a cancelled or replaced edit releases its uploads), `ceed427d7`
(0.1.8; removing an attachment is an edit), `7271ea06a` and `5e06246d2` (edits
keep mention chips; recovery only into an empty draft), `ed7e5010b` ("add to
chat" targets the edit), `bfd37b774` (0.1.7; edit during compaction),
`4c2f04d35`, `ad0b2a9d2` (queue rows off the token stream), `cbc68c9dc`,
`442b1db16`, `e1d59d188` (Stop pending state and latch; Inertia matches in
`useComposerStopAction.ts:35-61`), `871b00907` (0.1.9), `a50ebef78`,
`694076dcf` (steer waiting and unconfirmed states, packages 4 and 5),
`6bce2226d` (CRLF normalization, package 4 for Private Connect text).
`94f7984d2` (typed answers go to the draft when Stop cancels a question) and
`b859968ca` (an approval announced once) are **not assessed**.

## C. Context handoff, backings, forks and providers

### C1. Context handoff

| Commit | T3 change | Inertia | Action |
| --- | --- | --- | --- |
| `b53cd6768` (main) | Native occupancy from stored history uses `estimateTextTokens` = UTF-8 bytes / 4 (`packages/provider-core/src/server/handoffBudget.ts:99-101`); new prompts and imported history stay at one byte per token. One byte per token over-counted covered history and forced needless fresh restarts | **not satisfied**: `coveredHistoryOccupancy` counts one byte per token (`src/server/orchestration-v2/portable-history-occupancy.ts:9-49`) | divide text bytes by 4, keep attachment allowances whole |
| `9f1e97de6` (main) | The handoff text lists up to 20 newest omitted item ids ("Omitted item IDs, newest last: …", `handoffBudget.ts:234`), reserving room within budget/8, and the recovery hint reads one omitted item by id instead of paging from the start | **not satisfied**: the hint names `inertia_request_context({conversationId})` and turn paging (`src/server/orchestration-v2/portable-history.ts:158`) | list ids; item-scoped hint; `inertia_request_context` accepts prefixed item ids |
| `8a84e9426` (0.1.8) | Skip an oversized message before serializing it | satisfied in effect (items over 64,000 bytes skipped before selection) | none |
| `e5d071087` (0.1.7), `c0b140b5b` | A file-change item names every path of a multi-file patch | satisfied (G10) | none |
| `139ec8080` (main) | Claude skill dispatch ignores mentions inside inline history (`inlineContextLength`) | **not assessed** | check `src/server/provider/claude-prompt.ts` |
| `6be26850f`, `dfbafeee6` (0.1.7), `13c3c2e43` (0.1.7) | Fork and side-chat coverage names the source thread; no surrogate split; lazy side-chat digest | side chats assigned; fork items already carry `sourceThreadId` | side-chat package |
| unchanged | Per-handoff `delivery {nativeThreadId, status, itemIds, omittedItemIds}` (`C:1206-1213`); coverage is the union over non-pending handoffs on the loaded native thread (`ProviderTurnStartService.ts:851-861`); unbounded | G11 part 1 implements the same rule on the backing with a 2,048-id cap and a 256-item window | section E |

### C2. Sessions, resume and workspace moves

| Commit | T3 change | Inertia | Action |
| --- | --- | --- | --- |
| `af9b4e41d`, `52c1491c8` (main) | A worktree handoff completes the moved run instead of failing it; `thread.update` gains a `continuation` queued in the same commit | **not assessed** (agent-driven handoff belongs to the agent-tools phase) | a move ends the old process deliberately; it is not a failure |
| `bebaf3ec0` (main) | Pi forks a session whose header names another cwd into the new cwd; the native id changes, the content continues | **not satisfied** | brief C5 |
| `a18a458f2` (main) | Cursor SDK records the store cwd and resumes a moved thread from it | **not satisfied** | brief C5 |
| `543ee27fa` (0.1.9) | Claude native fork no longer passes `dir`; the SDK finds the session by id within the Claude home | **partial**: Inertia keeps an imported session's original cwd for Claude resumes (`src/server/cli-import/resume-cwd.ts:22-30`); CLI resume from another cwd is **not verified** | verify before brief C5 relies on it |
| `9c8942480`, `ba962f2d2` (0.1.7) | Codex resume, fork and rollback retry once after `thread/unarchive`, and wait for a closing thread | **not satisfied** (`thread/unarchived` is an ignored notification, `src/server/codex/app-server-notifications.ts:12`) | adopt |
| `669aa32e0` | A reasoning-effort-only change keeps the Codex thread loaded | **not assessed** | provider package |
| `12b29eb71` (main) | Codex turns use the configured `model_reasoning_summary` instead of forcing one | **not satisfied**: `summary: "auto"` is hard-coded in `src/server/codex/app-server-run.ts` | adopt |
| `0a333a69e`, `3e0d8775b` (0.1.7), `09e1751a1` | Each Codex instance's `CODEX_HOME` honored for switches, shadow homes and sign-in hints | assigned (L2) | L2 |

### C3. Forks, rollback and checkpoints

| Commit | T3 change | Inertia | Action |
| --- | --- | --- | --- |
| `c3e5bfc02` (main) | A native fork that fails after retries starts a fresh native thread with the portable handoff and shows "Native fork failed … Started a fresh session with its history." (`ProviderTurnStartService.ts:1229`) | **satisfied in behavior** (a failed result settles `portable`, `src/server/orchestration-v2/native-control-repository.ts:74-80`); **not satisfied**: no visible notice | add the notice for provider-side failures; the G12 difference is closed (section E) |
| `3f4889658` (0.1.7), `8024e50c6` | Native forks exclude rolled-back provider turns | satisfied (`src/server/orchestration-v2/fork-history.ts:38-40`) | none |
| `b125e8976`, `d14074fb7` (0.1.7) | Codex `thread/fork` with `excludeTurns`; rollback via `thread/turns/list` and `thread/revert` | satisfied (`src/server/provider/codex-native-conversation.ts`) | none |
| `0c6c721ae` (0.1.7) | Rollback passes the target run's user message; Claude reverts to it after `/compact` | **not assessed** | check |
| `31eea883c` (main) | Conversation-only rewind is allowed when the checkpoint is `missing` | **not assessed** | check |
| `0c4b1d8f2` | New turns wait for an overlapping checkpoint restore | satisfied (exclusive checkout claim, G3) | none |
| `1032135cf`, `6807c3fb8` | Edit from here recreates a managed worktree folder that lost its checkout | **not assessed** | checkpoint package |
| `19f643856`, `4652544f3`, `bff276e78`, `66fa3fe53` (0.1.8), `c085a0aa5`, `1a4a29998`, `9402dc39b`, `7bd913482` | Checkpoint store hardening: interrupted restores reset the index, interrupted captures remove temporary packs, Git failures do not mark checkpoints `missing`, late checkpoints keep baselines, slow baselines do not block prompts, skip-worktree files restore, fetched upstream commits are not agent changes, diffs follow branch switches | **not assessed** (`src/server/checkpoints.ts`) | audit |
| `0a8aaa3cc`, `eeccecff7`, `c5f842d4c`, `867037804` (0.1.7) | Retained forks keep inherited pages after source deletion; titles regenerate on fresh forks; forks do not inherit pin, auto-settle or delegation state | satisfied by construction, except title regeneration (**not assessed**) | none |
| `d0c7147a8`, `6e6b6a736` | Pi rewind after release; OpenCode forks after a lost end event | **not assessed** | provider package |

### C4. Providers (triaged)

Per-adapter hardening that does not change the orchestration contract, Inertia
status **not assessed**: ACP (`0351dbb09` refused and limit-stopped turns are
not `completed`; `db0ae7b6e` a blank line does not end the session;
`3ac8b1f58` bounded notification retention; `0b127678b`, `0fe71da30` model
changes and per-model options; `26f0a62f7` only approved execute requests
open terminals; `75c7fb28a` imported sessions show native history); Cursor
(`d3ef7e8e5`, `34a7c0d85`, `8c15be97d`); OpenCode 2 (`aecad62a5` a failed steer
does not leave the turn running, `a135972c7`, `1530bec29`, `9b5d9979c`);
contracts (`f4e65cd84` a `null` option means omitted; `94f54a571` (0.1.9)
switching instances preserves active turns). The ACP stop-reason and terminal
rules belong in portable fixtures (AGENTS.md).

### C5. Brief: returning a chat to a checkout it used before

**T3.** There is no per-workspace backing. A thread's provider thread holds
one current native conversation, and coverage is keyed by provider thread and
native thread id, never by workspace (`ProviderTurnStartService.ts:851-861`).
A workspace change is a `restart_and_resume` transition: planning compares the
live session's cwd with the thread's worktree (`ProviderSwitchService.ts:122-157`)
and releases only the replaced session (`:165-178`); if it still runs
background work, dispatch holds the queue (`O:2655-2681`); the next turn opens
a session in the new cwd and resumes the same native thread
(`ProviderTurnStartService.ts:726-744`, `:1255-1276`), so coverage carries
because the native id is unchanged. Moving back is one more
`restart_and_resume` of the current conversation. Per adapter: Codex resumes
with the new cwd; Claude finds the session by id (`ClaudeAdapterV2.ts:14035-14040`);
Pi forks the session file into the new cwd (`bebaf3ec0`); Cursor SDK resumes
from its recorded store cwd (`a18a458f2`).

**Inertia today.** A backing's id is
`fingerprint(threadId, instanceId, workspaceKey, nativeSessionId)`
(`src/server/orchestration-v2/backing-repository.ts:85-86`). After A → B the
first turn in B resumes the conversation's session and `observeSession`
carries coverage into a B backing, retiring A as `workspace-changed`
(`:90-105`). On B → A, `find` returns the retired A backing, so the turn
starts fresh with the full portable history, and a later observation of the A
id returns early (`:89`; projector refusal `backing-projector.ts:36-39`).

**Change.**

1. *Lookup.* Resolve the candidate as the newest non-retired backing for
   (thread, instance, continuation identity) whose `nativeSessionId` is the
   conversation's session, in any workspace. `ready` and `coverageComplete`
   resume; `uncertain` or incomplete starts fresh. This also reads the
   moved-from status, which the first turn after a move skips today.
2. *Relocation event.* An append-only `provider.backing-relocated
   {fromBackingId, backing}` committed during preparation, before
   `context.handoff-prepared`, records a backing for the run's workspace with
   the carried coverage, status and native ids, and retires the source in the
   same write. Derive the new id from
   `(threadId, instanceId, workspaceKey, nativeSessionId, fromBackingId)` so
   it never collides with the retired row. The move turn then gets a delta
   handoff. Keep `observeSession`'s carry as the fallback for native
   relocation (Pi) and older events.
3. *Per-provider relocation hook*, fresh plus portable by default: Codex
   resumes with the new cwd (same native id); Claude only after verifying CLI
   resume from another cwd under the same `CLAUDE_CONFIG_DIR`, else relocate
   the transcript under realpath containment or start fresh; Pi forks into the
   new cwd (new native id, carried coverage); Cursor SDK records its store
   cwd; OpenCode 2, Antigravity and ACP stay fresh plus portable until proven.
4. *Busy session.* If the replaced session still has background work, hold
   or refuse the send with a typed, user-correctable error. Never resume a
   native session another live process is writing.
5. *Containment.* Re-check realpath containment of the new checkout before
   resuming and before any transcript relocation.

Tests (`tests/server/orchestration-backings.test.ts`, a Codex portable
fixture): A → B → A resumes the same session in A with `cwd` = A and the
carried coverage; the move turn's handoff offers only missing items; an
uncertain B backing makes A fresh; the retired original row is never
re-recorded; replay and rebuild give the same rows; background work holds or
refuses; Pi relocation and an unsupported harness; an older database with
moved backings upgrades without a rewrite. Size M–L.

### C6. Brief: Codex native history injection (G11 part 2)

**T3 mechanism.** `thread/inject_items {threadId, items}` on the loaded
native thread (`Adapters/CodexAdapterV2.ts:7852-7860`): success returns
`true`; JSON-RPC `-32601` (unknown method) returns `false` before any history
mutation, so the caller falls back inline; any other error is a protocol
error because delivery is now ambiguous (`:7861-7871`). Items
(`handoffBudget.ts:179-196`): one user message with the coverage block, then
one item per historical message labelled with role, kind and ids.
`startWithHandoffs` injects whenever the session has `injectHistory` and the
provider thread has a native id (`ProviderTurnStartService.ts:1652-1667`),
after loading and before `turn/start`; the prompt then carries no history.
Codex never injects mid-turn (`8b21cbdf1`). Budget is unchanged by method
(`handoffBudget.ts:207-217`). Delivery states (`ContextHandoffDelivery.ts:82-147`):
`pending` before the request, `injected` on success before `turn/start`,
`inline` only after the provider accepts the turn. Coverage counts `injected`
and `inline` alike, and an injected handoff stays covered if the turn later
fails. A `pending` delivery on the current native thread is uncertain: the next
turn does not resume that thread and starts fresh with a full recovery
handoff (`ContextHandoffDelivery.ts:113-122`; `ProviderTurnStartService.ts:1255-1269`).

**Inertia integration.**

1. Capability `history-injection` in `PROVIDER_CAPABILITY_IDS`
   (`src/server/provider/capability-manifest.ts`): Codex `negotiated`
   (unknown method downgrades to inline, remembered for the process), others
   `unavailable`. Gate on the capability, not the provider id.
2. Preparation returns selected items and context separately from the
   assembled prompt, so an injected turn omits the restored block
   (`src/server/runtime/turns/turn-context-handoff.ts:118-131`); the
   response-item encoding already exists (`portableHistoryResponseItems`,
   `src/server/orchestration-v2/portable-history.ts:100-105`).
3. Handoff record: `method: "native"` already exists
   (`src/shared/orchestration-backings.ts:30`). Commit `dispatching` before the
   request (the backing is already marked `uncertain` in that transaction),
   `delivered` with method `native` before `turn/start`, a method change to
   `inline` on `-32601`, and leave it `uncertain` on any other error or
   cancellation.
4. Coverage: credit `itemIds` and `omittedItemIds` of a delivered native
   handoff at delivery, independent of the turn outcome.
5. Transport in `src/server/codex/app-server-run.ts`, after
   `thread/resume`/`thread/start` and before `turn/start` (before
   `thread/goal/set` for goal starts), under the same timeout and
   cancellation; never while a turn is active.
6. An `uncertain` native handoff is not resumed: start fresh with the full
   restore and invalidate the backing as `uncertain-delivery` (existing G2
   path).
7. Fixtures (`npm run test:portable`): success; `-32601` falls back inline in
   the same turn; malformed response; transport close during the request;
   Stop during injection; items at the 64,000-byte cap; injected delivery
   followed by a failed turn keeps coverage; projection rebuild. Historical
   text stays neutralized.

Size L. Independent of C5 except for the shared coverage-crediting change.

## D. Consolidated adopt list

Packages in priority order. Each names its target phase or gap package and a
size (XS < S < M < L). Items already adopted are listed for completeness.

### 1. Core and agent-facing safety fixes (G9 close-out / core polish; S–M in total)

| Item | T3 | Rel. | Size |
| --- | --- | --- | --- |
| Codex thread-in-use refusal | `a445272c7` | 0.1.7 | done in the G9 working tree |
| Bounded settle and requeue retry on a busy database in `OrchestrationEffectDispatcher.execute` | `5ba3a84db` | main | S |
| Restart-continuation prompt: confirm before repeating a state-changing action | `5bb50dca8` | 0.1.7 | XS |
| Delegation wait default 240 s; review the 30 min maximum or send headers early; running-task hint wording | `ac781dcb7`, `41e69ffa0` | main | S |
| Regression tests: cross-thread command id reuse; a follow-up admitted during the stop ladder is not force-stopped; an unreadable projection at start settles failed | `a530cab2b`, `2e0bd97e8`, `37e0fd378` | 0.1.8, main, main | S each |

### 2. G11 completion: coverage polish, relocation, native injection (G11; L)

| Item | T3 | Rel. | Size |
| --- | --- | --- | --- |
| Native occupancy at bytes / 4 | `b53cd6768` | main | S |
| List up to 20 omitted ids within budget/8; item-scoped retrieval hint; `inertia_request_context` by item id | `9f1e97de6` | main | S–M |
| Backing follows the native session across checkouts (brief C5; new "G11 part 1b") | policy unchanged; `bebaf3ec0`, `a18a458f2`, `543ee27fa` | main, main, 0.1.9 | M–L |
| Codex native history injection behind `history-injection` (brief C6) | `injectHistory`, `8b21cbdf1` | pre-pin mechanism | L |

### 3. Phase 5 durable queues (Phase 5 packages 1–5; L)

Decisions in [phase5-queue-design.md](phase5-queue-design.md) section 4.

| Item | T3 | Rel. | Package, size |
| --- | --- | --- | --- |
| Effect slot detachment after 30 s and per-kind slot caps, before `provider.steer` is dispatched | `cbc38a1b0`, `20584babc` | main | 2 prerequisite, S–M |
| Stop and send at position 1 with skip-hold for every provider, delegated first, refusal removed, `restarted`, edge rules | `631ea1b6d`, `f12bb6229` | 0.1.9 | 2, M |
| Requeue never-started user runs at the front, whole queue held | `737afe24b` | 0.1.8 | 2, M |
| Deferred steer and declined-steer placement | `b20bbc595`, `2248ca8db`, `9fb449232` | main | 2, M |
| Resume continues first, hidden while a request is pending, shared Stop latch | `9e19b7f7e`, `cbb0417df`, `5f4368165` | main, 0.1.7, main | 2 and 5, M |
| Held messages after failed workspace setup | `4225c9dfa` | main | 2, S |
| Configuration while running applied to the chat at once; queue-tail inheritance; follow-current automatic items; no access ceiling; per-provider usage-limit hold | `4168c14c7`, `5731c0222`, `beb528ce4`, `8d236998d`, `6049196c5` | 0.1.9, 0.1.7, main, main, 0.1.7 | 3, M |
| Steering truth from the manifest with attachment and compaction flags; Pi and Cursor SDK with portable fixtures; steer waiting state | `55e253856`, `b3f5d5270`, `2248ca8db`, `871b00907` | 0.1.7, main, main, 0.1.9 | 4, M–L |
| FIFO watcher order, per-watcher coalescing, stale-note drop, caps; rewrite `docs/user/watcher.md` | `QueuedRunOrder.ts`, `0af2d2164` | unchanged, main | 1 and 4, S–M |
| Private Connect queue per the mobile analogue | mobile `ThreadQueueControl.tsx` | – | 4 and 5, M |
| Agent sends to a stopping chat queue | `c192c6786` | 0.1.9 | 4, S |
| Renderer acceptance rows (two rows and Show all, edit rules, edit during compaction, no edit while a question is open, rows off the token stream) | B3 list | mixed | 5, S each |

### 4. Provider polish (provider package and G9 follow-ups; M)

| Item | T3 | Rel. | Size |
| --- | --- | --- | --- |
| Retry deadlines: 10 min retry budget (Claude, Codex) and 15 min silent-retry watchdog for every provider, through the stop ladder | `66a40c7ca`, `362ac8d6d`, `00766e2c0` | main | S–M |
| Codex `thread/unarchive` and retry on resume, fork and rollback; wait for closing threads | `9c8942480`, `ba962f2d2` | 0.1.7 | S |
| Codex reasoning summary from configuration | `12b29eb71` | main | S |
| Claude checks: refusal before the prompt, skill mentions inside inline history, rollback after `/compact` | `ddc4f5760`, `139ec8080`, `0c6c721ae` | main, main, 0.1.7 | S each, verify first |
| ACP stop-reason, blank-line, notification-retention and terminal-approval rules as portable fixtures | C4 | mixed | M |

### 5. Fork, rollback and checkpoint polish (G12 follow-up and checkpoint package; M)

| Item | T3 | Rel. | Size |
| --- | --- | --- | --- |
| Visible notice when a provider-side native fork fails | `c3e5bfc02` | main | S |
| Conversation-only rewind with a `missing` checkpoint | `31eea883c` | main | S |
| Checkpoint store hardening audit | C3 row | mixed | M |

### 6. Restart and recovery (L3 recovery phase; M)

| Item | T3 | Rel. | Size |
| --- | --- | --- | --- |
| Restart notice in the chat timeline; no assistant message left streaming | `d80625118`, `7a03a7418` | main, 0.1.7 | S |
| Usage-limit recovery: restart-safe unsent resume, settle disarms and refuses, no arming under settled or archived parents, agent attribution | `240446e2d`, `cc578d5f9`, `95414cf1a`, `144b78ae6` | mixed | M |
| Delegated bookkeeping retried after checkpoint capture | `7462f234e` | main | S |

### 7. Agent tools (agent-tools phase; M)

| Item | T3 | Rel. | Size |
| --- | --- | --- | --- |
| Stop attribution: an optional `cause` (user, agent or runtime) on `run-control.interrupt-recorded`; route `inertia_stop_conversation` through the G5 Stop command | `009c9e6bd` | main | S |
| Deferred tool exposure, `send_to_user`, newest-first thread reads, background-work fields, precise refusal causes | A10 | mixed | M |

### 8. Later phases (L each)

Scheduled-task semantics (A9; scheduled-tasks phase). Child-question wakes
with the stale-wake drop (`e2bb9e63e`, `86c379d07`; persisted-questions phase).
Per-instance `CODEX_HOME` (L2). Idle compaction rules (A8; not in the
completion checklist, decide whether it is in scope).

## E. Deliberate differences

### Kept

| Difference | Reason it is kept |
| --- | --- |
| Full event log with boot-time verify and rebuild (G6) versus T3's pruning (`550c5fa34`) | Recorded architecture choice: G6 repair and G8's projector-version recomputation depend on replay; pruning would force every projector change into a hand-written migration. Revisit only with measured log growth |
| `provider_recovery` replacement attempt for the in-run fresh-session fallback (G9) | Recorded architecture choice backed by AGENTS.md process-tree cleanup: Inertia's fallback starts a second process, which needs its own attempt, native refs and cleanup proof. T3 still never writes the reason |
| Two-strike `resumeRejected` rule across turns (G9) | Recorded architecture choice; T3's `ddc4f5760` agrees that a rejected resume may be transient. In-use refusals are excluded, as in T3 |
| Provider observations fenced by attempt only, without `expectedStatus` (G9) | Recorded architecture choice: Inertia's providers report intermediate statuses; T3's guard contract is unchanged |
| Automatic stop escalation and `unconfirmed-released` (G5) | AGENTS.md: terminate complete process trees on timeout or cancellation |
| Only replay-safe effects retry (G7) | Recorded architecture choice: a process-bound kind never replays after its process is lost, which T3 also does not do; T3 retries the other kinds, Inertia only the replay-safe ones |
| Receipts scoped by actor with payload fingerprints (G5, G6) | Recorded architecture choice; T3's new race test confirms the intent |
| Coverage capped at 2,048 ids and candidates bounded at 256 (G11 part 1) | AGENTS.md bounded input sizes. With the omitted-id listing, listed ids come from the 256-item window only. Move coverage onto handoff records, as T3 does, if long chats reach the cap |
| Eager fork history snapshot; explicit-turn fork source points; portable rollback where T3 refuses; process-bound `native.rollback` (G12) | Recorded architecture choices, unchanged upstream |
| Phase 5: queue cap, never a same-run restart, separate queue-item entities, no device attachment operations, explicit legacy queue move | See [phase5-queue-design.md](phase5-queue-design.md) section 5 |
| Phase 4: visible managed chats, per-conversation mailbox, host approval on create and cancel, automatic-wakes setting, exact-target Stop and cancel scope | Recorded architecture choices from Phase 4; T3's churn since the pin (hidden subagent threads, process release, background holds) does not change them |

### Closed by this re-baseline

| Former difference | Now |
| --- | --- |
| A move retires the old checkout's backing; moving back starts fresh (G11 part 1) | Not forced by an invariant; containment and identity are satisfiable with relocation. Close with brief C5 |
| Portable fallback where T3 failed a native fork (G12) | T3 now falls back too (`c3e5bfc02`); record as matched and add the notice |
| Watcher notes after user items; per-item access ceiling; Send now never restarting; next-run configuration; narrow Private Connect queue; desktop reorder; three visible rows (Phase 5 draft) | Follow T3 (phase5-queue-design section 5) |
| Delegation wait default 300 s (Phase 4) | 240 s, as T3 (package 1) |

### Revisit

| Difference | When |
| --- | --- |
| No child-question wakes (Phase 4) | Persisted-questions phase: import T3's busy-parent steer and finished-child drop together |
| Stop during new-turn preparation accepted with nothing to stop (G5) | Client parity; T3 still interrupts `preparing` |
| Delegated cancels are non-command stops (G5) | Agent-tools phase, with Stop attribution |
| No idle compaction | Decide whether it is in scope |
| Archive with running delegated tasks disarms wakes; T3 refuses (`ac1cb9232`) | Optional confirmation in client parity |

## F. Corrections and limits

Corrections to the slice reports that fed this document:

- A2: `unlessInterruptRequested` came with `52c1491c8` (#24545, successful
  worktree handoffs complete normally) and `writeIfTurnItemUnchanged` with
  `70833b2f5` (#29036, tool calls cut off by a released session no longer keep
  the thread Waiting). `writeIfSubagentUnchanged` came with `4b99420d8`.
- Retry deadlines: the core report gave 15 min plus the retry delay and the
  context report 10 min. Both exist: a 10 min retry budget in the Claude and
  Codex adapters (`PROVIDER_RETRY_BUDGET_MS`) and a 15 min silent-retry
  watchdog for every provider (`PROVIDER_RETRY_STALL_TIMEOUT`).
- "Recovered context" (`7d8f6c948`): the core report said G9 writes no visible
  marker. The G9 working tree shows a turn notice with restored-message counts;
  no additional marker is needed in G9.
- Codex thread-in-use (`a445272c7`): listed as missing by the context report;
  the G9 working tree adopted it on 2026-11-14.
- Event pruning: receipts are kept, except v1 receipts of imported legacy
  threads.
- `activeSteeringAcceptsAttachments` arrived with the Kiro provider
  (`55e253856`, 0.1.7), not as a standalone change.

Not verified: no upstream or Inertia code was executed. Unexercised: Claude CLI
resume from another cwd; Codex `thread/inject_items` on a legacy-history
thread; Pi and Cursor SDK relocation; whether Claude and Codex MCP clients cut
a host tool call at 300 s against Inertia's HTTP server; Inertia's
isolated-workspace failure path, `inertia_send_message` to a stopping chat,
fork exclusion of queued items and Codex goal behavior while a delegated wake
is pending; which composer submissions T3's web client sends with an explicit
model selection; remote, relay and tunnel behavior; Windows and Linux
behavior.
