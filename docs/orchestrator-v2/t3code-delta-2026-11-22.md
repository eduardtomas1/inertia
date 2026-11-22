# T3 Code delta `b387e3a17` → `6f49071a3` against ORCHESTRATOR V2 (addendum)

Recorded 2026-11-22. This is an addendum to
[t3code-delta-2026-11-17.md](t3code-delta-2026-11-17.md), with the same format
and rule: T3 Code's current orchestrator is the reference. Inertia keeps a
deliberate difference only where an `AGENTS.md` invariant forces it or where
an architecture choice is recorded. Only changes that matter to Inertia are
kept. The scope is orchestration-v2, provider-core, client-runtime thread
execution, the orchestrator MCP service and the shipped providers (Codex,
Claude, Pi, Cursor SDK and OpenCode).

## Range and conventions

| Item | Value |
| --- | --- |
| Upstream start | `b387e3a179d7495321019363c5ba11e847834cd0`, 2026-11-17 20:37 UTC (the 2026-11-17 pin) |
| Upstream end | `6f49071a3`, 2026-11-22 08:52 UTC (`origin/main`) |
| Commits | 779, all first-parent. 167 changed files under `apps/server/src/orchestration-v2/` (+22,916 / −2,501) |
| Release boundary | `chore(release): prepare v0.1.11` (`de0466fd8`, 2026-11-20 07:38 UTC) is in the range; no tag in the clone. A row says `0.1.11` when its commit is an ancestor of `de0466fd8`, else `main` |
| Inertia comparison base | branch `orchestrator-v2` at `4de6624a3`, clean. It includes G11 part 2 / C6 and the work reserve (`3756b1b76`), the D.1 delegation follow-up (`e375dc1bc`) and checkout mobility for Claude, Pi and Cursor SDK (`4de6624a3`). Phase 5 is design only. "Missed-run images" is being implemented in parallel and is not on the branch |

### Conventions

- T3 anchors are `path:line` at `6f49071a3`. Abbreviations: `O` =
  `apps/server/src/orchestration-v2/Orchestrator.ts`, `PTS` =
  `apps/server/src/orchestration-v2/ProviderTurnStartService.ts`, `CP` =
  `CommandPolicy.ts`, `RES` = `RunExecutionService.ts`, `CA` =
  `Adapters/ClaudeAdapterV2.ts`, `XA` = `Adapters/CodexAdapterV2.ts`, `M` =
  `apps/server/src/mcp/OrchestratorMcpService.ts`, `C` =
  `packages/contracts/src/orchestrationV2.ts`, `SP` =
  `packages/provider-core/src/server/subagentProjection.ts`, `TE` =
  `packages/client-runtime/src/state/threadExecution.ts`.
- Inertia anchors are `path:line` in the `orchestrator-v2` worktree at
  `4de6624a3`. `P5` = `docs/orchestrator-v2/phase5-queue-design.md`, `IP` =
  `docs/orchestrator-v2/implementation-progress.md`.
- Method:
  - Triage: `git log b387e3a17..6f49071a3` restricted to orchestration-v2,
    provider-core, the provider directories, contracts, client-runtime and
    `apps/server/src/mcp` gave 322 commits. Every title was triaged; about 110
    diffs (non-test files) were read.
  - Two slices: (1) queue, steering, Stop, Resume, runs, checkpoints, handoff,
    sessions and forks; (2) delegation, MCP and shipped providers.
  - Each kept row was checked against the diff and against the source at
    `6f49071a3`, and against Inertia's source. Nothing was executed.
- Status vocabulary as before: **satisfied**, **satisfied in kind**,
  **satisfied by construction**, **partial**, **not satisfied (adopt)**,
  **conflicts** (with a named deliberate difference), **assigned**, **n/a**,
  **not assessed**. Sizes: XS / S / M / L.

### Scope facts

- Byte-unchanged in the range: `QueuedRunOrder.ts` (so A1 of 11-17 stands),
  `ContextHandoffService.ts`, `AttachmentClaims.ts`, `EventStore.ts`,
  `CommandReceiptStore.ts`, `ProviderSessionTransitionPolicy.ts`,
  `DispatchModeLimit.ts`.
- `ContextHandoffDelivery.ts` changed only in `c5fa33b27` (it now returns the
  inline handoffs it sent). `handoffBudget.ts` changed only in `b0b2c4f95`
  (the agent-sender note in history); the work-reserve formula is unchanged.
- `EffectWorker.ts` changed by one line each in `90f0bac19` and `87707319c`;
  slots are unchanged.
- New contract fields: `promptDropped` on provider turns with
  `isDeliveredProviderTurn` (`C:1337-1346`, `c5fa33b27`);
  `supportsNativeResume` on turn capabilities (`C:305`, `78d74598d`);
  `followsThreadSelection` now covers any queued message that names no model
  (`08804b217`); typed run output (`2770bf3c6`). `canForkWhileSourceRunning`
  is now true for Codex as well as Claude (`XA:281`, `23c339e8b`).
- **"Accepted provider turn" changed meaning.** Wherever T3 asked "did a
  provider turn accept this attempt", it now asks "did a *delivered* provider
  turn accept it": a Cursor SDK turn that failed or was cancelled before its
  first checkpoint is `promptDropped` and does not count (`c5fa33b27`). This
  touches missed runs, `nativeSessionMissesKeptTurns`, import detection, the
  Codex encrypted-history check and `unsentManualContinuationSource`.

## A. Queue, steering, Stop and Resume (Phase 5)

### A1. Steers that miss their turn: requeue in place (`e8c4824b7` + `90f0bac19`)

Two commits make one rule. At run end, every steer that is still pending was
never read by the provider (a read steer is marked completed, one dropped by
Stop is cancelled). It is requeued **in its place among the waiting messages**,
behind only the runs queued before its first steer effect, and a send that
beats the run-end reaction places the ended run's unread steers first
(`requeueUnreadSteers`, `O:3494`; `O:7906`). `90f0bac19` extends the same
placement from declined steers (`steerDeclined`) to steers whose turn simply
ended before delivery (`O:8079-8102`, `EffectWorker.ts:393`), and releases
held items it bumps when a user's client send releases the hold
(`O:8236-8244`).

On the Claude side (`e8c4824b7`): steers are offered with priority `next`; a
`completed` result that arrives while Claude still holds an unread steer keeps
the turn open (`heldResult`, `CA:12308`); a steer that Claude cancels,
discards or refuses before reading stays pending and is sent as the next turn,
with its PDF budget refunded (`CA:9507`); a steer whose process exited stays
pending too. Recovery leaves an unread steer pending.

Inertia today:

- Claude: a dropped accepted follow-up **fails the whole turn** ("Claude
  cancelled an accepted follow-up before returning an answer",
  `src/server/provider/claude-agent-sdk-harness.ts:579-590`), and an exit with
  pending follow-ups throws (`:753-756`). The follow-up is lost.
- Phase 5 already decided that `refused` and `turn-ended` release a queue item
  at its own position and that a declined composer steer goes after the items
  queued before it (`P5:417`, `P5:699`, N2 at `P5:1097`). It does not cover
  an *accepted* steer the provider later dropped unread.

**Not satisfied (adopt).** Two parts:

- D.4, S: the Claude harness reports a dropped or unread follow-up as a new
  steer outcome (for example `dropped`) instead of failing the turn, and holds
  a completed result while an unread follow-up is pending (it partly does,
  `:626-645`).
- Phase 5 package 2, S: an accepted-then-dropped steer is requeued at its N2
  place; a composer steer that hit `turn-ended` gets the same placement as a
  declined one; held items it bumps are released only when a client send
  releases the hold. Acceptance rows for both Claude endings.

### A2. Queue, steering and Resume rows

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `c38537754` (#40316) | main | A message that is only a slash command (no attachments, `^/[\w:-]+(\s\|$)`, `packages/shared/src/composerTrigger.ts:141`) never steers. An automatic send queues behind the turn (`resolveMessageDispatch`, `CP:105`); an explicit steer is refused: "Commands must run as a separate turn. Queue it or wait for the active turn to finish." (`O:6353`); a promoted one only moves first; an edit that turns a deferred steer into a command drops `steerWhenReady` | Inertia's own `/plan`, `/build`, `/goal`, `/compact`, `/resume` are composer actions, not text (`src/renderer/src/components/composer/ComposerInputZone.tsx:197`). Provider-native commands typed as text (for example a Claude `/context`) are steered like any follow-up (`src/server/runtime/commands/message-follow-up-command.ts:133`) | **Not satisfied (adopt).** Phase 5 package 2, XS. Can land earlier in today's follow-up path (refuse or queue a command-only follow-up). Check it does not catch Inertia's composer actions |
| `08804b217` (#40373) | main | Any queued message that names no model (not only scheduled deliveries) gets `followsThreadSelection` and runs on the thread's pick when it starts. A steer follow-up keeps its run's selection unless its message follows the thread (`O:7922`, `O:3597`) | `P5:316-317`: an item without a selection is "resolved from the queue tail at enqueue"; `follow-current` is for automatic kinds only | **Assigned, changes P5 2.2.** Package 3, XS: an item that names no selection follows the chat's selection at start instead of copying the tail at enqueue |
| `0a159c9fb` (#39417) | 0.1.11 | An agent's automatic send (`deliveryIntent: auto`, `createdBy: agent`) that would steer or restart queues instead while an unheld agent message is queued (for example behind `/compact`), so the agent's messages stay in send order (`O:7514`) | Agent sends never queue: a running target is steered or the send fails (`src/server/runtime/agent-thread-manager.ts:1069-1098`) | **Satisfied by construction today.** Package 2 acceptance row, XS, once agent sends become queue items |
| `f69b3a27a` (#38831) | 0.1.11 | A steer or restart command whose receipt exists replays even after its target turn ended, instead of failing with "no steerable run" (`ThreadManagementService.ts:924`) | G5 looks the receipt up before any target check (`src/server/orchestration-v2/command-authority.ts:79-86`); the steer path takes its ticket first (`message-follow-up-command.ts:133`) | **Satisfied in kind.** Whether the follow-up admission lease is taken before the receipt lookup was not checked; package 2 replay test, XS |
| `78d74598d` (#39229) | 0.1.11 | New capability `supportsNativeResume` (`C:305`): Codex, Claude, Cursor SDK and OpenCode `true`, Pi `false`. Resume is hidden on a provider without native resume unless the stopped run's message never reached the provider (`unsentManualContinuationSource`, `TE:364`; `packages/shared/src/orchestrationV2ManualContinuation.ts`) | No Resume. N7 says "until a harness has it, Resume releases and starts" (`P5:1102`) | **Assigned, changes N7.** Package 2/5, XS: a manifest capability per harness; hide Resume where it is false unless the stopped item's message was never accepted. Pi stays without Resume |
| `245c57980` (#38847) | 0.1.11 | A Resume that must be prompted (pending history or missed images) sends "Continue where you left off." as its request text (`RESUME_PROMPT`, `PTS:224`, used at `PTS:2097-2102`) | No Resume | **Assigned (N7).** XS acceptance row; it pairs with the missed-run images rule (C1) |
| `11224f63d`, `245a1ead9`, `73e647254` | mixed | Client resends over a dropped WebSocket, compatibility with older servers, snapshot reload after a replay defect | Renderer talks to main over Electron IPC | **N/a** |

## B. Runs, checkpoints and recovery

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `61085457d` (#29196), `28b413fe1` (#40411) | 0.1.11, main | Repeated post-turn capture timeouts no longer delay turn starts: after a timeout streak the baseline gets a short budget and the probe moves to post-turn captures (`CheckpointService.ts:396`, `:410`). Threads that share a folder queue on its lock; one that waited out another's timeout skips instead of timing out again (`:664`) | Turn start awaits the pre-capture, which waits on the conversation's previous artifact barrier (`src/server/runtime/turns/turn-controller.ts:795-799`, `turn-artifact-sequencer.ts:40-44`). Git calls are bounded at 20 s (`src/server/checkpoints.ts:82`, `:414`, `:514`), with no streak memory and no cross-conversation rule | **Not satisfied (adopt), verify first.** D.5 checkpoint audit, S. Measure how many 20 s Git calls a timing-out folder adds to each turn start, then add T3's streak rule. Whether two Inertia chats on one checkout contend on the index lock was not assessed |
| `6f49071a3` (#40745) | main | A failed (`error`) checkpoint capture still allows Edit from here as a conversation-only rewind (`CheckpointRollbackService.ts:181`, `O:14537`) | Conversation rollback never depends on a checkpoint; only the file restore is refused (`src/server/runtime/rollback-file-restore.ts:63-75`, `history-rollback-service.ts:45-63`) | **Satisfied by construction** |
| `a8b57b07e` (#31874) | 0.1.11 | A parent can revert files after its native children completed; runless children are judged from the parent's task record (`CheckpointRestoreSafety.ts:135`) | Observed native children settle at the parent's turn end (`src/server/runtime/turns/turn-settlement-coordinator.ts:140-147`) | **Satisfied by construction.** Not traced through every rollback refusal |
| `87707319c` (#40170) | main | An unexpected provider runtime exit records the background work it killed on the run that started it and wakes that run, like restart recovery (`ProviderSessionManager.ts:1224`, `RestartBackgroundNote.ts`) | Work does not outlive a turn; a provider exit fails the open turn. After an Inertia restart the next turn gets the runtime-interruption note listing lost tasks (`src/server/runtime/turns/turn-runtime-interruption-note.ts:4-9`) | **Satisfied in kind.** Automatic wake belongs to D.6 |
| `97e7834f4`, `693e8c7db`, `426b5a688` | main | A released session ends its tool-call nodes; released sessions leave the heap; an adapter whose scope closes is not mistaken for this fiber's own interrupt (`RES`) | Every turn end settles activities and live subagents (`turn-settlement-coordinator.ts:120-147`); one harness per run | **Satisfied by construction** / n/a |
| `5ce1bd5e1` (#28029) | 0.1.11 | A launch on a full disk retries until the run leaves `preparing` (`ThreadLaunchService.ts:1244`) | Admission and failure settle in one SQLite transaction; core safety fixes retry a locked database (`2de569047`) | **Satisfied in kind.** Full-disk (`SQLITE_FULL`) behaviour not assessed |
| `975b9577a`, `66235c7f2`, `455a60aa3` | 0.1.11 | `/clear` (fresh context) edge cases: a fresh run supersedes a pending fork transfer and a side-chat digest; messages after a fresh start never return to a pre-clear session that background work woke (`O`, `PTS`) | Fresh-context runs are dormant (Phase 5 N6) | **N/a.** Carry the three rules into N6 |
| `cdeacd547`, `33d48867f`, `016cfad01`, `94245bc8e`, `800b0748b`, `2bba2564c`, `2fe74b00f`, `c7ce74fce`, `db51b6719`, `ff4197c48` | mixed | Read and write performance; `cdeacd547` restructures the missed-image cutoff without changing it | – | **N/a** |

## C. Context handoff, sessions, forks

### C1. Flag for the "missed-run images" work (`c2eb8f336` / `33892dcc7`), now landed

The rule changed once in the range, in `c5fa33b27` (main), plus one Resume
detail. Everything else that touched the area (`cdeacd547`) is a refactor.

1. **"Accepted" now means "delivered".** `deliveredAttemptIds` keeps only
   provider turns without `promptDropped` (`PTS:1093-1095`). A run whose only
   provider turn dropped its prompt is a missed run, and its images ride on
   the next prompt.
2. **Cancelled runs can be missed runs.** `missedRuns` is now `failed`,
   `interrupted`, **or `cancelled` with a dropped prompt on its active
   attempt**, and no delivered turn (`PTS:1167-1175`). Before, cancelled runs
   never counted.
3. The cutoff ("a later run's prompt was accepted") uses the same delivered
   set, so a later run whose prompt was dropped does not end the carry
   (`PTS:1243-1256`).
4. A prompted Resume with only missed images sends "Continue where you left
   off." (`245c57980`, see A2).

Today only the Cursor SDK adapter sets `promptDropped` (no checkpoint saved
for the run, `packages/provider-cursor/src/server/adapter.ts:2596-2604`).
For Inertia's implementation: define "accepted" through one predicate, so a
Cursor SDK "dropped prompt" signal (C2 row `c5fa33b27`) can plug in later, and
decide whether a cancelled run whose prompt never reached the provider
re-offers its images. No other commit in the range changes which attachments
ride, how compaction or goal starts treat them, or attachment GC
(`AttachmentClaims.ts` is unchanged).

### C2. Handoff and sessions

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `c5fa33b27` (#40670) | main | When a Cursor SDK turn fails or is cancelled before Cursor saves its first checkpoint, the provider turn is `promptDropped` (`provider-cursor/src/server/adapter.ts:2596-2611`). The inline handoffs sent with that prompt are restored to pending at the terminal (a retry handoff becomes `superseded`) (`loadDroppedInlineHandoffs`, `PTS:2225`; `RES:763`, `:1316`). The run counts as not delivered everywhere (see Scope facts and C1) | An inline handoff becomes `delivered`, and its items are credited, on the first provider output (`src/server/orchestration-v2/backing-repository.ts:277-287`, `:383-391`). The failed turn's user message is credited unless the harness declares `turn-acceptance`, which only Codex does (`:368-391`; `src/server/provider/capability-manifest.ts:300`). A Cursor SDK failure with no output is conservative: the handoff goes `uncertain` and the backing is not credited | **Partial (adopt).** D.4, S. The Cursor SDK harness reports "no checkpoint for this run" (Inertia owns the agent store, `src/server/provider/cursor-sdk-store-records.ts:153-164`), and settlement then treats the turn as undelivered: abandon the handoff, restore the backing, credit nothing. Add a portable fixture (output streamed, then failure before the first checkpoint). Whether Cursor SDK 1.0.38 can stream before checkpointing was not verified |
| `e7b61491a` (#39281) | 0.1.11 | A handoff targeted at a failed, interrupted or cancelled run is no longer carried to later fresh sessions once its delivery settled (`injected` or `inline`) and its source threads still exist; a fresh session starts from a full summary instead (`PTS:561-575`) | One handoff per run, prepared from the target backing's coverage; nothing carries a failed run's handoff forward; a fresh session gets one full portable restore (`src/server/runtime/turns/turn-request-preparation.ts:612-646`) | **Satisfied by construction** |
| `d32df2d34` (#27517) | 0.1.11 | When a replacement session (rejected resume, or an unverifiable session before a handoff) comes back with the **same** native id, the start fails honestly ("the provider returned its existing session when asked for a fresh one…", `PTS:1748`), is never retried, and the load is forgotten so the next turn fails the same way. The replacement is written only while the run is still current | G9 starts a fresh session through the harness (`src/server/runtime/turns/turn-fresh-session-fallback.ts:69-125`). If the harness reported the rejected id again, `observe` refuses the retired backing silently (`backing-repository.ts:213-214`); the restored history would already be in a session that holds the old history | **Not satisfied (adopt), defensive.** D.4, XS–S: after a G9 restart, a reported session id equal to the rejected one fails the turn with an honest error and keeps the session retired. No shipped harness is known to do it (Claude assigns a new id, Codex `thread/start` returns a new thread) |
| `2c4622efb` (#38575) | 0.1.11 | An imported conversation that still has its native session gets no legacy-import handoff on its first message (`O:8474`; `importedNativeSession`, `PTS:1619`). Claude refuses to open a missing imported session instead of creating an empty one under its id (`CA:14489`); the failed resume then falls back to a fresh session with a full summary that carries the import | First message: a resumed session without a backing gets no restored history (`turn-request-preparation.ts:625-640`, `deltaTarget` null). Missing session: Inertia fails closed with "The original … session for this imported chat is no longer available" (`turn-fresh-session-fallback.ts:15-22`, `:41-48`) | **Satisfied by construction** for the first message. **Conflicts** for the missing session with the recorded difference "Imported Claude sessions may start fresh after a refusal only with evidence" (`IP:4160-4170`, `IP:4235-4238`). T3 now recovers explicitly through the full summary; the Inertia rule has no AGENTS.md invariant behind it. Re-decide (keep, or follow T3), XS to decide |
| `b99333dc7` (#36643) | main | After a Codex turn fails with `invalid_encrypted_content` on the current native thread, the next turn retires that thread and starts fresh with a full summary (`rejected_native_history`), refusing while background work is pending (`PTS:1547-1600`). User message: "Codex could not verify this session's encrypted conversation history. Send another message to continue in a fresh session…" (`apps/server/src/provider/CodexManagedErrors.ts:37`) | No `invalid_encrypted_content` handling in `src/server`. The two-strike rule starts fresh only after two failed turns on the saved session (`src/server/persistence/turn-ledger-repository.ts:400-430`, `turn-request-preparation.ts:449-457`) | **Not satisfied (adopt).** D.4, S: classify the Codex error code, retire the backing (reason such as `native-history-rejected`), start the next turn fresh with the full portable history, refuse while background work is pending, and show T3's message. Codex portable fixture |
| `b0b2c4f95` (#39306) | 0.1.11 | User messages an agent sent read as the agent's in handoff history (`handoffBudget.ts:141`) | See section D | Tracked in D |

### C3. Forks

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `23c339e8b` (#29239) | 0.1.11 | Codex can fork natively while a later source run is active (`canForkWhileSourceRunning`, `XA:281`), but only from a source turn with a native turn id when the provider keys forks on turn ids, and only from a `completed` or `waiting` source run (`canForkBusySourceNatively`, `CP:161`; `PTS`, native fork transfer) | A busy source always falls back to portable (`src/server/runtime/fork-session-service.ts:52-56`). The boundary already needs a settled native turn id (`:39-43`) | **Assigned (D.5).** Extends the 11-17 item for `2904c397a` from Claude to Codex. Size stays S–M; the Codex part reuses the existing turn-id boundary |

## C4. Providers (shipped)

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `554be2c61` (#38581) | 0.1.11 | In Full access (`bypassPermissions`), a Bash request that Claude Code's removal safety check raises is **denied**, with guidance not to work around it, when no ask rule matched. The match now also covers the reworded "dangerous removal" text (`CA:12719-12733`). The base rule (`^Dangerous rm`, the two `shell -c` texts) predates the range (present at `70f475f51`, 2026-11-01), so earlier surveys missed it | The permission broker **allows every `canUseTool` request in Full access** outside plan mode (`src/server/provider/claude-permission-broker.ts:119-122`). A removal that Claude Code's own check sends for approval runs without asking | **Not satisfied (adopt). Safety gap, not assessed before.** D.4 first, S. Before the Full-access allow, deny Bash requests whose `decisionReason` matches T3's patterns when no ask rule matched, with T3's message (AGENTS.md: protect the working tree). A fixture per pattern. Not run: whether the bundled Claude Code calls `canUseTool` for this check in bypass mode |
| `4ecbe5508` (#38334) | 0.1.11 | When Pi restarts a content block mid-stream (`text_start` or `thinking_start` on an open index), the abandoned text is dropped and the completed block replaces it (`packages/provider-pi/src/server/adapter.ts:2336`) | Pi deltas only append, and `text_start`/`thinking_start` are ignored (`src/server/provider/pi-events.ts:47-50`); a restarted block shows its text twice | **Not satisfied (adopt).** D.4, S. Track text per content index and republish with `textSnapshot` (`src/server/provider/agent-harness.ts:434`), reasoning too. Pi portable fixture |
| `0b02be3d5` (#40265) | main | Claude's reply that ended the native turn before a late-read steer is published as completed, phase `final_answer` (`CA:12306-12320`) | On a result while a follow-up is pending, Inertia resets turn output after a text boundary; earlier text stays (`claude-agent-sdk-harness.ts:626-645`) | **Satisfied in kind.** XS fixture, together with A1 |
| `ae268d935` (#39299) | 0.1.11 | A Claude CLI that exits before the turn attaches reports its exit status; EPERM or "Operation not permitted" adds macOS privacy guidance (`CA:795`, `packages/provider-core/src/server/failure.ts:77`); stderr goes to the log | The stderr tail is the failure detail, and the root refusal is mapped (`src/server/provider/claude-startup-failure.ts`) | **Satisfied in kind.** Optional XS: EPERM/TCC guidance for Claude and Codex startup exits |
| `767f194fd` (#37442) | 0.1.11 | Codex's native thread name follows renames (`thread/name/set` before each turn and on rename, 10 s timeout, retried next turn; `XA:2256`, `:8357`) | No `thread/name/set` in `src/server/codex` | **Not satisfied**, optional, S. Joins the low-priority native-rename row (`6071022cb`), now Claude and Codex |
| `4fccab84a` (#39086) | 0.1.11 | Codex text generation also disables the legacy `features.connectors` key (`apps/server/src/textGeneration/CodexTextGeneration.ts:46`) | Title generation disables `features.apps` and `features.plugins`, not `features.connectors` (`src/server/codex/thread-title.ts:34-48`) | **Partial (adopt).** XS: add `features.connectors` there and in `read-only-thread-config.ts` |
| `c688453ac` (#40075) | main | Truncated Claude request summaries, API errors and web-fetch snippets never end on a lone high surrogate (`CA:4233`) | Several Claude bounded-text helpers slice by code unit, for example `boundedSubagentText` (`src/server/provider/subagent-trace.ts:66-73`); Pi already guards (`pi-events.ts:28-31`) | **Partial (adopt).** XS: shared surrogate-safe truncation |
| `47583f868` (#25935) | 0.1.11 | A resumed Codex thread with an active goal is registered as the root before the response, so auto-resumed goal turns are owned (`XA:8140`) | Each run owns its app-server events; goal continuation inside a run is tracked (`src/server/codex/app-server-events.ts:126-148`) | **Satisfied by construction**, no fixture. XS check |
| `29af131f0`, `57e92b0b9`, `106a1e03b`, `b5453de6b` | mixed | Cursor SDK out of process; SDK now **1.4.2** with patches (`pnpm-workspace.yaml:114`); Max Mode from the catalog; account models; background shells outlive the turn (`provider-cursor/src/server/adapter.ts:1181`) | Per-run worker already (`src/server/provider/cursor-sdk-worker.ts`). `@cursor/sdk` pinned at `1.0.38` (`package.json:302`). Work ends with the turn | **Satisfied in kind** (out of process). **Assigned** to the Cursor SDK upgrade item, gap now 1.0.38 → 1.4.2. Background shells **n/a** |
| `ed203c46c`, `2ebe7f8e2`, `f2d4df036`, `6b73ca9e4`, `b6d6717df`, `7da0a166e` | mixed | Cursor runtime instructions once per agent; Pi fork from a sibling session; Codex web search query once; pid reuse; Pi teardown on ESRCH; bounded probe output | No Cursor SDK instructions; `pi --fork` keeps entry ids with a portable fallback (`src/server/provider/pi-native-conversation.ts:51-62`); one query label (`src/server/codex/app-server-item-labels.ts:36-41`); recycled-pid guards and group waits (`src/server/process-lifecycle.ts:793-910`); bounded probes | **Satisfied** in kind or by construction |
| `06eda8e36`, `e3294d766`, `cb129ba2c`, `447c0129c`, `0c6d0ee86`, `34a7ab364`, `047c4d759`, `c53ac237a`, `6dc7fdc8e`, `09b79941a`, `5478e44cc`, `32f93dab3`, `90aa7669a`, `76bd3bb09`, `39480b5c8`, `4d5bf2d55`, `da5bf9630`, `e26a76af8`, `52f0f8afb`, `9c25b7139` | mixed | Port-scanner env, gateway cooldown, Background work details, MCP Apps context, Pi aliases and extensions, OpenCode subscription recovery, user launch args, shadow homes, compatibility lookups, catalogs, Cursor text generation and history, OpenCode usage reasons | No port scanner, cooldown, MCP Apps or user launch args; third-party Pi extensions off (`src/server/provider/pi-launch.ts:70-76`); one OpenCode subscription per run; catalogs in backend profiles | **N/a**, or UI and catalog only |

## D. Delegation and background work

| Commit | Rel. | T3 rule and anchors | Inertia | Status and action |
| --- | --- | --- | --- | --- |
| `c440fd19d` (#37859) | main | The provider's stop reason is appended to **every** delegated result, not only a textless one (`withStopNotice`, `SP:227`); a Codex hook stop that ends `interrupted` counts too (`run_interrupt_result`, `SP:206-225`) | Deferred to D.4 on 2026-11-17 (`IP:3603-3620`): the Codex projection drops `stop` entries | **Assigned** (D.4 row for `c02b98bb3`); scope grows to results with text and both Codex endings. Still S |
| `b0b2c4f95` (#39306) | 0.1.11 | `withMessageSenderNote` (`C:624`) prefixes messages that an agent, a scheduled task or a T3 tool sent: "[T3 Code: the agent in T3 thread "…" sent this message, not the user.]". Leading slash commands and `$skill` mentions are left as sent. Applied at turn start (`PTS:997`), on steers (`ProviderTurnControlService.ts:467`) and in handoff history (`handoffBudget.ts:141`) | Delegated first prompts and managed-chat sends and steers go raw (`src/server/runtime/agent-thread-manager.ts:1008-1011`, `:1082`, `:1122-1126`); portable history renders them as the user's. Results and watcher notes already carry provenance (`src/server/runtime/delegation/delivery-instruction.ts:11`) | **Not satisfied (adopt).** D.1, S. Prefix agent-originated user turns at start and steer and in portable history; keep leading commands verbatim; portable fixture per harness |
| `83edd5e72` (#40633), `63fa4c892` (#40604) | main | A `t3_thread_wait` that times out on an app-owned task's child returns `next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT` ("the task will wake you") so the parent stops polling, also for the first run and while a non-live question is pending (`M:3718-3752`) | `inertia_wait_for_conversation` timeouts return only status and `timedOut` (`src/server/runtime/agent-thread-wait.ts:151-162`); `inertia_wait_for_task` arms the wake (`src/server/runtime/delegation/task-service.ts:189-195`) | **Partial (adopt).** D.1, XS |
| `5533151d7` (#39297) | 0.1.11 | A delegated-completion wake names the child thread; a follow-up ties back to the original task (`O:971`) | Header `Delegated task ${taskId} (${title}) [${status}]:` (`src/server/orchestration-v2/delegation-text.ts:76-78`) | **Not satisfied (adopt).** D.1, XS |
| `d4d54658f` (#37225) | main | A failed child finalization retries with backoff (1 s → 30 s, up to 1 h) and re-offers the wake first (`O:987`, `:2159`, `:16523`) | Finalization and wake offer run synchronously in one lane (`task-service.ts:196-198`); locked-database settlement retries (`2de569047`) | **Satisfied in kind.** XS check: an `offer` that throws after the result commit is offered again on the next drain |
| `be9176761` (#39528) | 0.1.11 | Claude `activeSteeringInterruptsTools: false` (`CA:577`), so a delegated completion is steered into a running Claude turn (`O:7756`) | Already steered into running Codex, Claude and OpenCode turns (`src/server/runtime/queued-message-runtime.ts:551-575`) | **Satisfied.** T3 now matches Inertia |
| `da54e47f2` (#36499) | 0.1.11 | A launch or delegation whose command committed starts even if the caller goes away (`M:2922`) | An abort after child creation throws "the child remains visible but was not dispatched" (`agent-thread-manager.ts:1003-1007`); nothing is stranded | **Satisfied in kind** (honest refusal). D.7, XS: follow T3 or record the difference |
| `5b6f7c81c` (#38436) | 0.1.11 | `delegate_task.target` accepts the object as JSON text (`packages/contracts/src/orchestratorMcp.ts:175`) | `route` and `workspace` are strict objects (`src/server/runtime/agent-thread-schemas.ts:23-32`) | **Not satisfied (adopt).** D.7, XS |
| `2770bf3c6` (#38874), `1f8f3698b` (#40137) | main | New feature: a thread turn can declare `outputSchema`; `t3_submit_output` stores a validated result; `t3_thread_wait untilOutput` waits for it (`apps/server/src/orchestration-v2/runOutput.ts`, `PTS:1012-1014`) | No typed turn result | **Not adopted (new feature).** Optional D.7, M |
| `3a60d0996`, `ec275c7a1`, `9cc4018c7`, `316c3256a` | 0.1.11, main | Background subagents delegate after their parent's run; compaction of a child starts no follow-up task; idle compaction ignores app-owned tasks; a resumed Claude subagent keeps its earlier result | Work does not outlive a turn (`src/server/provider/claude-delegate-lifecycle.ts:84-97`); follow-ups only through the follow-up tool (`delegation-repository.ts:511-517`); idle compaction never looks at tasks (`src/server/runtime/idle-compaction-scheduler.ts:144-152`); a terminal task ignores a later `task_started` (`src/server/provider/claude-subagent-trace.ts:427-428`) | **Satisfied by construction** (`316c3256a`: satisfied; the resumed run itself is untraced, a pre-range gap, not assessed) |
| `f4b988aea` (#37266) | 0.1.11 | The restart note says how to resume a cut Claude subagent (`RestartBackgroundNote.ts:58`) | No crash-restart note | **N/a today.** D.6 |
| `c0b1d32c9`, `66b8a94f8`, `c80d450d2`, `c2a7c5cbc`, `44e3f42e6`, `6d6c4614a`, `3cd98dcba`, `66bc6145f`, `c4419dadd` | mixed | Per-folder provider models; read performance; paged subagent records; `request_secret` idempotency; a secret card closed after a same-run restart; Pi/OpenCode waits between turns | No per-folder catalogs; no `clientRequestId` on the secret tool; no same-run restart (P5 4.6); no work between turns | **N/a** |

## E. Triaged as not applicable

By title or diffstat, out of scope:

- Providers Inertia does not ship: Antigravity (about 45 commits, for example
  `3a9175743`, `0c921e1fd`, `cfd24da4a`, `e24f0c715`), ACP, Copilot, Hermes,
  fx, Grok, Kiro, Muse.
- Linked and remote environments, device hub, relay, port forwarding.
- Issue trackers, pull-request tools and watches, forges (`5d05902dd`,
  `f7041fabc`, `37f8a5325`, `7dceb76f4`).
- Scheduled tasks, projects with several repositories (`60863edc4`), thread
  naming, search, archive and side-chat UI.
- Document-format parsers (RTF, DOCX, ODT, PPTX, notebooks), i18n
  (`055b44919`), mobile and web UI, voice, Markdown rendering.
- Self-settle and auto-settle (`f03ce6869`, `6cbda0cd0`, `1c818a808`).
- Assistant citations length guard (`733bc8f1d`).

## F. Package plan changes

### D.1 Core and agent-facing safety (follow-up to `e375dc1bc`)

| Item | T3 | Rel. | Size |
| --- | --- | --- | --- |
| Agent-originated turns carry a sender line, live and in portable history; leading slash commands stay verbatim | `b0b2c4f95` | 0.1.11 | S |
| A managed wait that times out on a delegated child with an armed wake says "the task will wake you" | `83edd5e72`, `63fa4c892` | main | XS |
| The wake header names the child conversation, or the original task for a follow-up | `5533151d7` | 0.1.11 | XS |
| Check: a wake offer that throws after the result commit is re-offered | `d4d54658f` | main | XS |

### D.4 Provider polish — order changes

Put the safety item first. Then the items that lose user work. The 11-17
items keep their place behind these.

| Order | Item | T3 | Rel. | Size | Change |
| --- | --- | --- | --- | --- | --- |
| 1 | **Claude Full access denies removals that Claude Code's safety check raises** | `554be2c61` | 0.1.11 | S | **new, first** (working-tree safety) |
| 2 | Claude: a dropped or unread steer is a steer outcome, not a failed turn; a completed result is held while one is unread (the queue half is in Phase 5) | `e8c4824b7` | 0.1.11 | S | new |
| 3 | Codex `invalid_encrypted_content`: the next turn starts fresh with the full portable history; refused while background work is pending | `b99333dc7` | main | S | new |
| 4 | Cursor SDK: a turn that ends before its first checkpoint is undelivered (handoff abandoned, backing restored, nothing credited) | `c5fa33b27` | main | S | new |
| 5 | G9: a replacement session that reports the rejected id fails honestly and stays retired | `d32df2d34` | 0.1.11 | XS–S | new, defensive |
| 6 | Pi: a block restarted mid-stream replaces its text | `4ecbe5508` | 0.1.11 | S | new |
| – | Delegated result carries the provider stop reason on every result, both Codex endings | `c440fd19d` + `c02b98bb3` | main | S | **extends** the deferred row |
| – | XS: Codex `features.connectors` off; surrogate-safe Claude truncation; EPERM/TCC startup guidance; fixtures for `0b02be3d5` and `47583f868` | `4fccab84a`, `c688453ac`, `ae268d935`, `0b02be3d5`, `47583f868` | mixed | XS each | new |
| – | Optional native rename now covers Codex | `767f194fd` | 0.1.11 | S | **extends** |
| – | Cursor SDK upgrade target is 1.4.2 | `29af131f0`, `57e92b0b9`, `106a1e03b` | mixed | M with `0b308312d` | **extends** |

### G9 follow-up: missed-run images (landed 2026-11-22)

Landed; see the progress entry "G9 follow-up: images of runs the provider never
received". "Missed" is one predicate (`delivery` is `not-delivered` or
`prompt-not-delivered`, on a failed or interrupted run), and a cancelled run
is passed over until Inertia can observe a dropped prompt.

| Item | T3 | Rel. | Size | Change |
| --- | --- | --- | --- | --- |
| "Accepted" is decided by one predicate (delivered turns only), so a dropped-prompt signal can plug in; decide whether a cancelled run whose prompt never reached the provider re-offers its images | `c5fa33b27` | main | XS | **amends** the rule (C1) |
| A prompted Resume with only missed images sends "Continue where you left off." | `245c57980` | 0.1.11 | XS | acceptance row, lands with N7 |

### D.5 Fork, rollback and checkpoint polish

| Item | T3 | Rel. | Size | Change |
| --- | --- | --- | --- | --- |
| Native fork of a busy source now Claude **and Codex** (Codex only from a native turn id, source run completed) | `23c339e8b` | 0.1.11 | S–M | **extends** the `2904c397a` item |
| Turn-start capture: streak rule for repeated timeouts and a skip for waiters on a shared folder, after measuring | `61085457d`, `28b413fe1` | 0.1.11, main | S | new, verify first |

### D.3 Phase 5 durable queues

| Item | T3 | Rel. | Package, size | Change |
| --- | --- | --- | --- | --- |
| Unread or dropped steers requeue at their N2 place; a `turn-ended` composer steer is placed like a declined one; bumped held items are released only by a releasing client send | `e8c4824b7`, `90f0bac19` | 0.1.11, main | 2, S | **extends** N2 |
| A command-only message never steers: auto queues, explicit steer refused, promote moves it first | `c38537754` | main | 2, XS | new |
| An item that names no selection follows the chat's selection at start | `08804b217` | main | 3, XS | **changes** 2.2 |
| An automatic agent send does not steer past a waiting agent item | `0a159c9fb` | 0.1.11 | 2, XS | new acceptance row |
| Steer receipt replay after the turn ended | `f69b3a27a` | 0.1.11 | 2, XS | test |
| N7: `native-resume` capability per harness; Resume hidden where false (Pi) unless the stopped item was never accepted; prompted Resume sends "Continue where you left off." | `78d74598d`, `245c57980` | 0.1.11 | 2 and 5, XS | **changes** N7 |
| N6 (dormant): three `/clear` rules carried | `975b9577a`, `66235c7f2`, `455a60aa3` | 0.1.11 | – | note |

### D.6 Restart and recovery

| Item | T3 | Rel. |
| --- | --- | --- |
| A provider runtime exit wakes the run whose background work it killed | `87707319c` | main |
| An unread steer stays pending through recovery and is requeued | `e8c4824b7` | 0.1.11 |
| Crash notes say how to resume a cut Claude subagent | `f4b988aea` | 0.1.11 |

### D.7 Agent tools

| Item | T3 | Rel. | Size |
| --- | --- | --- | --- |
| `route` and `workspace` accept a JSON-stringified object | `5b6f7c81c` | 0.1.11 | XS |
| Decide: start (T3) or refuse (Inertia) a delegation whose caller aborted after child creation | `da54e47f2` | 0.1.11 | XS |
| Optional: typed turn result | `2770bf3c6`, `1f8f3698b` | main | M |

### Order

The in-flight missed-run images package should take C1 before its fixtures
are written. Of everything else, D.4 items 1–3 come first: one is a safety gap
and two lose user work today. Phase 5 order is unchanged; the new rows join
package 2.

## G. Changes to earlier statuses and decisions

| Where | Change |
| --- | --- |
| 11-17 C1 point 3 and the "G9 follow-up" row | Amended by `c5fa33b27`: "no accepted attempt" means no *delivered* provider turn, and cancelled runs with a dropped prompt are missed runs (C1 here) |
| 11-17 C3 `2904c397a` (Claude only) | Codex joins (`23c339e8b`) |
| 11-17 D `c02b98bb3` (textless results only) | Every result (`c440fd19d`) |
| Recorded difference "Imported Claude sessions may start fresh after a refusal only with evidence" (`IP:4235-4238`) | T3 now recovers a missing imported session through the full summary (`2c4622efb`). No invariant backs the Inertia rule; re-decide |
| P5 2.2 (`absent: resolved from the queue tail at enqueue`) | An item without a selection follows the chat's selection at start (`08804b217`) |
| P5 N2 | Also covers steers accepted and later dropped unread, and composer steers that hit `turn-ended` (`e8c4824b7`, `90f0bac19`) |
| P5 N7 | Resume is hidden on harnesses without native resume unless the stopped item was never accepted (`78d74598d`); a prompted Resume carries "Continue where you left off." (`245c57980`) |
| Earlier "Satisfied" rows | None invalidated. `85168744f`, `629d5083b`, `2e3313418`, `8cbaf7505`, `7d4f24237` were re-read against the new code and stand. The Claude Full-access removal rule (`554be2c61`) was never assessed before, not satisfied before |

## H. What could not be verified

- Nothing was executed in T3 or Inertia; macOS reading only. Windows and
  Linux paths were not checked.
- Whether the Claude Code version Inertia bundles calls `canUseTool` for its
  removal safety check in `bypassPermissions` (`554be2c61`).
- Whether Claude's command lifecycle reports `cancelled`/`discarded`/`refused`
  for an accepted streamed follow-up in the bundled SDK, and how often
  (`e8c4824b7`).
- Whether Cursor SDK 1.0.38 can stream output before its first checkpoint, and
  how to read "this run saved a checkpoint" from Inertia's store
  (`c5fa33b27`).
- The Codex error shape of `invalid_encrypted_content` in the App Server
  version Inertia ships (`b99333dc7`).
- Whether the follow-up admission lease is taken before G5's receipt lookup
  (`f69b3a27a`).
- How long a timing-out checkout delays Inertia turn starts, and whether two
  chats on one checkout contend (`61085457d`, `28b413fe1`).
- Whether Pi restarts content blocks mid-stream through any shipped provider
  (`4ecbe5508`); a Codex goal turn auto-started after `thread/resume`
  (`47583f868`); a wake offer that throws after the result commit
  (`d4d54658f`); every Claude truncation site (`c688453ac`).
- Cursor SDK 1.4.x behaviour, patches, licensing and packaging.
- `SQLITE_FULL` handling in Inertia admission (`5ce1bd5e1`).
- Rows marked `main` are unreleased upstream; check them first at the next
  re-pin.
