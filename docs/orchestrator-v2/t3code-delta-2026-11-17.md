# T3 Code delta `b05c505b` → `b387e3a17` against ORCHESTRATOR V2 (addendum)

Recorded 2026-11-17. This is an addendum to
[t3code-delta-2026-11-14.md](t3code-delta-2026-11-14.md). It follows that
document's format and rule: T3 Code's current orchestrator is the reference
for every decision. Inertia keeps a deliberate difference only where an
`AGENTS.md` invariant forces it or where an architecture choice is recorded.
Only changes that matter to Inertia are kept. The scope is orchestration-v2,
provider-core, and the shipped providers (Codex, Claude, Pi, Cursor SDK and
OpenCode).

## Range and conventions

| Item | Value |
| --- | --- |
| Upstream start | `b05c505b9c72336e0f0e1b5b39b1d9811a925cc3`, 2026-11-14 15:15 UTC (the 2026-11-14 pin) |
| Upstream end | `b387e3a179d7495321019363c5ba11e847834cd0`, 2026-11-17 20:37 UTC |
| Commits | 831, all first-parent. 128 changed files under `apps/server/src/orchestration-v2/` (+16,143 / −2,207) |
| Release boundary | `v0.1.10` (`7d32075e3`, 2026-11-16 20:13 UTC) is in the range. Rows give `0.1.10` or `main` |
| Inertia comparison base | branch `orchestrator-v2` at `5543eaa86`, clean. This includes the 2026-11-14 core safety fixes (`2de569047`) and the G11 completion (`2a8cd12e7`). C6 is not on the branch yet |

### Conventions

- T3 anchors are `path:line` at `b387e3a17`. Abbreviations as before: `O` =
  `apps/server/src/orchestration-v2/Orchestrator.ts`, `PTS` =
  `apps/server/src/orchestration-v2/ProviderTurnStartService.ts`, `CP` =
  `CommandPolicy.ts`, `M` = `apps/server/src/mcp/OrchestratorMcpService.ts`,
  `C` = `packages/contracts/src/orchestrationV2.ts`.
- Inertia anchors are `path:line` in the `orchestrator-v2` worktree at
  `5543eaa86`.
- Method:
  - Triage: every title in the range was triaged by keyword. Every commit
    that touches the orchestration-v2 core, provider-core, the MCP
    orchestrator service or the five shipped provider packages was listed
    (about 180).
  - Diff reading: diffs were read for the commits kept below, in three
    slices: (1) queue, steering, Stop, effects and recovery; (2) delegation
    and background work; (3) handoff, sessions, forks and providers.
  - Spot checks: the high-impact claims were checked again against the
    upstream source: `4c8cb0445`, `5393882fb`, `0597532f1`, `34204a39e`,
    `9ec71438c`, `c2eb8f336`/`33892dcc7` and the C6 call site.
  - Nothing was executed.
- Status vocabulary is as in the 2026-11-14 document: **satisfied**,
  **satisfied in kind**, **satisfied by construction**, **partial**,
  **not satisfied (adopt)**, **conflicts** (with a named deliberate
  difference), **assigned**, **n/a**, **not assessed**.

### Scope facts

- Byte-unchanged in the range: `ContextHandoffDelivery.ts`,
  `ContextHandoffService.ts`, `EventStore.ts`, `CommandReceiptStore.ts`,
  `ProviderSessionTransitionPolicy.ts`, `DispatchModeLimit.ts`,
  `apps/server/src/scheduling/` and `delegatedTaskModes.ts`.
- `QueuedRunOrder.ts` **changed** (`4c8cb0445`). The 2026-11-14 scope facts
  said it was byte-unchanged, and the delivery-order line ("delegated
  completions first") no longer holds; see A1.
- Effect slots are unchanged. `EFFECT_WORKER_SLOT_WAIT = 30 s` is at
  `EffectWorker.ts:1047`, and the title-generation cap of `concurrency − 1`
  is at `:1064`. The range changes `EffectWorker` and `EffectOutbox` only in
  `c76ba848a`, `a68c367e4`, `997b304dd`, `033ae7cba` and `6071022cb`, and
  none of them touches slots.
- Stop is unchanged in shape: `thread.interrupt.unresponsive` followed by a
  user Force stop. `6fa874e98` extends that path to OpenCode.
- New contract fields:
  - `canForkWhileSourceRunning` on turn capabilities (`C:290`, `2904c397a`).
  - `executedModel` on runs.
  - `runId` on pending background work (`b79d277cd`).
  - Issue-link fields (n/a).
- Run, attempt and status enums are unchanged. `provider_recovery` is still
  never written.
- The Codex `injectHistory` mechanism is unchanged (`Adapters/CodexAdapterV2.ts:8067-8091`).
  Its call site moved to `PTS:1820-1834`. See section C.

## A. Queue, steering and Stop (Phase 5)

### A1. Delivery order: completions and messages merge by request time

`4c8cb0445` (#34620, 0.1.10). `queuedRunsInDeliveryOrder` now splits queued
runs into delegated completions and everything else. Each list keeps its
`queuePosition ?? ordinal` order, and the two lists are merged by
`requestedAt`, with the completion winning a tie
(`apps/server/src/orchestration-v2/QueuedRunOrder.ts:13-50`). The reason
given in the code is that neither kind can hold the other back while more of
it keeps arriving. The test was renamed "delivers completions and queued
messages in request order".

Consequences in T3:

- A stop-and-send run takes `queuePosition: 1` with `requestedAt: now`
  (`O:7746-7757`). A completion requested earlier therefore still runs first.
  The rule from `631ea1b6d`, that an unheld delegated result runs first,
  now follows from the order function and no longer needs a special case.
- `queued-run.start` (Send now on a specific queued item while the thread is
  stopped) starts the selected run, not the head of the order. It refuses
  completions and notifications as targets (`O:15295-15318`). This predates
  the range: it is at `O:15072-15076` at `b05c505b`.

Inertia today:

- The order is `ORDER BY (delegated_completion_json IS NULL), (watcher_note_json IS NOT NULL), sequence`
  (`src/server/persistence/queued-message-repository.ts:72`).
- A manual Send of a user item dispatches a waiting delegated delivery first
  (`src/server/runtime/queued-message-runtime.ts:105-108`).

**Not satisfied (adopt). This invalidates phase5-queue-design 4.2, the
"delegated results first" clause of 2.6, and migration 124's planned
index.**

Follow T3:

- Order user items, watcher notes and delegated deliveries by request time.
  Delegated deliveries keep their own order; every other item keeps its
  position.
- For Inertia's coalesced per-conversation mailbox, the delivery's request
  time is that of its earliest undelivered completion.
- A stop-and-send item is stamped now, so earlier results still precede it.

The Phase 4 rule "a manual Send dispatches a waiting delegated delivery
first" was never T3's. T3's `queued-run.start` starts the selected item. That
rule has to be re-decided, either as a recorded difference with a reason or
by following T3. Phase 5 package 1, S.

### A2. Queue and steering rows

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `0597532f1` (#38216) | main | A steer that carries a selection on another provider instance is downgraded to `queue_after_active` when the target provider cannot interrupt-restart. That covers Claude and Pi: `providerSwitchWaitsForTurn` = `supportsQueuedMessages && !(supportsInterrupt && supportsSteeringByInterruptRestart)` (`CP:136-145`). The provider stays usable and runs the switch after the turn, without stopping it (`O:7244-7267`). Before a session exists, the adapter's capabilities stand in. The explicit `restart_active` path below it is unchanged, and an explicit steer that Stop reached still fails | There is no path yet. Configuration is refused while running, and queue items carry a route identity | **Changes phase5 2.5 step 2.** A Send now that forces a restart *only because of an instance switch*, on a harness without interrupt-restart, queues behind the turn: no stop and no "Stop and send" label. Codex, OpenCode and Cursor SDK keep Inertia's stop-and-send rendering of T3's restart. The explicit Stop and send action (4.6) is unchanged. Package 2, S |
| `7a72fe301` (#33857) | 0.1.10 | A `message.dispatch` to an idle thread (`start_immediately`, `queue_after_active` or `defer_start`) first starts the next unheld queued run, so the new send waits behind it. Restart continuations are exempt (`O:15529`; `latestRunEnded`, `O:2405-2520`) | There is no check on the send path (`src/server/runtime/commands/message-send-command.ts`). The drain after settlement is asynchronous (`queued-message-runtime.ts:632`), so a direct send in that gap can overtake waiting items | **Not satisfied (adopt).** Package 2 acceptance row plus a race test, S |
| `3209fa953` (#36616) | 0.1.10 | `queue.resume` is refused while worktree setup is pending or failed: "Retry worktree setup or choose a workspace before resuming the queue." (`O:15337`) | There is no Resume yet | **Not satisfied (adopt).** N7 and N9 acceptance row, XS |
| `8cbaf7505` (#36855) | 0.1.10 | A steer that missed its turn moves its transcript position into the run it starts (`apps/server/src/orchestration-v2/TurnItemPositionStore.ts:77`) | Queue items become transcript rows only at admission (4.7) | **Satisfied by construction.** Optional package 2 test |
| `81fd06998` (#38320) | main | A same-run `steering_restart` onto another Codex instance now records the visible `handoff` turn item (`O:6704-6755`) | Inertia never writes a same-run restart (4.6). Stop and send starts a new run, whose handoff is prepared normally | **N/a** (4.6). Add a package 2 test that Stop and send onto another instance records `context.handoff-prepared` and the restored-context notice, XS |
| `997b304dd` (#29699) | 0.1.10 | An accepted queued edit deletes the attachments it removed, skipping files still referenced elsewhere (`skipReferenced`, `EffectWorker.ts:661`). An edit that names a missing file is refused (`ThreadMessageIntake.ts:167`) | There is no queue edit yet | Package 5 acceptance row next to `cebdf3998` and `ceed427d7`, XS |
| `85168744f` (#30695) | 0.1.10 | Stop on a stalled run closes its approval and question cards (`O:12552`) | Stop cancels pending approvals and inputs and broadcasts them `cancelled` (`src/server/runtime/turns/turn-run-state-coordinator.ts:290-330`) | **Satisfied** |
| `6fa874e98` (#31021) | 0.1.10 | An OpenCode Stop that is unconfirmed after 10 s raises `ProviderAdapterInterruptTimeoutError`, which leads to "unresponsive" and a user Force stop (`packages/provider-opencode/src/server/adapter.ts:91`) | The G5 ladder escalates automatically | **Conflicts** with section E "Automatic stop escalation" (AGENTS.md process-tree termination). Keep the difference |
| `135d7a980` (#38035) | main | When a provider failure holds the queue, buffered provider notifications (background-task wakes) stay unheld and start on a second pass (`O`, `startNextQueuedRunOnce`) | Inertia has no buffered-notification runs. Claude background output stays inside the open turn (`src/server/provider/claude-delegate-lifecycle.ts:84-97`) | **N/a.** Package 3 note: if provider wakes ever become queue items, they are exempt from the failure hold, as 2.9 already exempts them at restart |
| `5da89cfce`, `5374e2d19` | 0.1.10 | Run-update reactions and continuation or wake requests run in per-thread order, so one thread's lock does not stall other threads | Command lanes are serial per thread (`src/server/orchestration-v2/command-lanes.ts:12-13`), and drains are kept per conversation (`queued-message-runtime.ts:64`, `:193-215`) | **Satisfied by construction** |
| `74178f471`, `861211f21`, `e5c636219` | 0.1.10 | Self-settle survives a steered queued message; settlement cleanup skips deleted threads; a `json_valid` guard is added to T3's queued-input index | Inertia has no thread settlement and uses a different schema | **N/a** |

## B. Runs, effects and restart recovery

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `7d4f24237` (#34639) | 0.1.10 | Before a turn start reuses a session, it interrupts provider turns still marked running from earlier runs that ended `failed`, `interrupted`, `cancelled` or `rolled_back`, superseded attempts included (`PTS:89`, `:773`) | A new run is refused while the previous attempt's cleanup is `pending` or `unconfirmed` (`src/server/orchestration-v2/projector.ts:68`, `turn-repository.ts:137`, `:286-296`). The G5 ladder ends the process | **Satisfied in kind.** Inertia refuses where T3 recovers |
| `c76ba848a` (#14424) | 0.1.10 | When the last start attempt fails, the run is settled failed (`failStartingRun`, `PTS:2067`). If that write fails, the start effect keeps retry ownership (`EffectWorker.ts:68`, `:976`) | Start is not an outbox effect. A start failure settles `turn-start-failed` (`src/server/runtime/turns/turn-controller.ts:919`, `:957`). Boot interrupts a leftover `starting` turn | **Satisfied in kind.** Covered by the D.1 regression row for `37e0fd378` |
| `8be0e6c8e` (#31640) | 0.1.10 | A steering restart keeps the run's `startedAt` (`PTS:1672`) | `startedAt` is immutable once set (`projector.ts:131`). A G9 replacement attempt cannot change it | **Satisfied by construction** |
| `51cdf2326` (#37325) | 0.1.10 | When the provider runtime dies (adapter-reported, not `raisedByT3`), process-bound root tool calls and subagents that outlived the root run are ended `interrupted` from their stored rows, under an unchanged-row guard (`RunExecutionService.ts:159`, `:1374`; `packages/provider-core/src/server/ProviderAdapter.ts:458`) | Every turn end settles running activities and live subagents (`src/server/runtime/turns/turn-settlement-coordinator.ts:120`, `:140-147`). Work does not outlive a turn | **Satisfied by construction** |
| `34204a39e` (#32413) | 0.1.10 | See the detail after this table (`ProviderRuntimeRecoveryService.ts:62`, `:220-260`, `:440-500`) | Boot interrupts queued and starting turns (`src/server/persistence/recovery-repository.ts:14-30`). Continuation exists only after `app-update` (`src/server/runtime/restart-continuation-scheduler.ts:105`) | **Refines phase5 4.10 and 2.9.** Package 2 (definition) and recovery phase (resend), S–M |
| `a68c367e4` (#25603) | 0.1.10 | Crash continuations keep a cumulative `processLossCount`. Delivery stops before the fourth crash recovery of an unfinished turn, whatever the time between crashes. A planned shutdown or a completed turn resets it (`RestartContinuation.ts:240`, `:298`) | No crash continuation. Continuation after `app-update` has `MAX_ATTEMPTS = 3` per plan (`restart-continuation-scheduler.ts:10`, `:155`) | **N/a today.** A requirement for the recovery phase (D.6) |
| `033ae7cba` (#32746) | 0.1.10 | An outbox row this build cannot decode is failed at claim time, so it does not block its thread (`EffectOutbox.ts:594-602`) | Only kinds with a handler are claimed (`src/server/orchestration-v2/effect-outbox.ts:128-130`, `:345`), and a database from a newer build is refused (`src/server/persistence/database-recovery.ts:776`). A `JSON.parse` failure in `fromRow` (`effect-outbox.ts:26`) would make `claimNext` throw on every pump (`:225`) | **N/a in practice.** Optional D.1 hardening, XS |
| `943de8fe9` (#37728) | main | A Claude turn with no provider output for `PROVIDER_RETRY_BUDGET_MS` (10 min) after its prompt or a request goes out fails non-retryably with `claude_request_unanswered` and is stopped (`Adapters/ClaudeAdapterV2.ts:6451-6464`) | Only the 6 h inactivity watchdog applies (`src/server/runtime/turns/turn-timeout-coordinator.ts:40-75`). `prompt-unanswered` covers only a finished result with no output (`src/server/provider/claude-agent-sdk-harness.ts:753-755`) | **Not satisfied (adopt).** Fold into the D.4 retry-deadline item, S. Long tool calls must reset the timer |
| `733a20008` (#24140) | 0.1.10 | Checkpoint refs owned by deleted threads are pruned, at delete and by storage cleanup | Deleting a conversation deletes its `refs/inertia/checkpoints/<id>/` refs (`src/server/runtime/commands/conversation-commands.ts:833`, `src/server/checkpoints.ts:997`) | **Satisfied in kind.** A sweep for refs orphaned by a crash between the database delete and the ref delete is **not assessed** (checkpoint audit, D.5) |
| `c71f98cad`, `4f829644f`, `980f5d412`, `a62bc8156`, `570640b16` | mixed | Thread reads load only recent and active runs; other projection read performance changes | Inertia's agent reads return the conversation and its latest turn (`src/server/runtime/agent-thread-manager.ts:472-507`) | **Satisfied by construction** / n/a (T3 storage) |

`34204a39e` in detail:

1. A run is *never started* when no attempt has a provider turn, even if its
   status is `running` or `starting` with `startedAt` set
   (`rewindUnacceptedRuns`, `:220-260`). The reason given: a run is marked
   running before its provider accepts the prompt.
2. The user's own prompts rejoin the held queue, as in `737afe24b`.
3. When restart continuation is enabled, unattended prompts are sent again
   under the same run (`command:restart-resend:<run>`). These are prompts
   with `creationSource: "mcp"` or a `scheduledTaskId`, excluding
   notifications and delegated completions (`:452-457`). A resend is skipped
   when a Stop was recorded on the run or on the parent that delegated it
   (`restartStopRequested`). A run is resent at most `MAX_RESENDS = 3` times
   (`:62`, `:489`).

For Inertia:

- 2.9's "never reached the provider" test is defined by a provider-turn
  observation on any attempt, never by turn status.
- Agent-sent prompts (`inertia_send_message`), and later scheduled prompts,
  that never started are re-dispatched after boot. The limit is three
  resends, with none after a recorded Stop on them or on the delegating
  parent's run. Each resend is a new attempt admitted only after boot
  confirms cleanup, so the G8 rule holds and no same-run restart is written.
- Delegated deliveries and notifications are still never requeued.

## C. Context handoff, sessions, forks and providers

### C1. Impact on the in-flight C6 package (Codex native history injection)

1. **The mechanism is unchanged.**
   - `ContextHandoffDelivery.ts` and `ContextHandoffService.ts` are
     byte-unchanged.
   - `injectHistory` (`Adapters/CodexAdapterV2.ts:8067-8091`) still returns
     `false` on `-32601` before any mutation and treats every other error as
     a protocol error.
   - No generated Codex protocol change touches `thread/inject_items`.
   - The call site only moved: `startWithHandoffs`, `PTS:1820-1834`. It still
     runs after load and before `turn/start`.
   - The second `thread/inject_items` call (`CodexAdapterV2.ts:1962`,
     restoring `additionalContext` after compaction, "items injected mid-turn
     make the turn sample again") predates the range (`:1904` at `b05c505b`).
     It confirms brief C6 point 5: never inject while a turn is active.

   Points 1 and 3 to 7 of brief C6 stand.
2. **The budget formula changed (`9ec71438c`, #32598, 0.1.10).** The work
   reserve is now
   `min(max(16_000, ceil(window / 4)), ceil(window / 2))`
   (`packages/provider-core/src/server/handoffBudget.ts:122`). Small windows
   no longer reserve all of themselves. The budget is the same for inline and
   injected delivery. Inertia still uses `Math.max(16_000, Math.ceil(window / 4))`
   (`src/server/orchestration-v2/portable-history.ts:88`). Land this XS
   change before C6's fixtures are written, so the items-at-the-cap and
   small-window fixtures assert the current rule.
3. **Injected history is text only; missed images ride on the prompt**
   (`c2eb8f336`, `33892dcc7`, main). T3's comment at `PTS:1121`: "History
   delivery (inline or injected) is text only, so missed images ride on
   prompts until a later run's is accepted."
   - Missed-run attachments are put in front of the message's own
     (`PTS:1852-1872`).
   - Pending images count as a prompt (`prompted`, `PTS:1860`), so an
     empty-prompt native `resumeTurn` is skipped while any are pending.

   C6 needs no image work, because Inertia does not yet re-attach missed
   images (see C2). C6 must still:
   - keep injected items text only;
   - not assume an injected turn's `turn/start` input is the bare user text
     with no attachments;
   - keep the "prompted" decision separate from whether history was
     injected. An injected turn with nothing inline but with pending images
     is still a prompted start.
4. **The recovery handoff now excludes `rolled_back` runs and starts with
   inherited fork items** when there is no fresh-context boundary
   (`PTS:1158-1192`). Inertia's portable history already does both
   (`src/server/orchestration-v2/portable-history-source.ts:219-220`, `:238`).
   C6 point 6 (full restore, then `uncertain-delivery`) is unchanged.
5. **A new neutral rule, `nativeSessionMissesKeptTurns`** (`PTS:123-165`,
   used at `:1420`). For providers without native rollback, any non-pending
   handoff on the current native thread, injected or inline, counts as
   evidence that the session holds the kept turns. It does not apply to
   Codex. It agrees with C6 point 4: credit coverage at delivery, whatever
   the turn outcome.

### C2. Handoff, sessions and switches

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `c2eb8f336` (#37941) | main | A failed or interrupted run with no accepted attempt (`missedRuns`, `PTS:1052-1059`) offers its images on the next prompt until a later run's prompt is accepted. Compaction and `/goal` starts carry none (`PTS:1121-1146`, `:1852-1872`) | G9 re-offers the refused request's **text** as delta history (`implementation-progress.md`, G9 "What the next turn sends"). Images are not re-offered: "historical attachments are not replayed" (`src/server/orchestration-v2/portable-history.ts:167`). No missed-run attachment path was found in `src/server` | **Not satisfied (adopt).** New package "G9 follow-up: missed-run images", S–M. Attachment GC must retain an undelivered run's images until a later prompt is accepted. Applies to the Codex in-use refusal and to every never-started run |
| `33892dcc7` (#38241) | main | After a resume fallback the retry handoff is dropped, because the full summary covers it, but missed images still ride on the prompt (`PTS:1097-1100`) | The G9 fresh-session fallback restores full portable history and no images | **Not satisfied (adopt)**, in the same package |
| `9ec71438c` (#32598) | 0.1.10 | Work reserve capped at half the window | `portable-history.ts:88` | **Not satisfied (adopt).** D.2, XS, before C6 fixtures |
| `0072f66ec` (#37943) | main | A Claude `initialize` or `setMcpServers` timeout (90 s, `Adapters/ClaudeAdapterV2.ts:363`) retries a fresh session once under a new session id. A resumed open retries under the same id (`:1920-1935`) | No Claude startup or MCP-registration deadline in `src/server/provider/claude-agent-sdk-harness.ts`. Only the inactivity watchdog applies. MCP servers go through SDK options | **Not satisfied (adopt).** D.4, S–M, verify first (AGENTS.md: bound runtime). First measure where an SDK-options startup hang surfaces |
| `629d5083b` (#37610) | 0.1.10 | A Claude "No conversation found with session ID" on resume, from the result or from stderr, fails the turn, and the next start is fresh | `claudeSessionUnavailable` (`src/server/provider/claude-startup-failure.ts:36-41`) sets `sessionUnavailable` (`claude-agent-sdk-harness.ts:460`), and the fresh-session fallback runs in the same turn | **Satisfied**, and stronger. The stderr-only signal is not covered by a fixture (XS test) |
| `dbbbe8b0d` (#34621) | 0.1.10 | A Claude CLI exit before the turn attaches fails the start with its cause (root refusal) | The stderr tail is the failure detail (`claude-agent-sdk-harness.ts:690-705`), and `bypass_root` is mapped (`claude-startup-failure.ts:28`) | **Satisfied in kind** |
| `8009cd8c3` (#38169), `ea6d3fc30` (#38130) | main | Codex `applyModelSelection` applies the speed (`serviceTier`) live through `thread/settings/update` (`CodexAdapterV2.ts:7865-7890`, `:8172`). A steer that carries a selection applies it. The applied tier survives a retried attempt | Configuration is refused while running (`src/server/runtime/commands/conversation-commands.ts:60`, `:585`, `:623`). `serviceTier` is set only at start and resume (`src/server/codex/app-server-run.ts:1036`, `:1096-1115`) | **Assigned** (Phase 5 4.8). Live apply is no longer Claude-only; see section E |
| `3eadb214e` (#34498) | 0.1.10 | A replayed `<local-command-stdout>` echo after `setModel` on an idle Claude session is not a wake (`ClaudeAdapterV2.ts:10588`) | Inertia never calls `setModel` on a live session | **N/a today.** Carry into the 4.8 Claude live-apply item |
| `2e3313418` (#36839) | 0.1.10 | A provider switch on a portable fork includes the inherited items when there is no fresh-context boundary (`O:8716-8721`) | Portable history always prepends inherited fork items (`portable-history-source.ts:219-220`) | **Satisfied.** The boundary part is dormant (N6) |
| `46fff7943`, `a767d2329` | 0.1.10 | A selection change compares the thread's worktree, not a shared session's cwd; the background-work probe covers every provider thread of the thread | No sessions are shared across chats (`sameCheckoutPath`, `src/server/cli-import/resume-cwd.ts`), and live traces settle at turn end | **N/a** |

### C3. Forks, rollback and checkpoints

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `2904c397a` (#37955) | main | The new capability `canForkWhileSourceRunning` (`C:290`) is true for Claude only (`ClaudeAdapterV2.ts:527`). Policy and turn start fork natively from a completed turn while a later source turn runs (`CP:398`, `PTS:1240`). The boundary is valid only if no later turn, running or finished, wrote after it (`ClaudeAdapterV2.ts:2777`) | A busy source always falls back to portable (`native-source-unavailable`, `src/server/runtime/fork-session-service.ts:52-56`; `src/server/provider/native-conversation-service.ts:45-46`) | **Not satisfied (adopt).** D.5, S–M: a manifest flag for Claude only, a relaxed busy check gated on it, the boundary rule, and a portable fixture with a running source. The G12 differences are untouched |
| `48afc47e7` (#29874) | 0.1.10 | Message search excludes rolled-back runs and cancelled queued messages (`ThreadSearch.ts:283-291`) | Search filters only on archive state and role (`src/server/persistence/message-search.ts:30-39`). Rolled-back turns stay as rows and are hidden in the renderer through `rolledBackTurnIds` (`src/server/persistence/snapshot-repository.ts:95`) | **Not satisfied (adopt)** for rolled-back turns: D.5, S. Queue items are satisfied by construction |
| `13ecf5b22` (#38262) | main | Cursor SDK rolls back natively: `agent.rewind` restores the next run's start checkpoint from the SDK's local store (`packages/provider-cursor/src/server/adapter.ts:3251`) | Edit from here uses portable rollback for Cursor SDK (G12) | **Satisfied in behavior.** Native rewind is optional, M. It relies on SDK store internals, so check stability and license first |
| `d2a894a24` (#32255) | 0.1.10 | Fork-source deletions are serialized, so forks of forks keep the deleted source's data | Eager fork-history snapshot (G12) | **Satisfied by construction** |
| `0b308312d` (#36918) | 0.1.10 | Cursor SDK 1.3.1 implements `resumeTurn`: native `ResumeAction` once the stopped run has checkpointed, a replay of the dropped prompt if it stopped earlier, else `ProviderResumeUnsupportedError` (`packages/provider-cursor/src/server/adapter.ts:2729`, `:3065`) | No Resume. `@cursor/sdk` is pinned at `1.0.38` (`package.json:302`) | **Assigned** (N7 provider item for Cursor SDK), M. It needs an SDK upgrade, with third-party notices and packaging verification |

### C4. Providers (shipped)

| Commit | Rel. | T3 rule | Inertia | Status |
| --- | --- | --- | --- | --- |
| `7bc474667` (#29801) | 0.1.10 | A Claude tool denied by Stop, or a workflow member stopped by Stop, shows `interrupted` or `cancelled`, not `failed` (`ClaudeAdapterV2.ts:8726`) | Activities running at Stop are titled "Interrupted · …" but keep status `failed` (`src/server/runtime/turns/turn-activity-projection.ts:189-210`; `src/server/provider/claude-tool-activity-projection.ts:103`) | **Partial (adopt).** D.4, XS–S |
| `b4e47a5a6` (#37826) | 0.1.10 | Cursor loads project setting sources only in full access without sandbox or auto-review | `settingSources: []` (`src/server/provider/cursor-sdk-session.ts:66`) | **Satisfied** (stricter) |
| `4c9a87309` (#23354) | 0.1.10 | An aborted Cursor SDK stall must not stop the server | The SDK runs in a per-run child process (`src/server/provider/cursor-sdk-worker.ts`), so the server survives. Whether 1.0.38 has the `onStall` rejection at all is **not assessed** | **N/a** for server survival |
| `35a172883`, `3eeec6f3a` | 0.1.10 | A failed Pi compaction is a failed turn; `/clear` resets the Claude context meter | `src/server/provider/pi-rpc-harness.ts:160-185`; `usage.reset()` (`src/server/provider/claude-message-projector.ts:166`) | **Satisfied** |
| `05ccd6bfb`, `6a6fecbfd`, `b732f647f`, `e5b6c96a4` | mixed | Pi extension session switches; a long-lived Pi process | Third-party Pi extensions are off (`src/server/provider/pi-launch.ts:70-76`), with one process per run | **N/a** |
| `6071022cb`, `f5c2ceb4d` | 0.1.10 | The process-bound effect `provider-session.apply-thread-title` renames the Claude native session | Inertia only reads Claude's `customTitle` (`src/server/provider/claude-session-title.ts:3-5`) | **Not satisfied**, optional provider item, S, low priority |
| `6f06f2675`, `52074e925` | 0.1.10 | Codex web searches and plan items settle at turn end | Every live trace settles at turn end; plans are snapshots (`src/server/codex/plans.ts:16-18`) | **Satisfied in kind** |
| `96290af4e`, `4aead9e6d`, `6b9d90f12`, `4afa6f098` | 0.1.10 | Codex full access uses a granular `approvalPolicy` so browser and app prompts are not rejected; unshowable Claude MCP elicitations are `cancel`, not `decline`; Codex failure categories after retries; proxied Codex usage-limit reset times | Inertia sends `approvalPolicy: "never"` (`src/server/codex/app-server-config.ts:129`) and sets no Claude `onElicitation` handler | **Not assessed.** XS checks in D.4 |
| `ddb14277e`, `907ff258e`, `1e60d6051`, `b387e3a17` | main | Claude and OpenCode goal edge cases; MCP Apps | Only Codex declares native goals (`src/server/provider/capability-manifest.ts:281`), and Inertia has no MCP Apps surface | **N/a** |

## D. Delegation and background work

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `5393882fb` (#15622) | 0.1.10 | Task and thread waits return before common MCP client timeouts: `DEFAULT_WAIT_TIMEOUT_MS = 30_000` and `MAX_WAIT_TIMEOUT_MS = 45_000` (`M:143-144`), applied to `delegate_task` wait (`M:1942-1943`) and `t3_thread_wait` (`M:3526-3527`). The contract reads "Mode 'wait' only. At most 45 s." (`packages/contracts/src/orchestratorMcp.ts:189`). Only `request_secret` keeps 10 min and 60 min (`M:145-146`). This replaces `ac781dcb7`'s 4 min default and 60 min maximum | `DELEGATION_WAIT_DEFAULT_MS = 240_000` and `DELEGATION_WAIT_MAX_MS = 1_800_000` (`src/shared/orchestration-delegation.ts:16-17`), clamped in `src/server/runtime/delegation/task-wait.ts:19-22`. The bridge budget is 270 s (`:32-36`). The OpenCode MCP timeout is derived from the maximum (`src/server/provider/host-tool-mcp-config.ts:34`). Conversation waits are already 15 s and 20 s (`src/server/runtime/agent-thread-wait.ts:21-22`) | **Not satisfied (adopt). Reverses the 2026-11-14 choice** (section E "Closed" row and the core-safety "Delegated task wait" entry). Set 30 s and 45 s for `inertia_delegate_task` wait and `inertia_wait_for_task`, update the tool descriptions, approval text and agent-surface budget, and re-derive the OpenCode MCP timeout. D.1, S |
| `0df1967cf` (#37942) | main | When the result run completed with no assistant text and no stop notice, the task looks back through its own earlier completed runs for the report. It stops at another task's run or a non-completed run, and skips Monitor updates (`delegatedTaskReportRuns`, `packages/provider-core/src/server/subagentProjection.ts`) | The result is the newest terminal, non-rolled-back, non-watcher-wake task turn, and its text comes only from `terminal_assistant_message_id` (`src/server/orchestration-v2/delegation-reads.ts:149-151`, `:173`, `:188-191`). A silent later turn gives a null result | **Not satisfied (adopt).** D.1 "delegated result polish", S |
| `c02b98bb3` (#37738) | 0.1.10 | A Codex hook that stops a turn reports `completed`. T3 records "Stopped by the provider" with the hook's reason (`hook/completed` with `run.status === "stopped"`, `CodexAdapterV2.ts:5059-5071`), and a textless delegated result appends it | Hook activity is a timeline row (`src/server/codex/app-server-item-events.ts:63`), but the turn and the delegated result carry no stop reason | **Not satisfied (adopt).** Same row, XS–S, with a Codex portable fixture |
| `f0495f741` (#32407) | 0.1.10 | A multi-report notice groups outcomes ("1 failed, 2 finished") instead of applying the worst verb to all (`packages/provider-core/src/server/notification.ts`) | `delegatedWakeSummary` applies one precedence verb to the batch, so one failure reads "3 delegated tasks failed: A, B, C" (`src/server/orchestration-v2/delegation-text.ts:37`, `:67-77`) | **Not satisfied (adopt).** D.1, XS |
| `b79d277cd` (#37793) | 0.1.10 | A follow-up task waits only on background work that its own runs started (`pendingBackgroundTasks[].runId`) | `waiting_for_children` checks any unresolved task whose parent is the child conversation, without scoping to the follow-up's turns (`delegation-reads.ts:156-158`) | **Partial (adopt).** XS: scope to tasks whose `source_turn_id` belongs to the task's turns |
| `3605d5284` (#31840) | 0.1.10 | Claude background tasks survive a failed turn on a live process | Any result, an error included, is provisional while non-ambient background tasks are live (`claude-delegate-lifecycle.ts:84-97`, `:218-231`) | **Satisfied in kind** (no run boundary to survive) |
| `25fada935` (#38112) | main | A child run that is `waiting` marks the parent's subagent row and node `waiting` (`O` near `:15824`) | Derived at read time: `taskNeedsAction` (`src/server/runtime/delegation/task-view.ts:31-44`), the parent summary decoration (`:46-53`) and `TASK_NEEDS_USER_NEXT` (`:20-21`) | **Satisfied in kind** |
| `a5c28da6c` (#37901) | main | The run after a Monitor `completed` notice can be the task's result; only Monitor `updated` runs are excluded | Monitor notifications do not open turns, ambient tasks are ignored (`claude-delegate-lifecycle.ts:124`), and watcher-wake turns are excluded (`delegation-reads.ts:65`) | **N/a** |
| `11c425b4b` (#32414) | 0.1.10 | A restart-cut run with a pending, live or completed continuation is not the task outcome | `continuationPending(child)` keeps the task `working` (`delegation-reads.ts:154`, `:286-289`) | **Satisfied** |
| `910d4590d` (#21461) | 0.1.10 | Owned native child threads with a queued native continuation keep the run's stream open | The Codex parent terminal is held while delegated work is live (`src/server/codex/app-server-subagent-continuation.ts:1-40`) | **Satisfied in kind.** A queued, not-yet-started continuation is not verified |
| `e367ef0da` (#37399) | 0.1.10 | A child's turn end re-offers only its own parent run's wake | One mailbox per conversation (`src/server/runtime/delegation/task-service.ts:276-297`) | **Covered** by section E (Phase 4 mailbox) |
| `fa864bfca` (#30646) | 0.1.10 | A Claude Stop hook returns `continue:false` while an active goal has a pending T3 wake, so the goal does not re-prompt | Only Codex has native goals. No Codex goal pause on a pending delegated wake was found (`src/server/codex/goals.ts`, `app-server-run.ts`) | **N/a** for Claude. It moves B2 row `1e438c8f8` from "not assessed" to **not satisfied (adopt)**, D.4, S |
| `467ec62e0` (#30019) | 0.1.10 | Codex gets `delegate_task` and `t3_thread_wait` on a direct-only MCP registration, so Code Mode never wraps a blocking wait (`CodexAdapterV2.ts:1492-1535`) | Host tools are Codex `dynamicTools` (`app-server-run.ts:1076`). `features.code_mode` is disabled only for title generation (`src/server/codex/thread-title.ts:36-37`) | **Not assessed.** XS check; the 45 s cap lowers the stakes |
| `ad1b13659` (#37470) | 0.1.10 | Per-parent keyed runner for child-question wakes | No child-question wakes | **N/a now.** Carry into the persisted-questions phase (section E Revisit) |
| `1adc05b84` (#37822) | 0.1.10 | A retry that completes a partly applied `create_threads` re-checks the parent's current mode ceiling before dispatching the initial message (`M`, `DispatchModeLimit` around `:3127-3175`) | Not assessed for Inertia's managed-chat create and send | Agent-tools rule (D.7), XS: a replay that resumes an incomplete operation re-checks current ceilings |
| `1fe416ae4`, `e68d4f053`, `03e05f623`, `af8faa9cf` | 0.1.10 | OpenCode background subagents outlive the turn (`retainedRuntimeRequestIds` on the turn terminal in provider-core) | OpenCode 2 refuses a session with active work or a non-empty inbox (`src/server/provider/opencode2-harness.ts:187-188`) | **N/a.** Whether `session.question.reject` without a message aborts a foreground subagent step is **not assessed** (XS OpenCode check) |
| `3e1761821`, `33542a53b`, `52451a790`, `4adb946ae`, `4b9cf579b`, `649d9fc1a` | mixed | Performance, telemetry, Claude Monitor display, ACP adapters | – | **N/a** |
| `6ef2c0541` | 0.1.10 | `t3_thread_send_attachments` gives the refusal cause | – | **Assigned** (D.7) |

## E. Triaged as not applicable

These are out of scope or not applicable, by title or diffstat:

- Providers Inertia does not ship and their packages: ACP, Antigravity,
  Devin, Grok, Copilot, Command Code, fx, Kiro. This includes `ccae953c4`,
  `5dd8cde08`, `47f90ee2e`, `623047ccf`, `f82162f03`, `a99faf5a6`,
  `bee9c3b79`, `1dfc746c8` and `7f6e403a8`.
- Issue trackers (`0597b9edc`).
- Pull request and GitLab watches.
- Scheduled tasks (`21fe33c8d`, `0035cb55b`, `3ceed620c`).
- `t3_thread_launch` and worktree launch (`4ffa1da7c`, `e00614e12`,
  `fb7496931`, `c924d7898`, `dfd2187cc`). Inertia generates no branch names
  at launch.
- Titles (`760f9cbe6`, `f083f26cd`, `4d47d0b76`).
- Search and pins.
- Usage pricing and retention (`0f0c1ca19`, `428d36593`).
- Device hub.
- Windows launch performance (`b60abf32e`, `74f02db07`, `56e449ff5`). These
  matter for Windows packaging, not for orchestration.
- Web-only UI.

## F. Updated adopt list (additions and changes to section D)

### D.1 Core and agent-facing safety fixes

| Item | T3 | Rel. | Size | Change |
| --- | --- | --- | --- | --- |
| Delegated waits: 30 s default and 45 s maximum for `inertia_delegate_task` wait and `inertia_wait_for_task`; descriptions, approval text, agent-surface budget and the OpenCode MCP timeout re-derived | `5393882fb` | 0.1.10 | S | **replaces** "240 s, review the 30 min maximum" |
| Delegated result polish: look back through the task's own earlier completed turns for the report; carry a provider stop reason (Codex hook) into a textless result; group batch verbs by outcome; scope `waiting_for_children` to the task's own turns | `0df1967cf`, `c02b98bb3`, `f0495f741`, `b79d277cd` | main, 0.1.10 | S total | new |
| Optional: an undecodable effect row is failed at claim time | `033ae7cba` | 0.1.10 | XS | new, optional |

### D.2 G11 completion and C6

| Item | T3 | Rel. | Size | Change |
| --- | --- | --- | --- | --- |
| Work reserve `min(max(16 000, w/4), w/2)` in `portable-history.ts:88`, before the C6 fixtures | `9ec71438c` | 0.1.10 | XS | new, **C6 prerequisite** |
| C6 acceptance: injected items text only; the prompted decision is independent of injection; the start input keeps attachments separate | `c2eb8f336` (design note) | main | – | added to brief C6 |

### New: G9 follow-up, missed-run images (M)

| Item | T3 | Rel. | Size |
| --- | --- | --- | --- |
| Images of a failed, interrupted or refused run with no accepted provider turn ride on the next prompt until a later prompt is accepted. This includes the Codex in-use refusal and the fresh-session fallback. None ride on compaction or goal starts. Attachment GC retains them until then. A pending image forces a prompted start (no empty-prompt Resume) | `c2eb8f336`, `33892dcc7` | main | S–M |

### D.3 Phase 5 durable queues

| Item | T3 | Rel. | Package, size | Change |
| --- | --- | --- | --- | --- |
| Delivery order: delegated deliveries and other items merged by request time, each in its own order; mailbox request time = earliest undelivered completion; re-decide the Phase 4 "manual Send delivers results first" rule | `4c8cb0445` | 0.1.10 | 1, S | **replaces** "delegated first" (4.2, 2.6) |
| A provider-switch Send now on a harness without interrupt-restart queues behind the turn | `0597532f1` | main | 2, S | new (2.5 step 2) |
| A send to an idle chat waits behind unheld queued items | `7a72fe301` | 0.1.10 | 2, S | new |
| Restart: never-started = no provider-turn observation on any attempt; unattended (agent-sent, scheduled) prompts are re-dispatched at most 3 times, never after a recorded Stop | `34204a39e` | 0.1.10 | 2 and recovery phase, S–M | **refines** 4.10 |
| Resume refused while workspace setup is pending or failed | `3209fa953` | 0.1.10 | 2, XS | new (N7, N9) |
| Test: Stop and send onto another instance records the handoff | `81fd06998` | main | 2, XS | new test |
| Live apply per adapter: Claude effort and flags, plus Codex `serviceTier` (through `thread/settings/update`, surviving a retried attempt); Claude `setModel` echo is not a wake | `8009cd8c3`, `ea6d3fc30`, `3eadb214e` | main, 0.1.10 | 3 provider item, S | **extends** 4.8 |
| A queued edit deletes the attachments it removed, skipping referenced files | `997b304dd` | 0.1.10 | 5, XS | new |
| N7 provider item for Cursor SDK: `resumeTurn` with `ResumeAction` (needs the SDK upgrade from 1.0.38) | `0b308312d` | 0.1.10 | provider, M | new |

Effect slot detachment and per-kind caps (`cbc38a1b0`, `20584babc`) are
unchanged upstream and stay the package 2 prerequisite.

### D.4 Provider polish

| Item | T3 | Rel. | Size | Change |
| --- | --- | --- | --- | --- |
| Claude: a turn with no provider output for 10 min after its prompt or a request fails non-retryably and is stopped | `943de8fe9` | main | S | joins the retry-deadline item |
| Claude startup and MCP-registration deadline with one fresh-session retry (90 s in T3) | `0072f66ec` | main | S–M, verify first | new |
| Claude tools denied or stopped by Stop show `interrupted` or `cancelled`, not `failed` | `7bc474667` | 0.1.10 | XS–S | new |
| Codex goal pauses while a delegated wake is pending | `1e438c8f8`, reinforced by `fa864bfca` | – | S | upgraded from "check" |
| Checks: Code Mode and dynamic host tools; full-access `approvalPolicy`; Claude elicitation `cancel`; OpenCode `question.reject` without a message; the Claude stderr-only session-missing signal | `467ec62e0`, `96290af4e`, `4aead9e6d`, `af8faa9cf`, `629d5083b` | 0.1.10 | XS each | new |
| Optional: Claude native session rename on chat rename | `6071022cb`, `f5c2ceb4d` | 0.1.10 | S | new, low |

### D.5 Fork, rollback and checkpoint polish

| Item | T3 | Rel. | Size | Change |
| --- | --- | --- | --- | --- |
| Native fork of a running Claude source behind a `canForkWhileSourceRunning`-style manifest flag, with T3's boundary rule | `2904c397a` | main | S–M | new |
| Message search excludes rolled-back turns | `48afc47e7` | 0.1.10 | S | new |
| Optional: Cursor SDK native rewind | `13ecf5b22` | main | M | new, optional |
| Checkpoint audit gains a sweep for orphaned refs of deleted conversations | `733a20008` | 0.1.10 | – | added to the audit |

### D.6 Restart and recovery

| Item | T3 | Rel. | Size | Change |
| --- | --- | --- | --- | --- |
| Crash continuation budget is cumulative across restarts (stop before the fourth), reset by a planned shutdown or a completed turn | `a68c367e4` | 0.1.10 | requirement | new |
| Unattended-prompt resend at restart (see D.3) | `34204a39e` | 0.1.10 | S | new |

### D.7 Agent tools

| Item | T3 | Rel. | Size | Change |
| --- | --- | --- | --- | --- |
| A replay that completes a partly applied agent command re-checks current ceilings | `1adc05b84` | 0.1.10 | XS | new |

## G. Changes to section E and to the Phase 5 decisions

### Section E (2026-11-14)

| Row | Change |
| --- | --- |
| Closed: "Delegation wait default 300 s → 240 s" | **Superseded.** T3 now uses a 30 s default and a 45 s maximum for task and thread waits (`5393882fb`). Record "30 s default, 45 s maximum, as T3". The 30 min maximum kept on 2026-11-14 is no longer T3's and has no invariant behind it |
| Kept: automatic stop escalation (G5) | Unchanged. T3 extended its manual Force stop to OpenCode (`6fa874e98`); Inertia keeps its automatic escalation under AGENTS.md |
| Kept: G12 eager snapshot and portable fallbacks | Unchanged. T3 extends native forks to a running Claude source (`2904c397a`, adopt in D.5). It now also rolls Cursor SDK back natively (`13ecf5b22`), so "portable rollback where T3 refuses" no longer applies to Cursor SDK. Record it as "Cursor SDK native rewind not adopted (optional)" |
| Kept: Phase 4 per-conversation mailbox | Confirmed. `e367ef0da`'s per-run wake bookkeeping is subsumed |
| Scope facts | `QueuedRunOrder.ts` is no longer byte-unchanged, and "delegated completions first" is replaced by the request-time merge (A1) |

### phase5-queue-design.md

| Section | Change |
| --- | --- |
| 4.2 Watcher order | Keep FIFO for watcher notes and user items, but delegated results no longer "stay first". Delegated deliveries merge with the other items by request time, as T3 `4c8cb0445` does. Migration 124's ordering index and package 1's order function change accordingly |
| 2.6 Automatic-result priority | Remove "then delegated results, then every other item by position" and use the merge above. The Phase 4 rule "any manual Send of a user item dispatches a waiting delegated delivery first" is **not T3's** (`queued-run.start` starts the selected item, `O:15295-15318`, unchanged since `b05c505b`). Either follow T3 or record it as a deliberate difference with a reason. No AGENTS.md invariant was found that forces it |
| 2.5 step 2 | A restart forced only by an instance switch, on a harness without interrupt-restart (Claude, Pi), queues behind the turn instead of stop-and-send, and is labelled as queued (`0597532f1`) |
| 4.6 Stop and send | Unchanged. `81fd06998` touches only T3's same-run restart, which Inertia never writes. Add the handoff test |
| 4.8 Configuration while running | Live apply is per adapter, no longer Claude-only: Codex `serviceTier` too (`8009cd8c3`, `ea6d3fc30`) |
| 4.10 and 2.9 Requeue after a restart | "Never started" is defined by provider-turn observations on any attempt. Unattended prompts are resent at most 3 times and never after a recorded Stop. Delegated deliveries and notifications are still never requeued (`34204a39e`) |
| N7 Resume | Pending missed-run images force a prompted start, so the empty-prompt continue is skipped. Resume is refused while workspace setup is pending or failed (`3209fa953`). Cursor SDK gains native resume upstream (`0b308312d`) |
| 5 Risks | "Effect worker starvation" is unchanged; slots are unchanged upstream |

## H. What could not be verified

- Nothing was executed in T3 or Inertia. Findings come from reading diffs
  and source. This was macOS reading only; Windows and Linux paths were not
  checked.
- Whether Inertia's renderer can issue a direct send to an idle chat while
  unheld queue items wait (`7a72fe301`). Only server paths were read.
- How `inertia_send_message` items are marked, so that a restart resend can
  tell them apart from user prompts (`34204a39e`).
- Whether the attachment GC keeps a refused or undelivered run's images long
  enough to re-attach them (`c2eb8f336`).
- Where a Claude startup or MCP-registration hang surfaces in Inertia's
  SDK-options path (`0072f66ec`). The Claude 10 min silence rule against
  long-running tool calls (`943de8fe9`) was not checked either.
- Whether Codex Code Mode wraps Inertia's dynamic host tools (`467ec62e0`).
- Whether a queued, not-yet-started Codex native child continuation keeps
  the continuation gate live (`910d4590d`).
- Whether OpenCode 2's `question.reject` without a message aborts a
  foreground subagent step.
- Cursor SDK 1.3.x: `ResumeAction` and `agent.rewind`, their store internals,
  licensing and packaging impact.
- A Claude native fork while the source transcript is being appended
  (`2904c397a`), against Inertia's physical-head check
  (`fork-session-service.ts:73-74`).
- Rollback message retention in every Inertia path (`48afc47e7`). This was
  inferred from `rolledBackTurnIds` and the absence of a rollback `DELETE`.
- Codex `6b9d90f12` and `4afa6f098`, MCP Apps, and Codex browser-access
  surfaces were not assessed.
- Rows marked `main` (about half of the adopt additions) are unreleased
  upstream. Check them first at the next re-pin.
