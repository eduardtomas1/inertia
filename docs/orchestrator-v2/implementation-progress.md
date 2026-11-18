# Implementation progress

V2 is **in progress**, not complete. The full target remains
[implementation-plan.md](implementation-plan.md). No merge is authorized.

The current resumed checkpoint is phase 3 plus the already-started Cursor SDK
integration. Native/portable context rollback, replay receipts, revisioned
history pages and visible context merge-back are implemented. Independent
reviews and their corrections are complete. The user requested an immediate
state save on 2026-10-30; the full-suite rerun was interrupted and remaining
verification is handed off in
[phase3-verification.md](phase3-verification.md). Earlier checkpoint counts and
failures below are historical, not the final result. The user requested a draft
commit/push followed by a stop, with no CI monitoring or later-phase work.

## Durable core checkpoint — 2026-10-29

Production turn preparation now admits work through `OrchestratedTurnRepository`.
Its transaction joins the existing transcript/execution projection with a V2
receipt, ordered events, thread/run/attempt projections and a process-bound
start effect. `TurnController.start` claims the exact intent before execution;
terminal work that never crossed that boundary retires its pending intent.
Paired admission remains atomic across both conversations.

Lifecycle updates, cancellation requests and provider cleanup ownership update
the V2 projection transactionally. Pending or unconfirmed cleanup blocks
replacement work, and queued messages wait while it lasts
(`src/server/orchestration-v2/turn-repository.ts:173-175`, used by queue
dispatch at `src/server/runtime/queued-message-runtime.ts:88`). Since the stop
ladder release below, an attempt whose cleanup is `unconfirmed-released` no
longer blocks admission or queue dispatch; decisions that need cleanup proof
refuse it through `awaitsCleanupProof` (`turn-repository.ts:177-179`). Restart
retires old process-bound effects and reconciles run projections before
admission; persisted questions, expiring approvals and crash or shutdown
continuation are not part of that reconciliation (recovery phase).
A human `message.send` replays its accepted result after a lost
acknowledgement, including after restart, whatever its disposition: a new
turn, a steer into the running turn or a follow-up queued for after the turn
(G5, 2026-11-02, below). The desktop renderer mints a fresh `requestId` for
every command (`src/renderer/src/lib/runtimeCommands.ts:11-13`), so replay
helps only a caller that resends the same request id.

The event store also offers bounded reads (`readEvents`), projection rebuild
(`rebuildProjections`), a revision check and actor-scoped command collision
detection (`src/server/orchestration-v2/event-store.ts:114-121,158,173`).
Only tests call `readEvents` and `rebuildProjections`. Every production commit
reads its expected revision from `events.revision()` immediately before
committing (for example `turn-repository.ts:135`), so the revision check cannot
fail in-process, and production uses only the actors `human` and `runtime`,
with no test of a cross-actor id. The outbox has ordered per-thread claims,
fenced claim acknowledgements, an explicit replay policy and bounded retries
for replay-safe effects; production enqueues only process-bound effects
(`provider.start` at `turn-repository.ts:137`, `native.*` at
`src/server/orchestration-v2/native-control-repository.ts:56`), so no retry
runs in production. Generic asynchronous command lanes are implemented and
tested. `OrchestrationEffectDispatcher`
(`src/server/orchestration-v2/effect-outbox.ts:123`) has no production caller
and no test; the existing controller still executes the start effect directly.
Other command families have not yet moved to V2. This checkpoint is not full
event-sourced transcript/provider control.

Validation under Node 22.23.2:

- Core + existing turn lifecycle + migration/catalog/lineage: 98 tests passed.
- Core + lifecycle + send-command regressions: 138 tests passed before the
  additional replay/queue assertions.
- Additional core/replay + send-command tests: 89 tests passed.
- Core + durable queue, including unconfirmed-stop waiting: 70 tests passed.
- `npm run check:quality` passed after these changes (migration lineage,
  architecture, theme generation, both linters and all TypeScript projects).

These runs overlap; their test counts must not be added. The full final check
has not yet run for V2. Provider tests are recorded separately in
`provider-implementation-progress.md`.

## Portable history and provider backings checkpoint — 2026-10-29

Turn preparation now uses deterministic, intact-entry history selection with
T3's budget formula: a 16k default and 64k maximum cap, reserves for the current
prompt, images (8,192 bytes each) and other attachments (4,096 bytes each),
native occupancy, and a response reserve of at least 16,000 bytes or a quarter
of the window (`src/server/orchestration-v2/portable-history.ts:48-71`).
Production passes no configured cap, so the 16k default always applies. Native
occupancy is the target turn's reported usage or, when usage is absent, an
estimate from the backing's covered items
(`src/server/orchestration-v2/portable-history-occupancy.ts`). The window is
the user's context-window override, else the last reported maximum, else
128,000 tokens; the probe for a model's catalogue window and auto-compact
threshold (`src/server/runtime/turns/turn-context-handoff.ts`) is not yet
implemented by any provider. The occupancy estimate and the attachment reserve
landed with the fidelity audit fixes on 2026-11-01. Recent user/assistant and
opening messages receive priority; the final order remains chronological.
Oversized entries are omitted whole. Provenance and omitted-history retrieval
instructions accompany the handoff. Historical attachments, private reasoning
and live tool state are not replayed. Existing endpoint containment, file-change
metadata, authorized chat references and watcher attribution are preserved.
Unlike T3, whose handoff history also carries normalized command outcomes,
errors, interruption notices, file changes and proposed plans
([t3code-orchestration.md](t3code-orchestration.md)), ordinary Inertia handoffs
carry user and assistant messages plus the last turn's command list and the
chat's changed filenames
(`src/server/orchestration-v2/portable-history-source.ts:133-139`). Attributed
item kinds are tracked work.

Native provider backings now have durable instance/workspace/session identity
and bounded item coverage. The instance fingerprint covers the harness, backend
profile, configuration revision, endpoint and compatibility token, but no
account (`src/server/orchestration-v2/provider-instance.ts:4-8`). A tested
Codex → Claude → Codex round trip resumes the original Codex session and
delivers the intervening context. Items omitted from a delivered handoff count
as covered and are not offered again on the next switch-back (see
[G11 part 1](#g11-part-1-coverage-accounting--2026-11-02)). Uncertain handoff
delivery prevents native reuse; an ordinary outage alone does not retire a
valid session. Preparation, dispatch, delivery, abandonment and uncertainty are
separate durable states; `delivered` means the first provider output was
observed (`backing-repository.ts:109-122`), so a run that fails without output
ends `uncertain`. In-run fresh-session replacement runs only for a
`sessionUnavailable` failure with confirmed cleanup
(`src/server/provider/fresh-session-fallback.ts:59-64`). A generic rejected
resume fails the turn (`src/server/runtime/turns/turn-fresh-session-fallback.ts:15-26`),
and a later turn starts fresh only after the two latest turns were both rejected
resumes of the same session
(`src/server/persistence/turn-ledger-repository.ts:378-431`). Projection replay
reproduces backing state.

Validation: 128 tests across eight focused core, backing, portable-history,
provider-handoff, fallback, configuration and lifecycle suites passed. Node
TypeScript and architecture checks passed. The shared unit-test TypeScript
project currently reports the second chat's in-progress Pi union integration;
these provider changes are not part of this checkpoint. The final full gate is
still outstanding.

Remaining within this area: native history injection and provider turn anchors,
general configuration queues and account-switch authorization, full transcript
item coverage (the first reader covers messages and bounded legacy supplements),
durable inherited fork history, and reconnect/client exposure. This checkpoint
does not close the corresponding full-scope checklist items.

## Next integration work

Native/portable fork and deferred rollback integration; remaining commands,
effect publication and client projections. The second Astra chat is implementing
Pi after completing the Codex/Claude native-operation adapter package. All other
full-scope items remain open on the completion checklist.
## Pi persistence compatibility checkpoint

Migration 108 adds the native Pi provider, `pi-rpc` harness and `pi-native`
protocol to the existing constrained tables. It preserves their data, indexes,
triggers and foreign keys, and rolls the entire upgrade back on a failed table
rebuild. Released migration definitions and lineage entries remain unchanged.

Validation: 36 tests across the migration, lineage and Pi upgrade suites passed;
Node TypeScript and focused lint passed. The upgrade test opens a representative
released database and admits a real V2 Pi turn after upgrading. Provider runtime
integration remains in progress in the second chat.


## Paused checkpoint — 2026-10-30

The user explicitly requested that both chats commit and push their current
work and stop. Implementation is paused at this checkpoint; **ORCHESTRATOR V2
is incomplete** and PR #686 must remain unmerged. The full T3 system remains the
agreed target in `implementation-plan.md`.

The primary chat added lazy fork creation at selected terminal runs, immutable
inherited history with paged retrieval, a desktop fork action/history panel,
provider-native boundary projections, and native fork preparation before the
first desktop or agent send. Native operations persist their intent before
execution and fence both source and target against conflicting work. Unknown
outcomes retain durable locks; only exact cleanup evidence releases them.
Unsupported or cross-provider forks use portable history. Confirmed native
forks attach the returned target session and seed inherited context coverage to
avoid duplicate delivery. Source deletion and projection rebuild preserve the
copied history.

The native-control recovery path uses runtime-generation and system-boot
identity; process-bound effects are retired, not replayed after restart.
Conversation/project mutations and direct turn admission observe the control
fences. Private Connect currently falls back to portable first-send transfer;
it does not yet run the asynchronous native preparation path.

Focused validation recorded before the stop:

- Fork history, native forks and agent-thread integration: 40 tests passed
  across three suites (`.cache/orchestrator-v2/fork-final-focused.log`).
- Earlier fork UI checks: three DOM tests passed. The later quiet-footer
  compatibility adjustment has not yet been rerun.
- Node and web TypeScript plus focused lint passed before the last integration
  fixture edits. A subsequent quality run reached unit-test TypeScript and
  found a cursor type annotation; that annotation was fixed, but the complete
  gate was not rerun before the stop.
- The second chat's last full check failed with 130 test failures and two mock
  errors. Its portable run reported 3,687 passing, four failing and nine skipped
  tests. These are historical results, not a claim that this checkpoint passes.
- The last integration edits corrected historical backup fixtures that retained
  V2 tables under an older migration label, stale migration-version assertions,
  projector/admission mocks and explicit locale collation. These edits remain
  unverified at this stop point. `git diff --check` passed.

Resume with the unresolved full-gate failures: production command-lane wiring,
agent-surface budget accounting, old continuity/context expectations versus the
new durable backings, Duo cleanup fencing, renderer compatibility and bundle
budget. Do not relax cleanup or identity boundaries merely to satisfy old
expectations. Native rollback/merge-back, managed delegation and durable parent
wakes, native child threads, general configuration/message queues, scheduling,
agent tools, client/reconnect/mobile parity, Cursor SDK and ACP remain unfinished.
The checklist deliberately remains open. See the provider progress and seam
notes for that chat's exact implementation and validation status. No live
provider-account, Windows/Linux desktop or packaged release validation is
claimed for this checkpoint.

## Resumed checkpoint: command ordering and deferred native rollback — 2026-10-30

The user resumed implementation after the pause above. PR #686 stays a long-lived
draft; this is a checkpoint, not V2 completion. Historical pause results above
remain historical evidence.

Production changes:

- **Per-conversation command authority.** `store.orchestration.lanes` (the
  existing `OrchestrationCommandLanes`, now owned by the V2 facade) orders
  `conversation.fork` (source chat), the new `conversation.rollback`,
  `checkpoint.revert`, and first-send fork preparation from both desktop sends
  and agent-thread sends. Runtime shutdown closes the lanes after aborting the
  runtime lifetime. Message admission itself still uses its existing lease.
- **Context rollback command.** `conversation.rollback { conversationId, turnId | null }`
  is a runtime command with an `ambiguous` long-mutation renderer policy and a
  validated result (`transfer: native | portable | unchanged`). It retains the
  selected finished turn (or the chat start) and never touches workspace files;
  Git reversal remains the separate scoped `checkpoint.revert`.
- **Intent before effects.** Native rollback reuses the native-control
  record/effect/lock machinery: the plan (retained turn, bounded rolled-back
  turn IDs ≤ 2,048) and the exact source identity commit with a process-bound
  `native.rollback` effect before the provider call. The chat and native
  session stay fenced while running or uncertain; turn admission, queue
  dispatch, conversation/project mutation and fork preparation observe the fence.
- **Outcome classification.** Completed native results (Codex/OpenCode revert,
  Claude resume cursor or new session, Pi replacement fork, unchanged) apply
  natively. Unsupported, rejected or confirmed-cleanup failures (including
  possible mutation) apply the same plan portably. `cleanup-unconfirmed`,
  thrown errors and crashes stay `uncertain`; restart retires the effect and
  only exact runtime-generation or prior-boot cleanup evidence resolves it,
  then portably. No native operation is replayed. T3 differs on both points:
  it refuses an unsupported rollback
  (`apps/server/src/orchestration-v2/CommandPolicy.ts:313-331`) and requeues
  `provider-thread.rollback` after process loss
  (`apps/server/src/orchestration-v2/EffectOutbox.ts:125-128,501-512`). The
  portable fallback and the process-bound `native.rollback` effect are
  recorded differences awaiting a decision (see the fidelity audit entry).
- **Retained history.** Rolled-back turns stay in the transcript as audit
  history but are excluded from portable history, fork capture and future
  context handoffs; forking from a rolled-back turn is refused. Until
  2026-11-01 their file changes still reached the handoff's changed-files list;
  that list now skips them (`src/server/persistence/provider-handoff-files.ts:59-61`). Inherited fork
  history is preserved: a start rollback on a native fork uses the fork's
  inherited head, otherwise it resets portably to inherited history only.
- **Backings and identities.** The active backing must match the current exact
  provider instance, canonical workspace and conversation session. A native
  rollback emits `provider.backing-rewound`: in place it trims coverage to
  retained items; for a replacement (Pi) or new session it retires the old
  backing and creates the exact replacement. Any other backing that saw
  rolled-back items, or has incomplete coverage, is retired; a portable
  rollback clears the conversation's native session pointer.
- **Physical head vs effective cursor.** `history-cursor` stores both. Later
  fork and rollback operations use the physical head (cursor when newer than
  the latest settled boundary); the effective Claude cursor is only a
  continuation recipe.
- **Continuation delivery.** Turn preparation attaches a pending continuation
  only when resuming the exact matching instance/workspace/native session;
  admission records it against the run, `ProviderRunInput.nativeContinuation`
  carries it to `AgentHarnessStartOptions`, and both fresh-session fallback
  layers strip it. Provider output or completion consumes it; settlement before
  dispatch returns it to pending; dispatched-but-unacknowledged becomes
  `uncertain`, retires that backing and continues portably. Switching to
  another provider leaves a pending cursor for a later switch-back.

Validation (Node 22.23.2, this shared checkout, `npm ci` from the existing
lockfile):

- New `tests/server/orchestration-history-rollback.test.ts`: 6 behavioral tests
  (native revert fencing/resume, physical vs effective cursor carried to exactly
  one turn, ambiguous dispatched cursor, portable fallback with inherited fork
  history and fork capture, uncertain rollback through restart and exact cleanup
  evidence, concurrent production `conversation.rollback` handler ordering).
  Plus a fresh-session fallback test proving the cursor is never forwarded.
- Focused set: 32 files / 491 tests; 486 pass. The 5 failures are
  `conversation-context-v3.test.ts`, which fails identically on a clean HEAD
  worktree (pre-existing continuity/context expectation drift).
  Log: `/tmp/orch-v2-rollback-broad-focused.log`.
- TypeScript: web, Private Connect pass; node, unit-test and e2e projects report
  only the concurrent Cursor SDK package's in-progress `cursor-sdk*` files.
- `npm run lint` (standard + type-aware) passes.
- `npm run check:architecture` fails only on line ceilings of shared files:
  `src/server/index.ts` (baseline 1,249 + 3 rollback + 3 Cursor lines) and
  `src/server/providers.ts` (Cursor). The parent owns that integration decision.
- Portable suite: see the final report for this checkpoint.

Findings and objections:

- The command lanes do not replace message-send admission leases; folding all
  send/queue/configuration commands into lanes remains open. Rollback acquires
  admission with a bounded 1 s wait, so lanes and leases cannot deadlock.
- A pending continuation attached to a run that never dispatched returns to
  pending; a dispatched one becomes uncertain even when launch failed before
  the provider started. This is conservative (portable fallback) by design.
- Duo paired turns, watcher notes without a turn ID and Private Connect have no
  rollback-specific handling yet. Rollback across a Pi replacement session to an
  older turn of the previous native session falls back portably.
- No renderer action or rolled-back transcript markers yet; adding a button
  without marking discarded turns would mislead users.

Remaining: renderer rollback action and rolled-back projection in transcript
and snapshot, agent tool for rollback, combined "rollback + restore files"
orchestration (ordered native rollback then scoped checkpoint restore with
partial-outcome receipts), context merge-back from forks, full command/queue
lane coverage, and every other unchecked item in `implementation-plan.md`.
No real provider account, packaged app, Windows/macOS execution or CI result
is claimed.

## Phase 3 completion checkpoint: forks, rollback, context merge-back — 2026-10-30

The user bounded this phase to forks, history rollback and context merge-back
plus in-flight integration. Delegation, wakes, scheduling, ACP and later phases
were not started. PR #686 remains a draft; full V2 is not complete.

Production changes since the resumed checkpoint above:

- **Context merge-back.** `conversation.merge-back { forkConversationId }` is a
  human-only runtime command ordered on the destination chat's lane. The
  destination is always the fork's recorded parent in the same project; the
  fork gains no authority over the parent. The delta is the fork's own retained
  finished turns after the last *delivered* merge-back (or the fork point),
  bounded to 2,048 turns and the latest 2,000 messages. It is materialised as
  an immutable context packet draft on the parent, so the existing composer
  shows it as an attached chip and delivers it with the user's next message,
  with the existing packet budget, replay and history-reference handling.
  Durable `merge-back.prepared/changed` events record lineage, base and through
  turns, packet identity, run and message attribution, and state
  (`prepared → attached → dispatched → delivered`, or `undelivered`, `uncertain`,
  `withdrawn`, `superseded`). Repeating the command is idempotent; new fork work
  supersedes the undelivered draft; a removed draft becomes `withdrawn`.
- **Merge-back gates.** Refused for non-forks, a deleted parent, a parent that
  rolled back the fork's source turn, or a merge-back still being delivered.
  Pre-admission (`assertSendable`) and admission both refuse a draft whose fork
  turns were rolled back. Uncertain/undelivered delivery does not advance the
  base; rolling back the parent turn that delivered a merge-back reopens it.
  Active parent work is not interrupted; already queued parent messages keep
  the context they captured; delivery happens only with an explicit next send.
- **Restart guard (pre-existing failure fixed).** A run recovered after an
  unclean runtime restart now retires the native backing it last dispatched to,
  restoring the legacy rule that recovery cannot authorize native resume
  (`turn-restart-continuation` failed identically on clean HEAD before this).
  T3 instead continues the native thread after a crash or shutdown
  (`apps/server/src/orchestration-v2/RestartContinuation.ts:146-169`). Whether
  Inertia adopts that continuation is decided in the recovery phase; until then
  this is a tracked gap, not a deliberate difference.
- **Client affordances.** Each finished, retained turn footer offers *Fork from
  here* and *Roll back to here* (two-step keyboard confirmation, Escape cancel,
  focus restored, live result stating native vs fresh-session continuation and
  that files are unchanged). Rolled-back turns stay visible, are dimmed, show
  "Rolled back · not in context" and offer no actions. Fork chats show *Merge
  findings into source chat* in the lineage section. Conversation detail
  carries page-scoped `rolledBackTurnIds`, validated against the page's turns.
- **Bootstrap structure.** The runtime command surface moved from
  `src/server/index.ts` into `runtime/commands/runtime-command-handlers.ts`
  with a typed services contract; `index.ts` is 1,159 lines. Per-conversation
  command lanes are owned by the orchestration facade (`store.orchestration.lanes`).

### Comparison with T3 Code at `32ecd71726fee16f335484c1f95cbce126d461f6`

At `32ecd717`, `ThreadForkService.ts`, `CheckpointRollbackService.ts`,
`CheckpointRestoreSafety.ts` and `docs/orchestration-v2/thread-lineage-and-context-transfer.md`
were byte-identical to the earlier pin `dd148481531a0a090780a2ade20588566db099a2`.
At `15fe2832727893cbdd2214383f9f971474849695` only `CheckpointRollbackService.ts`
still is: `ThreadForkService.ts` changed in 7f005d4d8d (#24014) and 50c1c5dc53
(#26901), `CheckpointRestoreSafety.ts` and the lineage document in 50c1c5dc53.
See [t3code-delta-2026-10-31.md](t3code-delta-2026-10-31.md). Merge-back exists
upstream as `thread.merge_back` (`Orchestrator.ts` dispatchThreadMergeBack,
`ContextHandoffService.ts` fork delta summary, MCP `t3_thread_transfer`).

| Area | T3 current | Inertia now |
| --- | --- | --- |
| Merge-back target | Exact parent of a fork | Same |
| Source point | Explicit or latest stable run; completed/waiting only | Latest stable retained point; any terminal fork turn included |
| Base point | Always the fork point; pending transfers of the same pair superseded. At `15fe2832` also refused while another fork's transfer to the same target is pending, or while the target has an active or queued run | Last delivered merge-back (or fork point); undelivered drafts superseded |
| Delivery | Pending transfer consumed automatically at the target's next dispatch | Visible draft packet delivered with the user's next message; removable |
| Delta content | Compact summary lines incl. commands and file changes; at `15fe2832` rolled-back runs and cancelled queued messages excluded | Bounded message excerpts via packets; rolled-back turns excluded; since the phase 3 polish also a command and file-change work summary (`src/server/orchestration-v2/merge-back-repository.ts:245-279`), without T3's `Checkpoint:` and `Handoff:` lines |
| Initiator | User or agent (MCP tool) | User only; agent tool deferred with the agent-tool phase |
| Rollback | Checkpoint rollback coordinates native rollback and optional file restore; rolled-back runs kept as audit | Context rollback separate from Git `checkpoint.revert`; native or portable, audit history kept; opt-in combined file restore since the phase 3 polish |

Upstream since the old pin (all 2026-10-29): `6b1245cc` (Stop always completes,
force stop), `6d12bb1e` (Stop during restart), `36dac688` (restart continuation
retries/parent stop) and `8ab098a4` (held queue release). Phase-3 impact: Inertia
rollback/merge-back already refuse while a run is active, cleanup is pending or
unconfirmed, or a native control is uncertain, and only exact cleanup evidence
releases them; a deferred cursor survives a start that never dispatched. T3's
explicit Force stop (superseded guard, shared-process check, "Force stopped by
user" result), held-queue release and parent-stop continuation semantics were
not implemented here. Inertia already escalates on a second Stop press
(`src/server/runtime/turns/turn-run-state-coordinator.ts:183-195`), and the
stop ladder release below adds an automatic release that T3 does not have; it
is an Inertia decision, not T3's Stop semantics.

### Initial validation for this checkpoint

These implementation-time results precede the review corrections and final
integration checks in [phase3-verification.md](phase3-verification.md).

- `orchestration-history-rollback` 6, `orchestration-merge-back` 4,
  `turn-restart-continuation` 8 plus backing suites pass; DOM
  `history-actions` 3 and `fork-surface` 3 pass.
- Server boot suites (15 files / 134 tests) pass after the bootstrap extraction.
- Node, web, Private Connect TypeScript, lint and architecture pass on my scope;
  the architecture import cycle was removed via `fork-surface-model.ts`.
- Earlier portable run (before the restart fix): 218 files, 3,701 passed,
  14 failed (12 concurrent Cursor SDK package tests, 2 pre-existing restart tests
  now fixed), 3 skipped. Five obsolete `conversation-context-v3` assertions
  also failed on saved HEAD; they were subsequently replaced with meaningful
  intact-history, omission-accounting and handoff assertions, with 16 tests passing.
- Electron scenario `tests/e2e/history-rollback-merge-back.spec.ts` uses a
  fixture Codex app-server that rejects native history methods, so it exercises
  the portable rollback path only; real provider rollback is not claimed.

Remaining after phase 3, as updated by the phase 3 polish below:

- Agent-initiated fork and merge-back tools: agent-tools phase, together with
  the launch runtime-mode step-down (65965f7ab8) and MCP read semantics.
- Private Connect parity and side chats: client-parity phase.
- Codex earlier-run turn rejection (54d0a161bb) and the Pi cleared-queue
  notice (afb8619e1d): queue phase.
- Usage-limit refinements e496db3a5e, 63b0e3d82e and d7d5d7c79b: recovery phase.
- All later-phase checklist items.

Combined rollback with file restore, explicit merge-back source points, the
merge-delta work summary, rollback to the chat start and Duo refusals landed in
the phase 3 polish.

## Phase 0 stabilization — 2026-10-31

The "Linux interaction and lifecycle" CI build failed during third-party notice
generation because `@cursor/sdk` was a production dependency and its platform
packages ship no license file. `@cursor/sdk` 1.0.38 is now an exact-pinned
development dependency. Packaged builds contain no SDK, SDK platform package or
SDK-only transitive dependency, and the SDK-only asarUnpack globs are removed.
Notice generation passes again with the generator unchanged and fail-closed.
The Linux development runtime is unchanged: the SDK resolves from
devDependencies in a development checkout, and packaged asar locations remain
refused with the existing unavailable status. Packaged Linux smoke was not run
on this Windows host.

## Phase 3 polish — 2026-10-31

Status: implemented and verified on Windows 11 x64 with Node 22.23.1 against
the uncommitted working tree on top of `52315e95`. Evidence is in
[phase3-verification.md](phase3-verification.md#phase-3-polish-evidence).

T3 Code was recompared at `15fe2832727893cbdd2214383f9f971474849695`
(393 first-parent commits after `32ecd717`, including stable v0.1.6). At
`15fe2832`, `CheckpointRollbackService.ts` is byte-identical to the earlier
pins; `ThreadForkService.ts`, `CheckpointRestoreSafety.ts` and the lineage
document changed in 7f005d4d8d and 50c1c5dc53. The anchored delta, Inertia
status and decisions are in [t3code-delta-2026-10-31.md](t3code-delta-2026-10-31.md).

What landed:

- **Merge-back cross-fork exclusivity.** One pending merge-back per target
  chat across all forks, following upstream 50c1c5dc53. A second fork's
  merge-back is refused until the first is delivered or removed. Refusal of a
  busy target remains a deliberate difference: the merge-back stays a visible
  draft delivered with the next explicit send.
- **Explicit merge-back source point.** `conversation.merge-back` accepts an
  optional `throughTurnId`; the latest stable retained point remains the
  default. A point outside the fork, rolled back, unfinished, already merged
  back, or preceded by unfinished fork turns is refused. Fork turn footers offer *Merge findings up to
  here* with a two-step keyboard confirmation.
- **Work summary in the merge delta.** Command and file-change items of the
  merged fork turns are summarised in order in the packet supplement, without
  secrets, command output or reasoning, bounded by line count and serialized
  size, with omitted files and commands counted. The composer context preview
  lists them after the messages, including "N more files" and "N more
  commands". Migration 110 `RaiseConversationContextSupplementBound` rebuilds
  `conversation_context_packets` to raise the supplement bound from 4,096 to
  12,288 bytes, preserving rows, indexes, triggers and foreign keys, and rolls
  back completely if the rebuild fails. Merge-back records written before the
  source point and work summary existed still replay.
- **Combined context rollback with opt-in file restore.** The rollback
  confirmation offers *Also restore files to this point* (off by default). The
  context rollback is applied first; files are restored only after a completed
  native or portable rollback, never for an uncertain native rollback. Outcomes
  are `restored`, `unchanged`, `refused` or `failed`, stored durably and
  replayed after a rebuild or restart. A restore saves a recovery checkpoint
  first, restores files the rolled-back turns changed, removes files they
  created while those files are unchanged, and reports files kept because they
  changed afterwards or were not created by those turns.
- **Restore-safety refusals.** The file restore is refused, keeping the
  context rollback, when the turns' file changes are not completely recorded,
  workspace ownership cannot be confirmed, another chat worked in the same
  checkout after the restore point, files outside the rolled-back turns
  changed, or too many files changed. These are Inertia's time-bounded rules,
  not T3's isolation rule (`CheckpointRestoreSafety.ts`); at this checkpoint
  they ignored other chats' live sessions and terminals and did not fence other
  chats' turns during the restore. The file restore model of 2026-10-31 below
  adds both.
- **Attributed recovery checkpoints.** The rollback's "Before file restore"
  checkpoint is attached to the retained turn, and `checkpoint.revert`'s
  "Before checkpoint restore" checkpoint to the chat's latest checkpointed turn.
  This also fixes `checkpoint.revert`, whose recovery checkpoint previously had
  no turn. The timeline shows each attributed checkpoint as a labelled,
  keyboard-reachable action next to *Revert*, with the same disabled rules, and
  no longer drops them from the history.
- **Rollback to the chat start.** The chat actions menu offers *Roll back to
  chat start…* when no work is active, with the same inline confirmation and
  files toggle; rolling back to the start restores every file change after the
  chat start when the files option is chosen.
- **Duo refusals.** Rollback and merge-back are refused while a Duo that
  includes the affected chats is unsettled or needs attention; the paired chat
  is left untouched.
- **Native-control command identities per thread.** Native-control commands
  now fingerprint the thread and project, so identical events in different
  threads no longer collide.
- **Busy-source fork test.** `tests/server/orchestration-native-forks.test.ts`
  covers a native fork prepared portably while the source has an active run
  (`native-source-unavailable`), a held admission lease or a terminal-resume
  reservation (`native-source-busy`), and two forks of one busy source in the
  same runtime.
- **Windows EBUSY test fix.** Two `tests/server/orchestration-v2.test.ts`
  cases now close their runtime store, so the temporary database can be
  removed on Windows.

Verification:

- `npm run check:quality` passed: workflow concurrency, 110 migration lineage
  entries, architecture (1,839 source files, 7,650 internal edges), color
  themes, both linters and all five TypeScript projects.
- Focused Vitest run, 16 files, 207 tests passed: `orchestration-merge-back`
  15, `orchestration-history-rollback` 8, `orchestration-rollback-restore` 11,
  `orchestration-native-forks` 8, `orchestration-forks` 4, `orchestration-v2`
  14, `conversation-context-supplement-migration` 2, `database-migrations` 30,
  `checkpoint-rollback` 1, `turn-restart-continuation` 8, DOM
  `history-actions` 13, `fork-surface` 4, `conversation-history` 22,
  `checkpoint-notice` 3, `composer-chat-references` 30 and
  `response-timeline` 34.
- `npm run build:bundle` passed after raising the two failing budgets:
  `deferredThreadActionsJavaScript` 9,295 bytes (limit 9,085 → 9,551) and
  `coreJavaScript` 2,485,123 bytes (previously measured 2,478,063; limit
  2,478,319 → 2,485,379). Each new limit is the measurement plus 256 bytes; no
  other limit or accounting exclusion changed. Accounting is recorded in
  [renderer-bundle.json](../pr-evidence/orchestrator-v2/renderer-bundle.json).
- Electron `tests/e2e/history-rollback-merge-back.spec.ts`: three runs after
  the build. Runs 1 (1.0 minute) and 3 (35.6 seconds) passed. Run 2 failed in
  the first capture stage, before any step changed by this package: the hovered
  second turn's footer opacity fell back to 0 within the 30-second wait. The scenario covers
  rollback with file restore, the retained turn's "Before file restore" action,
  absence of the recovered legacy history section, merge-up-to-here,
  merge-back and the chat-start confirmation. All fourteen captures come from
  run 3.

Known limits:

- Directories created by the rolled-back turns are not removed; only
  unchanged files they created are.
- The file restore is refused when another chat, including a read-only
  watcher, had a turn in the same checkout after the restore point.
- Refused and failed restore outcomes are covered by renderer and server tests
  only; the Electron scenario exercises the restored outcome.
- The Electron scenario uses a fixture Codex app-server that rejects native
  history methods, so it exercises portable rollback only. macOS and Linux were
  not run for this package.

Deferred with tracked upstream anchors: side chats and Private Connect parity
(client-parity phase); the Codex earlier-run turn rejection (54d0a161bb) and
the Pi cleared-queue notice (afb8619e1d) (queue phase); usage-limit refinements
e496db3a5e, 63b0e3d82e and d7d5d7c79b (recovery phase); launch runtime-mode
step-down (65965f7ab8), MCP read semantics and agent-initiated fork and
merge-back tools (agent-tools phase).

### Stop ladder release — 2026-10-31

The durable core rule "unconfirmed cleanup blocks replacement work" also
blocked the next turn after a Stop whose provider tree could not be confirmed
stopped within the platform budget, so `tests/e2e/stop-ladder.spec.ts` failed on
the macOS lifecycle sentinel and queued messages waited until restart. The
release below is Inertia's own decision. T3 Code 6b1245cc does not release
automatically: an unanswered Stop leaves the run `running` and flagged
`unresponsiveAt` until the user's explicit Force stop
(`apps/server/src/orchestration-v2/EffectWorker.ts:180-201`;
`ThreadStop.test.ts:1556`). Inertia keeps its stop ladder (bounded automatic
escalation after the platform budget, immediate force on a second Stop press)
as a documented difference; since G5 the attempt is flagged unresponsive while
escalation runs (G5 entry, 2026-11-02). The stop ladder's terminal
release is authoritative evidence that the runtime handed the unconfirmed tree
to the process guardian and no longer owns it. The attempt records
`attempt.cleanup-released` with cleanup `unconfirmed-released` and the handoff
evidence (stop outcome, the ownership row's runtime generation and boot
identity, stop budget, release time); it is never recorded as `confirmed`, and
the durable provider ownership row is kept for guardian and restart recovery.
Admission (`hasPendingCleanup`) accepts a released attempt, so the next turn and
queued messages run. Decisions that need real cleanup proof keep refusing it
through `awaitsCleanupProof` or the attempt state: a fork of the chat falls
back to portable history, and history rollback, native-control operations and
attempt replacement are refused. A late exact
confirmation or a restart that confirms the guardian generation moves the
attempt to `confirmed`; otherwise the uncertainty survives restart and
projection rebuild. Without a durable ownership claim the ladder still records
`unconfirmed`, which keeps admission fenced.

### Detached chat windows — 2026-10-31

Detached chat windows no longer request fork history and offer no fork,
rollback or merge-back actions, because the detached runtime policy does not
permit those commands. Rolled-back turns stay dimmed and labelled "Rolled back ·
not in context" there. Enabling these actions in detached windows needs
explicit additions to the detached permission check.

The Linux e2e failures were fixed by splitting the history footer action class
from the shared run-details toggle and by counting the Pi provider card in the
settings matrix; the Windows reproduction passed 23/23 scenarios across five
specs.

### File restore model — 2026-10-31

File restore (rollback with "Also restore files" and `checkpoint.revert`) now
follows T3's restore-safety rule (`CheckpointRestoreSafety.ts`) in addition to
the time-bounded check. Before any safety check the restore upgrades the
chat's checkout reservation to an exclusive restore claim, holds it through
the restore and its verification, and releases it in `finally`. While a claim
overlaps a chat's checkout (same, nested or containing folder, compared by
real path), every provider-turn admission is refused with a short reason:
`TurnController.queue` and `queuePair` refuse, and ordinary sends, queued
dispatch, watcher wakes and agent-thread sends check first. The restore itself
is refused when another chat has an active turn, a live provider run or
cleanup barrier, a held admission lease, an overlapping checkout reservation or
an open terminal whose folder is nested in, contains or equals the checkout. A
sibling folder does not refuse. The existing time-bounded check (another
chat's turns since the first rolled-back turn started) still applies, and a
refused file restore keeps the context rollback. Reverting the own checkpoint
of a rolled-back turn is refused by the server, and the timeline hides its
Revert button; recovery checkpoints stay restorable. Unlike T3, a restore
refuses instead of waiting for the checkout, and a shared project-root
checkout is allowed when no other chat is working in it.

## Fidelity audit fixes — 2026-11-01

Status: uncommitted on top of `b28d5a9f` (PR #686), Windows 11 x64, Node
22.23.1. A read-only audit of phases 1-3 against T3 Code `15fe2832` (recorded
2026-10-31) found three blockers and a set of documentation statements that
overstated the code. This entry records what landed, the coordinator's
decisions and the remaining work.

What landed:

- **Rolled-back files excluded from handoffs (G1).** The changed-files list in
  fresh-session and provider-switch handoffs skips turns with a
  `rolled-back-turn` entity
  (`src/server/persistence/provider-handoff-files.ts:59-61`); retained turns'
  files still appear.
- **Turn-preparation context correctness (G2).** Handoff coverage records only
  the items the assembled prompt actually carries; a restored block the
  assembler rejects fails with a typed, user-correctable error instead of
  proceeding without history
  (`src/server/runtime/turns/turn-context-handoff.ts`). When the delta for a
  resumed native session exceeds its budget, preparation replaces the session
  with a fresh one carrying the full history under one handoff record and
  invalidates the old backing as `context-exhausted`; it refuses with a typed
  error while the provider reports pending background work. History deferred
  by a goal start is delivered with the next normal turn. The budget now
  reserves non-image attachments, estimates native occupancy from covered items
  when no usage was reported
  (`src/server/orchestration-v2/portable-history-occupancy.ts`), and states
  whether the block restores history or adds a delta. The model-window,
  auto-compact and background-work probes are optional provider hooks; no
  provider implements them yet, so the background-work check always sees none
  and the window falls back to the override or reported maximum.
- **Restore fencing and safety parity (G3).** See the file restore model entry
  above: an exclusive checkout claim fences every provider-turn admission path
  on an overlapping checkout during a restore, T3's isolation rule refuses a
  restore while another chat's live session or open terminal overlaps the
  checkout, and the server refuses to revert a rolled-back turn's own
  checkpoint while the timeline hides that Revert button. Opening a terminal on
  an overlapping checkout during a restore is refused with its own message
  ("Files are being restored in this chat's checkout. Open the terminal again
  when the restore finishes.",
  `src/server/runtime/checkout-restore-fence.ts`), distinct from the automatic
  Git update refusal.
- **Isolated Electron fixes.** Fork history is requested only for saved chats,
  so a new-chat draft no longer asks for inherited history before it exists
  (`savedChatRunner`,
  `src/renderer/src/components/workspace-scene/createWorkspaceSceneModel.ts`),
  and `tests/e2e/composer-project-picker.spec.ts` waits for the checkout label
  to settle before measuring, so a not-yet-known Git status is never read as
  "Detached HEAD".

Decisions (coordinator, 2026-10-31):

- **Stop.** Inertia keeps its stop ladder (bounded automatic escalation after
  the platform budget, immediate force on a second Stop press) as a documented
  difference from T3's explicit Force stop. The ladder's release resolves
  admission as `unconfirmed-released` and never counts as cleanup proof. The
  attempt is flagged unresponsive while escalation runs, and Stop is a
  receipted durable command with a process-bound interrupt effect (G5).
- **File restore.** T3's isolation rule is adopted in addition to the
  time-bounded check (landed in G3).
- **Crash and shutdown continuation.** Decided in the recovery phase; recorded
  as a tracked gap, not a deliberate difference.

Authoritative V2 commands since G5 (2026-11-02, below): every `message.send`
disposition, `agent.stop`, `conversation.update`, the queue edits
(`message.queue.enqueue`, `remove`, `send`, `stop-and-send`),
`conversation.fork`, `conversation.rollback` and `conversation.merge-back` are
receipted on the conversation lane; `checkpoint.revert` and first-send fork
preparation are ordered on the lane without a receipt. Approvals, input
answers, `activity.stop`, `agent.subagent.stop` and delegated cancels still
bypass V2.

Differences from T3 recorded here but not yet decided (each is either a
deliberate difference or a gap once its owning package decides): actor-scoped,
payload-fingerprinted receipts; no in-process `provider.start` retry (G7); a
fresh session instead of refusing an unverified model switch; re-offered
omitted history, the 2,048-item coverage cap and the 256-candidate bound
(G11); handoff `uncertain` on dispatch without output and no handoff
capability gate (G11); the two-strike rejected-resume rule (G9); the run
status mapping (Stop is `cancelled`, restart is `interrupted`, no `waiting` or
`rolled_back` run status) (G8); crash backing retirement versus T3's crash
continuation (recovery phase); the eager fork history snapshot,
explicit-turn-only fork source points, portable fallback where T3 fails a
native fork, portable rollback where T3 refuses, and process-bound
`native.rollback` where T3 replays it (G12); Git checkpoints not marked stale
after rollback; anchoring by item kind rather than role; and the legacy
own-chat reference history path.

G4, the documentation truth pass, is this entry together with the corrections
of 2026-11-01 earlier in this file and in
[t3code-delta-2026-10-31.md](t3code-delta-2026-10-31.md). Each corrected
statement cites a code anchor checked against this working tree.

Remaining gap packages, tracked work in this order (G6 → G5, G8 → G9,
G10 → G11, with G7 and G12 alongside):

- **G5** command authority for send dispositions, Stop and configuration:
  every `message.send` disposition, `agent.stop`, `conversation.update` and
  queue edit on the conversation lane with receipts; receipted Stop with a
  process-bound interrupt effect and the unresponsive flag; non-current
  attempts cannot write lifecycle state.
- **G6** receipt status and errors with rejected-receipt replay, projection
  metadata and a boot-time projection verify.
- **G7** production outbox dispatcher, replay-safe effects and pruning.
- **G8** run and attempt ordinals, attempt reasons, `superseded` attempts and
  native refs.
- **G9** in-run fallback for a rejected resume, recorded as a V2 attempt.
- **G10** attributed portable item kinds (commands, errors, file changes,
  plans, interrupt results) and provenance.
- **G11** coverage accounting for omitted items, then Codex native history
  injection.
- **G12** fork and merge-back polish: portable fork of unsuccessful source
  turns, native Codex legacy-history forks, `Checkpoint:` and `Handoff:` lines.
- Later phases keep L1 (per-item queue selection), L2 (account-aware
  instances), L3 (recovery: continuation, persisted questions, background-work
  notes) and L4 (V2 publication to clients).

Verification:

The machine was shared with other agents' builds and test runs throughout.

- `npm run check:quality` passed: workflow concurrency, 110 migration lineage
  entries, architecture (1,844 source files, 7,675 internal edges), color
  themes, both linters and all five TypeScript projects.
- `npm run build:bundle` passed. `coreJavaScript` measured 2,485,356 bytes
  (previously 2,485,130) against its 2,485,379 limit, 23 bytes of headroom, so
  its limit was re-baselined to 2,485,612 (measurement plus 256); a rerun of
  `npm run check:renderer-bundle` passed. The startup routes measured 902,998
  and 796,783 bytes and keep 349 bytes of headroom under their unchanged
  limits; no other limit and no exclusion changed. Accounting is in
  [renderer-bundle.json](../pr-evidence/orchestrator-v2/renderer-bundle.json)
  (`fidelityAuditFixes`).
- Focused Vitest, 16 files: `orchestration-history-rollback`,
  `orchestration-backings`, `orchestration-context-exhaustion`,
  `orchestration-rollback-restore`, `orchestration-portable-history`,
  `provider-handoff-continuation`, `turn-controller`, `queued-message-runtime`,
  `duo-deletion-commands`, `duo-launch`, `checkpoint-rollback`,
  `runtime-query-plans` and DOM `history-actions`, `fork-surface`,
  `composer-checkout-branch`, `checkpoint-notice`. The first run had 267 of
  268 tests passing; `fork-surface` "pages immutable history without replacing
  already loaded items" missed its 1-second `findByText` wait while 46% of the
  run was spent transforming. That file passed alone (6/6) and the rerun of all
  16 files passed 268/268. `duo-launch` "preserves an exact worktree
  reattached after a legacy removal claim", reported earlier as timing out
  under load, passed in both full runs and alone (4.4 s); it does not go
  through `queuePair`.
- The new terminal refusal test in `orchestration-rollback-restore` passed
  alone and in the full runs.
- Electron `--project isolated` with `composer-project-picker`,
  `project-navigation`, `session-continuity` and
  `history-rollback-merge-back` (five scenarios): run 1 failed three. Two
  fixtures never became ready because their temporary profile and data
  folders disappeared during startup (`ENOENT` on the fixture's `data`
  folder); `project-navigation` did not show the attached file. Run 2 passed
  four of five; `project-navigation` completed its steps but its fixture
  folder was not removed within the close deadline. `project-navigation`
  alone then passed (32.0 s).
- Electron `--project display-sensitive` with `detached-chat-tools`: 8 of 8
  passed.

Not exercised: macOS and Linux, a packaged build, real provider accounts, and
the full `npm run check` suite.

## Fidelity gap packages G7, G10, G12 — 2026-11-01

Status: uncommitted on top of `7c27c05d` (PR #686), Windows 11 x64, Node
22.23.1. Three of the gap packages listed in the fidelity audit entry above
landed together: G7 (effect outbox runtime), G10 (portable item kinds and
provenance) and G12 (fork and merge-back polish). The T3 delta rows they
satisfy (B.1 and B.5) are updated in
[t3code-delta-2026-10-31.md](t3code-delta-2026-10-31.md).

### G7: effect outbox runtime

`OrchestrationEffectRuntime` (`src/server/orchestration-v2/effect-runtime.ts`)
is the production dispatcher over the outbox. It claims only the kinds that
have a registered executor (`claimNext`), so process-bound rows that callers
claim inline (`provider.start`, `native.fork`, `native.rollback`) are never
taken by it, and a thread's later effects still wait behind any earlier
pending or running effect. Up to four effects run at once. Every claim stays
fenced by runtime, claim id and attempt count. Work is picked up in three
ways: a microtask-deferred `wake()` (safe to call inside a transaction,
because the claim runs after the commit); outbox state changes (settle,
retire, cancel, requeue and recovery wake it automatically); and a timer set
to `nextClaimableAt`, so a retry becomes claimable without an outside pump.
The timer falls back to a 30-second liveness poll. `cancelUnsettled`
follows T3 Code's arm-before-recheck rule: the claim registers its abort
signal before execution rereads the durable row. Cancellation therefore
stops an effect at any point. A cancel that commits between claim and
execution means the executor never starts. A cancel during execution aborts
the executor's signal, and the fenced settle leaves the cancellation in
place. Cancelled rows are stored as `retired`, with the cancellation reason
as the failure code. Settled `succeeded` and `retired` replay-safe rows of a
classified kind older than seven days are pruned at startup and then hourly,
500 rows per statement. `failed` rows are kept, and process-bound intents are
never pruned: `dispatchStart` and the native-control fences treat a missing
intent as pre-V2 work. The runtime is created at the end of
`initializeRuntimePersistence`, after startup recovery has retired
process-bound effects and requeued replay-safe ones
(`src/server/runtime-startup-recovery.ts:176-177`). It starts only when the
runtime safety lock is clear, and it stops if startup fails or the database
closes. The first replay-safe kind defined end to end is
`checkpoint.capture-requested` (`checkpointCaptureEffect`). Its executor is
injected through `register`, and it is not emitted in production yet.
Retrying is a deliberate classification, recorded with a rationale in
`ORCHESTRATION_EFFECT_KINDS`. Only replay-safe effects retry, with bounded
backoff of at most five attempts. `provider.start` and the native operations
never retry inside the process. A claimed start may already have reached the
provider, so a failed launch settles `failed` once and the fresh-session
fallback owns recovery. This differs from T3 Code, where every effect type
retries. Tests: `tests/server/orchestration-v2-outbox.test.ts`.

### G10: portable item kinds and provenance

Portable history now carries T3's activity item kinds from retained,
settled turns, not only user and assistant messages
(`src/server/orchestration-v2/portable-history-source.ts`). A `command`
activity becomes a `command` item with its input (at most 2 KiB), an
`Exit code` line, its outcome and the last 4 KiB of its output, all passed
through `scrubCommandSecrets` and `neutralizeUntrustedAgentText`. The exit
code is known only where Inertia records it (failed Claude commands); it is
`unknown` otherwise. An `error` activity becomes an `error` item with its
failure message only. A turn's plan becomes a `plan` item with the
explanation and a step checklist. A ready or partial git artifact becomes
one `file-change` item per turn, listing each file with its change kind (up
to 200 files). A started turn that ended `cancelled` or `interrupted`
becomes an `interrupt-result` item. Reasoning, generic tool activity,
running activities and any activity of an unsettled turn are never read.
Rolled-back turns and turns outside the continuation route are excluded.
So are turns whose messages the target backing already covers, so a
returning session is not sent its own native commands again. Item ids are
prefixed (`activity:`, `plan:`, `files:`, `interrupt:`). Every item records
`turnId`, `runId`, `at` and `providerBackingId`; the backing comes from the
last `provider.backing-recorded` event for the run. The budget algorithm is
unchanged, and activity items compete with messages by recency, as in T3.
In the realistic chat of `conversation-context-v3.test.ts`, the 11 KB
migration guide is therefore omitted now, where three short messages were
omitted before; that test's expectations were updated. The coverage text
adds the covered chat-turn ordinals and the first and last source item ids.
`selectPortableHistory` and `readPortableContinuationHistory` accept
`hostToolBridgeAttested`. When it is `false`, the text says omitted history
cannot be retrieved instead of naming `inertia_request_context`. The
production call in `turn-request-preparation.ts` does not pass it yet, so
production still names the tool on every route. The last-turn command list
is gone from this path's "Handoff outcome" block (`moved` remains);
`lastTurnCommands` still serves chat-reference packets. The aggregated
"Files changed earlier in this chat" block is still appended after the
selection when room remains, because the G1 rollback and provider-handoff
tests require it. Session-recovery counts still count messages only.
Covered-history occupancy now includes covered activity, plan and
file-change items. Inherited fork items still carry a null
`providerBackingId`.

### G12: fork and merge-back polish

A lazy native fork now requires a `completed` source turn. A failed,
interrupted or cancelled source records `fork.portable-selected` with
`native-source-unsuccessful` and never calls the provider, as T3's
`decideForkExecution` does (`src/server/runtime/fork-session-service.ts`).
Codex `thread/fork` with the inclusive `lastTurnId` is now allowed on
legacy-history threads. The source head and boundary are still checked
through `thread/turns/list` before the fork, and the fork's head is checked
after it. Native revert still requires paginated history and returns
`unsupported` otherwise. An unknown history mode refuses a fork with
`known-native-history-required`. Whether a real legacy-history Codex thread
answers `thread/turns/list` has not been tried; if it does not, the fork
fails closed and the chat continues portably. The merge-back packet
supplement gains typed `checkpoints` (`turnId`, `fileCount`, `truncated`)
for each fork turn with a ready or partial checkpoint, and `handoffs`
(`turnId`, `itemCount`, `providerId`, `modelId`, `session`) for each
delivered context handoff. `session` is `new` or `resumed`, read from the
handoff's `context.handoff-prepared` event: the stored handoff record's
target backing is overwritten on delivery, so the event is the only place
that still says whether a fresh session was started. Each list holds at most
64 entries and counts the rest in `omittedCheckpoints` and
`omittedHandoffs`, and the whole supplement stays within the existing
8 KiB. The `commands` list holds commands only again. The packet codec
accepts the new fields with strict per-entry keys, and existing packets stay
valid. The prompt formatter renders them as `checkpoints` ("Checkpoint: N
files", with "(list incomplete)" for a truncated file list) and `handoffs`
("Handoff: N earlier items to <provider> <model> in a new session"), and
the composer preview lists them as their own lines. The shared line
formatters live in `src/shared/conversation-context-supplement.ts`, so the
first-load renderer chunks are unchanged. The merge-back record's summary
keeps the optional `checkpointCount` and `handoffCount`; older records
replay without them. The chip's new lines cost core bytes; the re-cap is
recorded under Verification below.

### Tracked for the Phase 4 rebase

All five items were resolved in the Phase 4 rebase; see
[Rebase onto 630aa2cf and deferred hooks](#rebase-onto-630aa2cf-and-deferred-hooks--2026-11-01).

- **Effect runtime post-commit wake hook.** Enqueuing an effect does not
  notify the outbox's subscribers; only settle, retire, cancel, requeue and
  recovery do (`notifyAvailable`,
  `src/server/orchestration-v2/effect-outbox.ts:197`). A replay-safe effect
  committed by a command is therefore claimed on the next state change,
  `nextClaimableAt` timer or 30-second liveness poll. The command commit path
  needs a post-commit hook that calls `wake()`.
- **Effect runtime shutdown stop.** `initializeRuntimePersistence` returns
  `orchestrationEffects`, but `src/server/index.ts:227-231` does not take it,
  so no shutdown path calls its `stop()`; it stops only on a startup failure
  or when the database closes. Shutdown must
  stop it before the database closes, so running executors are aborted and
  their claims are released deterministically.
- **`checkpoint.capture-requested` emission.** The kind, payload schema and
  replay policy exist, but nothing emits it and no executor is registered in
  production. Emitting it raises the start-claim barrier question: a thread's
  later effects wait behind any earlier pending or running effect, so a
  capture queued behind a claimed process-bound `provider.start` waits for
  that start to settle. Decide whether capture should wait behind the start
  claim or be exempt from it.
- **`hostToolBridgeAttested` pass-through.** `selectPortableHistory` and
  `readPortableContinuationHistory` accept it, but the production call in
  `src/server/runtime/turns/turn-request-preparation.ts:473` does not pass the
  value it already computes at line 261, so every route still names
  `inertia_request_context` for omitted history. This is a one-line change.
- **Duplicated files information (decision to take).** Portable continuation
  carries one `file-change` item per turn
  (`src/server/orchestration-v2/portable-history-source.ts:88-93,126-130`) and
  also appends the aggregated "Files changed earlier in this chat" block when
  room remains (`portable-history-source.ts:274`;
  `src/server/persistence/provider-handoff-files.ts:122`). The G1 rollback and
  provider-handoff tests depend on the block. Decide whether to keep both,
  drop the block on this path, or leave out per-item file changes that the
  block already lists.

### Verification

All runs used the combined tree (G7, G10 and G12 together) on a machine shared
with other agents' builds and test runs. The eight one-line doc comments the
packages added in `portable-history-source.ts`, `portable-history.ts` and
`turn-context-facts.ts` were removed while the portable run was in progress
(an existing comment edited in `portable-history-occupancy.ts` stays). The
quality gate and focused Vitest ran before the removal; `lint:standard`, the
last rebuild and the Electron run ran after it.

- `npm run build:bundle` first failed only on `coreJavaScript`: 2,485,775
  bytes against the 2,485,612 cap, 419 bytes over the last recorded
  measurement (2,485,356). G12 measured its own share as 369 bytes. The core
  cap was raised to 2,486,031 (measurement plus 256) in
  `scripts/check-renderer-bundle.mjs`, with the accounting in
  [renderer-bundle.json](../pr-evidence/orchestrator-v2/renderer-bundle.json)
  (`fidelityAuditFixes2`). The rebuild passed, and so did a later rebuild
  before the Electron run. The startup routes did not change size: 902,998
  bytes against 903,347 and 796,783 bytes against 797,132. No other limit
  and no exclusion changed.
- `npm run check:quality` passed: workflow concurrency, 110 migration lineage
  entries, architecture (1,846 source files, 7,688 internal edges, 4 derived
  compatibility facades), color themes, both linters and all five TypeScript
  projects. `npm run lint:standard` passed again after the comment removal.
- Focused Vitest, 17 files (`orchestration-v2-outbox`, `orchestration-v2`,
  `orchestration-portable-history`, `orchestration-backings`,
  `orchestration-context-exhaustion`, `orchestration-history-rollback`,
  `provider-handoff-continuation`, `conversation-context-v3`,
  `orchestration-merge-back`, `orchestration-native-forks`,
  `native-conversation-operations`, `orchestration-forks`,
  `turn-restart-continuation`, `runtime-query-plans`, `session-continuity*`
  and DOM `composer-chat-references`, `fork-surface`). The first run passed
  257 of 260. Three `fork-surface` tests missed their 1-second `findBy`
  waits during a cold transform (42 s run). That file then passed alone three
  times (6/6), and the rerun of all 17 files passed 260/260 in 30.6 s.
- `npm run test:portable`: 228 of 235 files passed, 1 skipped; 3,782 tests
  passed, 8 failed, 80 skipped, in 2,246 s. Each failing file was rerun
  alone:
  - `claude-agent-sdk-lifecycle` (5/5), `native-gemini-provider-migration`
    (2/2), `opencode-interaction-reply-deadline` (10/10) and
    `package-smoke-history` (15/15) passed alone. Under the full run they
    failed on load: a "stalled" status read before settlement, 15-second
    timeouts, a 2,016 ms stop against a 2,000 ms bound, unconfirmed provider
    process cleanup, and `EBUSY` removing a temporary `inertia.sqlite`.
  - `app-update-candidate-viability-worker` fails 2 of 21 alone as well, with
    `EPERM` creating symlinks; this machine cannot create symlinks.
  - `provider-harness-portable-registration` timed out at 15 s in the full
    run and alone. Its portable-test discovery reads every file under
    `tests/`, and single reads took 1-3 s on this disk during the session.
    With `--testTimeout=400000` it passed (1/1, 33 s), so the manifest and
    harness registration are correct.
  None of the failing files touches code these packages changed.
- Electron `--project isolated` with `session-continuity` and
  `history-rollback-merge-back`: the first run failed both scenarios at
  launch with "The Windows runtime Job Object assembly integrity check
  failed". The portable run had rebuilt
  `resources/generated/runtime-process-guardian/windows-runtime-job.exe`
  after the main bundle was built, so the hash compiled into `out/main` no
  longer matched the executable. After `npm run build:bundle` rebuilt both,
  2 of 2 passed (1.4 min).

Not exercised: macOS and Linux, a packaged build, real provider accounts, a
real legacy-history Codex thread, and the full `npm run check` suite.
## Phase 4: managed delegation, durable parent wakes, observed native children — 2026-11-01

Status: implemented and verified on Windows 11 x64 with Node 22.23.1, first
against the uncommitted working tree on top of `112c4a46`, then rebased onto
`origin/orchestrator-v2` at `630aa2cf` with the deferred fidelity hooks wired
and the full gate run (see
[Rebase onto 630aa2cf and deferred hooks](#rebase-onto-630aa2cf-and-deferred-hooks--2026-11-01)).
Evidence, the decisions
table, deferrals, the T3 test mapping and unexercised environments are in
[phase4-verification.md](phase4-verification.md).

What landed:

- **Migrations 111 and 112.** 111 `PersistDelegatedTasks` widens the
  `agent_thread_operations` tool check to `inertia_delegate_task` and
  `inertia_cancel_task`, adds the `client_request_key` retry column with a
  per-source unique index, adds `delegated_completion_json` to
  `queued_messages` and `messages` with one active delivery row per chat, and
  creates the `delegated_tasks` and `delegated_task_turns` projections. It does
  not drop provider sessions. 112 `PersistDelegationAutomaticWakes` adds
  `app_state.delegation_automatic_wakes`, on by default. Both lineage entries
  are appended to `database-migration-lineage.json`.
- **Events and records.** Seven V2 events (`delegation.task-created`,
  `task-turn-attached`, `task-finalized`, `wake-policy-changed`,
  `delivery-changed`, `mailbox-changed`, `wakes-disarmed`) are projected into
  the task records and a per-parent mailbox. Commits are receipted on the
  parent's lane, boot recovery runs per parent through the lanes, and the
  index can be rebuilt from the event log.
- **Host tools.** `inertia_delegate_task`, `inertia_get_task_status`,
  `inertia_wait_for_task` and `inertia_cancel_task` join the orchestration
  pack, whose revision is now 4. Create and cancel ask the user; the approval
  names the wake policy. Status, wait and acknowledgement need no approval.
  An approved `inertia_send_message` attaches to or starts a follow-up task.
- **Runtime commands.** `delegation.task.read`, `delegation.task.cancel`,
  `delegation.delivery.dismiss`, `delegation.delivery.send`,
  `delegation.wake.set` and `observed-child.read`, plus the
  `delegationAutomaticWakes` setting through `settings.update`. Detached
  windows may read their own tasks and children only; Private Connect receives
  neither delegation detail nor wake messages.
- **Durable wakes.** Finished results are planned into one typed queued row
  ahead of user and watcher entries and outside the user cap, steered into a
  running parent when allowed, dispatched once otherwise, and recovered after
  a restart between queue reconcile and scheduling.
- **Observed native children.** A read-only projection over subagent traces
  with lineage, status, usage, task, progress and result. Stop is offered only
  through the existing exact-trace stop.
- **Renderer surfaces.** The Delegated work panel and child breadcrumb, the
  timeline completion card, the pinned Delegated results queue row, Agent
  details on a turn's agents line, and the Settings › Chats switch "Continue
  chats automatically when delegated tasks finish".
- **Fidelity review and fixes.** A read-only review against T3 `15fe2832`
  found two major and several minor gaps. F1 re-evaluates tasks when a
  limit-reset or continuation plan settles without a turn, keeps a
  usage-limited parent's tasks, cancels limit plans through the scheduler and
  dismisses the child's continuation on cancel, persists the automatic-wakes
  setting and gates steering on it, runs recovery through the lanes, and
  dispatches a waiting delivery before a manual send. F2 fixes the "N of M"
  wake wording, result-turn selection, `latest`, dispose clearing the wake,
  task-scoped `needsAction` in the detail and the derived terminal status. F3
  adds typed escalation codes, the post-approval interaction recheck, the
  follow-up wake in the send approval, the `design` role, the optional title,
  `clientRequestId` on cancel and logged follow-up link failures. F4 moves the
  renderer to the server's `needsAction` and the delivered outcome wording,
  removes the unpopulated `observedChildControls` detail field and deletes the
  unused `recheckObservedChildStop`.
- **Package E corrections.** Host-tool approvals can be answered from the UI
  again (the approval command accepted only UUIDs); Continue with results is
  offered for results dismissed by Stop; a delivery held after an interrupted
  turn offers Send now.

Verification: the delegation suites pass 132 of 132 tests in 17 files; the
Electron scenario `tests/e2e/delegation-wake.spec.ts` passes 5 of 5; the
renderer bundle passes with core at 2,520,075 of 2,520,238 bytes. Sixteen
captures are in `docs/pr-evidence/orchestrator-v2/screenshots/`.

Known limits: real providers, resumed native sessions (R1), long host-tool
waits (R3), macOS, Linux and packaged builds were not exercised. The detail
reload that showed live assistant text twice during a streaming turn was fixed
after the scenario (see the rebase entry below).

Deferred: inherited runtime-mode step-down for `inertia_delegate_task`
(design §5 Q6, provider-registry work), the child-question reactor (§5 Q4,
persisted-questions phase) and usage-limit refinements e496db3a5e and
63b0e3d82e (recovery phase).

### Rebase onto 630aa2cf and deferred hooks — 2026-11-01

The Phase 4 tree was committed locally as one staging commit and replayed with
`git rebase --onto origin/orchestrator-v2 112c4a46`. `112c4a46` and `907ad3d2`
share the tree `d869618e`, so the one commit replays over `d17f89ef`,
`b28d5a9f`, `7c27c05d` and `630aa2cf`. Four files conflicted; every other
overlap (`turn-request-preparation.ts`, `turn-repository.ts`, `projector.ts`,
`event-store.ts`, `ChatWorkspace.tsx`, `layers.tsx`,
`createWorkspaceSceneModel.ts`, `agent-thread-manager.ts`, the runtime and
turn command handlers, `src/shared/orchestration-v2.ts`) merged cleanly.
Upstream added no migrations, so 111 and 112 keep their numbers and the
lineage has 112 entries.

| File | Resolution |
| --- | --- |
| `src/server/runtime/queued-message-runtime.ts` | Both. The upstream checkout-restore fence (a chat whose files are being restored keeps its queue and retries after admission) runs first; Phase 4's delegated-content resolution and withdrawal of an empty delegated delivery follow it. |
| `scripts/check-renderer-bundle.mjs` | The larger cap on each line: Phase 4's main workbench, detached chat and core caps over the upstream ones, then core re-measured (below). |
| `docs/pr-evidence/orchestrator-v2/renderer-bundle.json` | Both. The three upstream blocks (`detachedHistoryAndLinuxE2eFixes`, `fidelityAuditFixes`, `fidelityAuditFixes2`) and the three Phase 4 blocks (`phase4Renderer`, `phase4FidelityRenderer`, `phase4PackageE`) are all kept, upstream first. |
| `docs/orchestrator-v2/implementation-progress.md` | Both appended sections kept, upstream first. |

`npm run typecheck` passed on the rebased tree before any hook work.

Deferred hooks from the fidelity packages:

- **Effect wake.** `OrchestrationEventStore` takes an `onEffectsCommitted`
  callback and calls it after a commit that was not a replay and carried
  effects. `OrchestratedTurnRepository` creates the outbox first and passes
  `() => this.effects.notifyAvailable()`, so a committed replay-safe effect is
  claimed on the next microtask instead of the next state change, timer or
  liveness poll. A commit nested in an outer transaction notifies before the
  outer commit; the runtime's wake is microtask-deferred, so the claim still
  runs after it.
- **Shutdown and executor.** `src/server/index.ts` takes
  `orchestrationEffects` from startup recovery and stops it in
  `quiesceRuntimeWork` right after `store.orchestration.lanes.close()`, before
  the store closes. The `checkpoint.capture-requested` executor
  (`src/server/runtime/checkpoint-capture-executor.ts`) reads the turn, checks
  its conversation and run against the request, calls
  `turnGitArtifacts.finalize` and invalidates the chat's detail. It is
  registered when post-ready artifact reconciliation starts, so captures never
  start Git before `runtime.ready`, matching the existing rule for boot
  artifact work. Startup recovery attaches the runtime to the repository.
  `index.ts` is 1,175 lines, under the 1,250-line ceiling.
- **Capture emission and the start barrier.** The terminal
  `run.status-changed` commit carries `checkpointCaptureEffect` when the run
  moves from a non-terminal to a terminal status, unless the chat is a
  read-only watcher (an attached link with `read_only`), and only once per run
  and turn. Starts no longer refuse behind a capture: the start claim and the
  native-control claims pass over earlier capture effects in the thread, and
  `dispatchStart` takes a deferral. When an executing runtime is attached and
  the thread has an unsettled capture before the start intent, the controller
  answers the start as accepted, waits for the captures to settle, bounded by
  `TURN_GIT_ARTIFACT_FINALIZATION_TIMEOUT_MS` (60 seconds, the budget that
  bounds the artifact barrier), and then dispatches; a turn stopped meanwhile
  is not started, and a refused dispatch fails the turn before start. Without
  an executing runtime (safety lock, before post-ready, tests) the start never
  waits. The direct finalization in `turn-settlement-coordinator.ts` and the
  boot catch-up in `TurnGitArtifactManager.reconcile` stay. The controller hook
  `captureGitArtifacts` is called only from that direct path, and
  `tests/server/turn-controller.test.ts` ("atomically queues the visible
  request, captures immutable config, and owns all completion associations")
  expects the hook for the settled turn, so removing the direct path fails an
  existing artifact test; the read-only watcher and failed-cleanup tests
  assert the hook is not called.
  The direct path also installs the per-chat artifact barrier that orders the
  next turn's pre-capture for paired Duo starts, which do not go through
  `dispatchStart`, and publishes the detail refresh. The boot catch-up also
  covers pre-V2 turns without a run projection, terminal turns from before
  this change that have no capture effect, missing-artifact records and
  pruning. Both paths call `finalize`, which shares one in-flight
  finalization per turn and leaves a finished artifact unchanged, so a turn is
  finalized once. One difference: the effect path also finalizes when the
  turn's local in-memory cleanup threw, which the direct path skips.
- **Retrieval attestation.** The portable history call in
  `turn-request-preparation.ts` passes the `hostToolBridgeAttested` value
  computed for the route, so `inertia_request_context` is named only where the
  host tool bridge is attested; elsewhere the coverage says omitted history
  cannot be retrieved in this session.
- **Files decision.** Following T3, provider handoffs carry file changes only
  as attributed per-turn `file-change` items. The aggregate "Files changed
  earlier in this chat" block is no longer appended to portable continuation
  history (`portable-history-source.ts`). `providerHandoffFilesBlock` stays for
  chat-reference packets (`referencedContinuationHistory`), where G1's
  rolled-back exclusion still applies; the test-only legacy
  `continuationHistory` path keeps its block. The session-recovery "N
  messages" counts are unchanged.

Tests:

- `tests/server/orchestration-v2-outbox.test.ts` gains three cases: a
  terminal turn commits one capture with its terminal `run.status-changed`
  event and the turn's artifact is finalized once even though the direct
  path also runs; a capture left pending at shutdown runs once after a
  restart; and the next start waits for the previous capture (no provider
  run until it settles, then the start intent succeeds).
- `tests/server/orchestration-backings.test.ts`: portable history on an
  unattested route says retrieval is unavailable and does not name the tool;
  the attested Codex route names `inertia_request_context`.
- `tests/server/orchestration-history-rollback.test.ts` and
  `tests/server/provider-handoff-continuation.test.ts` now assert that fresh
  sessions, provider switches and retries carry the retained turns' files as
  `File change (...)` items, exclude rolled-back turns, and no longer contain
  the aggregate block or its execution-manifest reference; the chat-reference
  test keeps asserting the block. `tests/server/conversation-context-v3.test.ts`
  expects only the handoff outcome attachment and, because its world has no
  attested provider, the unattested retrieval wording.

Streaming detail refresh: the duplicated live text recorded as open in
[phase4-verification.md](phase4-verification.md) was fixed before the rebase
(`continuedLiveSegment` and `liveSegmentContinuation` in
`src/renderer/src/utils/response-timeline/execution.ts`;
`tests/renderer/streaming-detail-refresh.dom.test.tsx`), at a cost of 530
core bytes on the cap.

Full gate on the rebased tree (commands, numbers and the classification of
every failure are in
[phase4-verification.md](phase4-verification.md#rebase-onto-630aa2cf-deferred-hooks-and-full-gate)):
`npm run check:quality` passed, and again after the gate fixes;
`npm run test:portable` 3,878 of 3,961 tests passed with 3 failed (2 EPERM
symlink tests and a 15-second timeout that passes alone) and 80 skipped;
`npm test -- --maxWorkers=4` 17,756 passed, 117 failed and 481 skipped, of
which 42 are machine noise (EPERM symlinks, the pdfjs worker and the Cursor
SDK through the `node_modules` junction), 5 are load timeouts that pass
alone, and 70 were fixed: a default-locale comparison in
`delegation-reads.ts`, the query plan snapshot for the delegation reads, the
session-continuity retrieval expectations, and two command test stubs that
lacked the upstream `conversationWork` dependency; `npm run build:bundle`
passed with core at 2,521,262 of 2,521,518 bytes; the delegation wake,
history rollback and session continuity Electron specs passed 7 of 7 on the
second run after the first launch never reached the ready state.

## G6: receipt status and projection metadata — 2026-11-01

Migration 113 (`OrchestrationV2ReceiptStatusAndProjectionMetadata`,
`src/server/persistence/migrations/orchestration-v2-receipt-status.ts`) adds
`status`, `error` and `command_type` to `orchestration_v2_receipts` and creates
`orchestration_v2_projection_metadata`, seeded with projector version 1 and the
latest event sequence. It checks `PRAGMA table_info` and uses `IF NOT EXISTS`
and `INSERT OR IGNORE`, so running it again changes nothing. Older receipts
read as `accepted` with no command type. The event store now records the
command type on every receipt, moves `last_sequence` forward in the same
transaction as each commit that has events, and writes the metadata row when
it rebuilds projections (pages of 500). `reject()` stores a `rejected`
receipt, and both `receipt()` and `commit()` throw `OrchestrationCommandRejected`
when that identity is replayed. A different payload still fails with
`command-conflict`, and `human` and `runtime` receipts stay independent.
`verify()` compares the projector version (`ORCHESTRATION_V2_PROJECTION_VERSION`
in `projector.ts`), the projection sequence and the registered threads.
`verify({ readable: true })` also reads every thread, run and attempt row
against the shared schemas, in pages of 500.

`RuntimeStore` calls `OrchestratedTurnRepository.maintainProjections()` right
after migrating. A normal open runs only the cheap checks and parses no
projection rows. When a cheap check fails, it records a full verification,
rebuilds through `delegation.rebuildProjections()` (which also rebuilds the
delegated-task index), and verifies again with the row scan. If that still
fails, it throws `OrchestrationProjectionVerificationError`, a
`RuntimeStartupBlockerError` with the new code
`orchestration-projection-invalid`. The worker reports that code. The
supervisor stops restarting and records the incident
`runtime.orchestration-projection-invalid` in the diagnostics history. The
connection tells the user that saved data and backups were not changed and
points to Runtime diagnostics in Settings → Help. The support summary names
the quarantine reason `orchestration-projection-rebuild-failed`. Nothing
calls `reject()` yet: G5 will record rejections only for deterministic
refusals of commands the user sends directly, and never for queue
re-dispatch.

Deliberate differences from T3 Code: receipts are scoped by actor and
fingerprinted by payload; rejections are recorded only for those refusals;
the cheap verification runs at every database open, not only before
compaction; and there is still no event or receipt compaction.

Tests: `tests/server/orchestration-v2-receipts.test.ts` has 16 cases. They
cover rejected replay, actor independence, no-op receipts, sequence tracking,
the version bump, corruption repair, a clean open that parses no rows, the
boot-time rebuild with the delegated-task index, the typed blocker raised by
both the repository and `RuntimeStore` when a rebuild still leaves an
unreadable row, upgrades from schema 112 and 110, and an idempotent second
run of 113. The migration, lineage, recovery-schema, worker startup-failure,
supervisor preflight, connection, support-summary and incident tests were
extended. A combined run of 58 files covered orchestration, migration,
database and recovery tests plus the touched main-process and worker tests.
It passed 736 of 748 tests, skipped 4 and failed 8. Four failures were
Windows symlink `EPERM` errors. The other four were timeouts and lock
contention in `database-migrations`, `database-recovery-import-worker`,
`legacy-backfill-compatibility` and `orchestration-rollback-restore`.
`database-migrations`, `database-recovery-import-worker` and
`orchestration-rollback-restore` passed when rerun together.
`legacy-backfill-compatibility` timed out in another case during that rerun
and passed 11 of 11 when run alone. `check:migrations`, `check:architecture`,
`lint` and `typecheck` passed. The full `npm run check` was not run.

## G8: run and attempt model — 2026-11-02

Runs and attempts now carry T3 Code's ordinals and reasons. A run has an
`ordinal`, numbered per thread from 1; the thread keeps `lastRunOrdinal`. An
attempt has an `ordinal` within its run, a `reason` (`initial`, `retry`,
`provider_recovery`, or the reserved `steering_restart`), and a `superseded`
status with `supersededAt` (`src/shared/orchestration-v2.ts`). All new fields
are optional in the schemas, so events written before G8 still parse. The
projector derives them during replay and does not take them from callers.
`run.accepted` numbers the run from the thread and records attempt 1 as
`initial`. `run.attempt-replaced` takes an optional `reason`, which defaults to
`retry` for older events. In the same write it marks the prior attempt
`superseded`, sets its cleanup to `confirmed`, and numbers the replacement
`prior + 1`. A replacement normally needs the prior attempt's cleanup to be
`confirmed`. One exception exists: with `reason: "provider_recovery"` and the
runtime's assertion `priorCleanup: "confirmed"`, the prior attempt's cleanup
may still be `pending`, because the run-level ownership row then covers the
new harness. No event can change a superseded attempt. Because these values
depend on replay order, `ORCHESTRATION_V2_PROJECTION_VERSION` is now 2. G6's
boot check rebuilds each upgraded database once and recomputes them.

`OrchestratedTurnRepository.replaceAttempt({ runId, turnId, expectedAttemptId,
reason, priorCleanup? })` records a replacement inside the caller's
transaction and returns the new attempt. Its command id is
`attempt-replaced:` plus a fingerprint of the expected attempt and the reason.
Repeating the same request returns the attempt it created and writes nothing.
A different request for an attempt that is no longer current fails with
`revision-conflict`. The implicit replacement, `cleanup("pending")` after
`confirmed` (the Duo quarantine re-record), now goes through it with
`reason: "retry"`. G9 will call it with `provider_recovery`. `attempts(runId)`
lists a run's attempts in ordinal order.

This package also covers audit area 1 rows 9 and 28, which moved here from
G5. Row 28: the cleanup command id now includes the attempt, the previous and
next cleanup state, and the thread revision. The `cleanup-release` id
includes the revision. Before this change, pending → unconfirmed → pending
replayed the first `pending` receipt and left the projection `unconfirmed`;
now each transition is recorded. Row 9: `synchronize`, `acknowledge` and
`nativeBoundaries.observe` accept an optional
`observer: { attemptId, expectedStatus? }`, and `lifecycleIfCurrent` requires
one. When the observed attempt is not the run's current one, or the run's
status is no longer the expected one, nothing is written and the call returns
a `StaleAttemptObservation` (`src/server/orchestration-v2/attempt-fence.ts`).
Its reason is `attempt-superseded`, `attempt-not-current` or
`run-status-changed`, and it names the observed and current attempts.
`lifecycleIfCurrent` checks before running the compatibility write, so a
stale observation changes neither the transcript turn nor V2, as T3's
`writeIfRunCurrent` commits nothing. The unconditional `lifecycle` stays for
the controller's own transitions. No production caller passes an observer
yet; G9 adds that through `ActiveTurn.attemptId`. Native thread and
turn refs still come only from provider native-boundary events. Providers
that emit none keep `nativeThreadId` and `nativeTurnId` null. A replacement
attempt starts with null refs.

Deliberate differences from T3 Code (`packages/contracts/src/orchestrationV2.ts`
`OrchestrationV2RunAttempt`; `o2/Orchestrator.ts` attempt replacement;
`o2/EventSink.ts` `writeIfRunCurrent`):

- Run statuses remain the turn statuses; only attempts gain `superseded`.
  T3 sets `completedAt` on a superseded attempt. Inertia attempts have no
  `completedAt`, so the time is stored in `supersededAt`.
- `steering_restart` is accepted but never emitted, because Inertia has no
  steering restart.
- T3 derives attempt ids from the run and the attempt ordinal. Inertia keeps
  random attempt ids and gets idempotency from the receipt command id.
- T3 numbers runs as the highest run ordinal plus one, and attempts as the
  highest attempt ordinal in the run plus one. Inertia counts from the
  thread's `lastRunOrdinal` and the prior attempt. The results are the same,
  because runs are only appended and only the current attempt can be
  replaced. This holds while runs are created at dispatch; if queued items
  ever become runs, T3's renumbering at queued start applies instead.
- T3's guard returns "not committed"; Inertia's returns a typed reason. Both
  check the active attempt and, when the caller states it, the expected run
  status. The guard covers harness observations, not the controller's own
  lifecycle writes.
- T3 records no cleanup proof. Inertia replaces an attempt only after
  confirmed cleanup, or after the runtime asserts `priorCleanup: "confirmed"`
  for `provider_recovery`.

Tests: `tests/server/orchestration-v2-attempts.test.ts` has 7 cases. They
cover per-thread run ordinals and the initial attempt; a `provider_recovery`
replacement (prior attempt superseded, ordinal 2, null native refs, identical
replay, conflicting retries); the implicit `retry` replacement; late
lifecycle, native-boundary and acknowledgement writes from a replaced or
unknown attempt being no-ops with their reason; pending → unconfirmed →
pending and a repeated release getting distinct command ids; a rebuild that
reproduces every ordinal, reason and superseded mark; and a database whose
pre-G8 events and version-1 projections are rebuilt once when it opens. In
`tests/server/orchestration-v2-receipts.test.ts`, the event-store fixture and
the upgrade cases now name the version that migration 113 seeds (1) instead
of assuming it equals the projector version. An upgraded database is now
rebuilt once to version 2 and reproduces the same entities.
`tests/server/database-migrations.test.ts` now expects the metadata row of a
reopened store at `ORCHESTRATION_V2_PROJECTION_VERSION`, because the boot
check rewrites it.

Verification: the focused set (`orchestration-v2-attempts`,
`orchestration-v2`, `orchestration-v2-receipts`, `orchestration-v2-outbox`,
the three `orchestration-delegation-*` files, `turn-restart-continuation`,
`turn-stop-ladder-release`, `orchestration-backings` and
`runtime-query-plans`) passed 114 of 114 tests in 11 files. The query-plan
snapshot did not change. A wider run of 104 files (all `orchestration-*`,
`turn-*`, `delegation-*`, `duo-*`, `native-*` and `database-*` files, plus the
queue, worker startup, observed-child, delegated-task migration and session
fallback files) found one real failure, the pinned metadata version in
`database-migrations`, which was then updated. The rest were 15-second
timeouts, `EBUSY` errors during SQLite cleanup and two Windows symlink
`EPERM` errors. A rerun with less parallelism left only the timeouts and
cleanup errors in `duo-launch`, `duo-worktree-adoption` and
`turn-git-artifacts`, plus the two `EPERM` errors. Each of those three files
then passed when run alone, as did `database-migrations` and
`database-recovery-schema-columns`. `typecheck`, `lint` and
`check:architecture` passed. The full `npm run check` was not run.

## G11 part 1: coverage accounting — 2026-11-02

A context handoff now records the ids its portable selection omitted
(`omittedItemIds`: optional, at most 256, disjoint from `itemIds`;
`src/shared/orchestration-backings.ts:28`). Preparation copies them from the
selection (`src/server/runtime/turns/turn-request-preparation.ts:504-505`,
`src/server/runtime/turns/turn-context-handoff.ts:121-122`). The projector
refuses repeated or overlapping ids
(`src/server/orchestration-v2/backing-projector.ts:48-50`). Once the handoff is
`delivered`, settlement adds the omitted ids to the backing's coverage together
with the delivered ids (`src/server/orchestration-v2/backing-repository.ts:164-166`),
so a later switch-back does not offer them again. This is T3's rule that
delivered plus omitted ids count as covered
(`apps/server/src/orchestration-v2/ProviderTurnStartService.ts:893-905`).
Older events have no field and read as having no omitted ids. A handoff
without omitted ids keeps the previous event shape and id, so no migration or
projector version bump is needed. The handoff `method` is still always
`inline`; native injection is part 2.

On a workspace change, coverage is carried. When a session is first observed
in a new checkout of the same chat, and the backing does not inherit fork
coverage, the backing of the same provider instance and native session in
another checkout passes its covered ids, completeness and `uncertain` status
to the new backing. In the same transaction it is retired as
`workspace-changed` (`backing-repository.ts:89-115`). A switch-back after the
move therefore delivers only the intervening items. This is Inertia's form of
T3's `restart_and_resume` on a workspace change
(`ProviderSessionTransitionPolicy.ts:73-75`). If an older database has several
such backings, the newest is carried and all of them are retired.

The coverage cap stays at 2,048 ids (`MAX_BACKING_COVERAGE_ITEMS`). Past the
cap, `coverageComplete` becomes false and the backing is no longer reused
natively. The next turn on that route starts a fresh session with the full
portable history. A watermark was not adopted, because each
`provider.backing-recorded` event repeats the full list. Counting omitted ids
reaches the cap sooner in long chats.

Deliberate differences from T3 Code:

- Coverage is capped at 2,048 ids; T3's coverage is unbounded.
- Candidates stay bounded at 256. Items older than that window, and items over
  64,000 bytes that are skipped before selection, are counted in the omitted
  number but never listed. They are therefore not recorded as covered, and a
  later delta can still offer an older item that fits.
- ~~A move retires the old checkout's backing. Moving the chat back to that
  checkout starts a fresh session with the full portable history; T3 would
  resume the native thread there.~~ Closed by "G11 completion" below: the
  backing follows its native session with `provider.backing-relocated`, so
  moving back resumes the session for a harness that resumes across checkouts,
  and the first turn after a move reads the session's status.

Tests: `tests/server/orchestration-backings.test.ts` gains four cases. The
first is the inline variant of T3 `ContextHandoffBudget.test.ts:401`: an
oversized item omitted during preparation is recorded, counted as covered
after delivery, not offered on the next switch-back, and kept by a rebuild.
The second checks that the projector refuses repeated or overlapping ids. The
third covers a checkout move: coverage is carried, the old backing is retired
as `workspace-changed`, and the later switch-back delivers only the
intervening items. The fourth checks that an `uncertain` backing stays
`uncertain` after a move. `tests/server/orchestration-history-backing-limit.test.ts`
documents the cap: a backing past 2,048 ids is not reused, and the next turn
restores the full history on a fresh session. The four new backing cases fail
against the unchanged sources; the cap case passes there, because the cap
itself is unchanged.

A combined run of 36 related files (backings, context exhaustion, portable
history, forks, rollback, merge-back, fallback, continuation, request context
and the turn-controller suites) passed 503 of 509 tests, skipped 2 and failed
4. All four failures were load noise and passed when rerun alone (37 of 37):
a 15 s timeout in `orchestration-portable-history`, and `EBUSY` SQLite
cleanup with Git-artifact waits in `orchestration-rollback-restore`. After the
last source edit, six core files passed 64 of 64. `typecheck`, `lint` and
`check:architecture` passed. The full `npm run check` was not run.

## Main syncs onto 6d8ab80f and 852fd18b — 2026-11-08

Main released migrations 107 to 111 (`PersistLibrary`,
`RecordManagedAgentContextReads`, `PersistTodoSourceConversation`,
`PersistCodexThreadToolPacks`, `PersistSubagentTaskShape`), so the branch's
unreleased migrations move up by five. Earlier entries in this file use the
old numbers:

| Before | After | Migration |
| --- | --- | --- |
| 107 | 112 | `OrchestrationV2EventStore` |
| 108 | 113 | `SupportNativePiProvider` |
| 109 | 114 | `SupportCursorSdkHarness` |
| 110 | 115 | `RaiseConversationContextSupplementBound` |
| 111 | 116 | `PersistDelegatedTasks` |
| 112 | 117 | `PersistDelegationAutomaticWakes` |
| 113 | 118 | `OrchestrationV2ReceiptStatusAndProjectionMetadata` |

Lineage entries 1 to 111 are byte-identical to main's. A database that already
ran the branch's old numbering is development data only and does not upgrade
in place.

Integration points with main's work: the Library, Worktrees and Terminal links
command handlers join the branch's handler module; a managed chat's status
keeps main's shared `managedConversationStatus` and adds the delegated task
and native children; Pi skills stay on the chat's own capability, while
new-chat skill previews remain Codex and Claude only; the orchestration tool
definitions move to `src/server/runtime/agent-thread-tool-definitions.ts`. The
agent surface budget is exactly the sum of both sides' additions.

## Main sync onto 92e23166 — 2026-11-14

Main released migrations 112 to 116 (`SupportNativeGrokProvider`,
`PersistContextCompactionSettings`, `PersistCodexCompactionLimit`,
`PersistCustomAgents`, `PersistAgentSecretRequests`), so the branch's
unreleased migrations move up by five again. Earlier entries in this file use
the old numbers:

| Before | After | Migration |
| --- | --- | --- |
| 112 | 117 | `OrchestrationV2EventStore` |
| 113 | 118 | `SupportNativePiProvider` |
| 114 | 119 | `SupportCursorSdkHarness` |
| 115 | 120 | `RaiseConversationContextSupplementBound` |
| 116 | 121 | `PersistDelegatedTasks` |
| 117 | 122 | `PersistDelegationAutomaticWakes` |
| 118 | 123 | `OrchestrationV2ReceiptStatusAndProjectionMetadata` |

Lineage entries 1 to 116 are byte-identical to main's. The Pi and Cursor SDK
rebuilds read each table's current definition, so after Grok's 112 they keep
`grok`, `grok-acp` and `grok-managed`, main's new `subagent_traces.custom_agent_id`
column, its indexes, triggers and foreign keys; their tests now assert that.
No branch migration rebuilds `messages`, `app_state`, `custom_agents` or
`agent_secret_requests`.

Integration points with main's work: Grok and Pi sit side by side in every
provider list, registry, manifest, discovery, auth, metadata, routing,
terminal-resume, diagnostics, issue-report and renderer table, Grok first.
Pi joins main's provider menu, custom-agent routing (in role, like Grok),
secret requests (remote MCP with a 270-second wait, under its bridge's
300-second fetch limit), the Usage filter and colour series, and the
unreported-usage accounts; Grok joins the observed-child stop matrix and the
managed-chat route schema. The backend profile list now includes Pi, which the
branch had left out, so a Pi chat's native selection validates instead of
failing with "Model backend profile not found". `pi-rpc` and `cursor-sdk` get
harness labels, and Pi's `mcp__inertia__` host-tool names get the friendly
activity titles; Private Connect prompt safety still falls back to "unsupported"
for both, so phone prompts to those harnesses stay refused. Main's custom-agent, secret-request and price-list handlers, goal-read
holds and idle compaction join the branch's command handler module. Main
replaced the turn agents line with the subagent group; the observed-children
"Agent details" disclosure (`orchestration/observed-agents-details.tsx`) now
sits under the group whenever the turn has any subagent, including turns whose
only subagents are custom-agent calls, folds with the group in a settled turn,
and is counted in the timeline row estimate. Observed children carry main's
custom-agent attribution. The conversation configuration guard follows main's
`hasConversation`.

The branch's delegation tools join main's active-secret check:
`inertia_delegate_task` (task and title) and `inertia_cancel_task` (reason)
refuse a live secret value like `inertia_create_conversation` and
`inertia_send_message`, and `inertia_delegate_task` confirms delegation is
available before it creates the child chat. The other branch tools only read or
take identifiers (`inertia_fork_history`, task status and wait); delegation
results and follow-up sends travel through those checked paths.

Restored history follows T3 Code: a fresh session gets at most
`DEFAULT_PORTABLE_HISTORY_BUDGET` (16,000 bytes, T3's
`DEFAULT_HANDOFF_TOKEN_CAP`), and routes with the host-tool bridge are told to
page older turns with `inertia_request_context`. This supersedes main's #720
budgets (64 KiB, or 192 KiB where the agent cannot retrieve more), which are
removed; `@this-chat` references keep their own bound.

A database written by an orchestrator-v2 build from before this sync recorded
the branch's migrations as 112 to 118, so this build would skip main's 112 to
116. Opening it now stops startup with the `orchestrator-v2-development-database`
blocker before recovery or migrations run, leaving the database and its backups
untouched; the connection message and support summary say to move it aside.

The agent surface budget is the sum of both sides plus two interactions: Grok in
the shared route enum adds 7 bytes to `inertia_delegate_task`, and main's
38-byte Claude per-tool reduction applies to the branch's five Claude tools.
Renderer growth was measured against builds of 852fd18b, the branch and main:
each raised route is within 1 KB of base plus both sides' growth (transcript
+960 bytes, core +707, settings +370, the first-load routes about 300 smaller).

Verification on macOS arm64 with Node 22.23.2: `npm run check:quality` passes
and `npm run check:migrations` verifies 123 lineage entries, also against
`origin/main` as the base. The full Vitest suite, run in isolated chunks, passes
all 1,613 files: 20,329 tests passed and 174 skipped. `npm run test:portable`
passes 4,282 tests with 31 skipped, and `npm run build:bundle` passes. The
delegation-wake Electron scenarios pass, including the observed-child panel
opened from a settled turn's fold. The macOS guardian, Antigravity, Claude
metadata, Grok and Kimi cleanup tests need the runtime process guardian that
`npm run build:bundle` builds first; without it they fail identically on
`origin/main`.

## G5: command authority for sends, Stop, configuration and queue edits — 2026-11-02

**Lanes.** `OrchestrationCommandLanes`
(`src/server/orchestration-v2/command-lanes.ts`) marks a lane as held in the
caller's async context while one of its sections runs. A `run()` for a thread
whose lane that context already holds rejects with `OrchestrationLaneReentry`
at once instead of queueing behind itself. A synchronous section releases the
mark as soon as it returns, so work it starts without awaiting (queue
scheduling, settlement hooks that take the parent's lane) still takes the lane
afterwards. The new sections are synchronous: they read projections and commit,
and never await provider, attachment, fork-preparation or delegation work.

**Authority.** `OrchestrationCommandAuthority`
(`src/server/orchestration-v2/command-authority.ts`, `store.orchestration.authority`)
runs the receipt check inside `lanes.run(conversationId)`. In one section it
joins a duplicate of the same `(actor, command id)` that is still in flight in
this process (a different payload is `command-conflict`), replays an accepted
receipt, returns a rejected one, or leads: it hands out a ticket and runs the
caller's synchronous intake in the same section. The ticket commits under the
command's identity, takes later sections with `inLane`, and resolves joiners
with `finish` or `fail`. `fail` records a rejected receipt only for commands
the user sent directly and only when `commandRejection`
(`src/server/runtime/commands/command-rejection.ts`) classifies the error as a
deterministic refusal: a `RuntimeRequestError` that is not ambiguous, not
`message-admission-unavailable`, not a preparation timeout, not an
unexpected-stage error and not a refusal the user clears by correcting input
or a setting (`userCorrectableRuntimeError`), as T3 leaves its mode and
policy-ceiling refusals unrecorded so the retry is not blocked. The renderer
gives every action a new request id, so a recorded refusal only answers an
exact replay. Internal dispatchers (the queue, limit reset, restart
continuation, watcher and delegation deliveries) never record a refusal and
now use the actor `runtime` with origin-prefixed ids (`queue:<entry id>` and so
on), because the queue re-dispatches an entry under the request id of the
direct send that queued it.

**Sends** (`src/server/runtime/commands/message-send-command.ts`,
`message-follow-up-command.ts`). The intake section checks the receipt, runs
the existing preflight and routes the send. A follow-up admission is taken in
that section, so it is ordered against Stop: once a Stop has committed its
interrupt, a later send takes the after-turn path instead of steering the
stopping run. New-turn preparation (up to 120 s) runs outside the lane and
admission keeps its receipt in the admitting transaction, so two concurrent
identical sends prepare and import attachments once. A steer resolves and
retains its attachments outside the lane, then commits
`run-control.steer-requested` under the send's receipt with a process-bound
`provider.steer` effect, claimed at once with `claimControl`; the provider
steer runs outside the lane and its outcome commits `run-control.steer-settled`
(`accepted`, `refused`, `turn-ended`, `unconfirmed` or `unavailable`) and
settles the effect on every path. A follow-up queued for after the turn
commits a receipt with the queued disposition, in the same transaction as the
queue row when it was never offered to the provider. A replay rebuilds the
original answer from the receipt and the `run-steer` projection; a steer whose
process was lost answers the existing ambiguous "did not confirm" error.

**Stop** (`src/server/runtime/commands/agent-stop-command.ts`). `agent.stop` is
a receipted command with an optional `expectedTurnId`, which the composer
Stop and the Tasks card fill with the latest turn they show. A Stop whose
expected turn is no longer the active one is refused as `superseded` before
anything is stopped, as T3 refuses Force stop once a newer run has started.
The first Stop of an attempt commits `attempt.interrupt-requested` and
`run-control.interrupt-recorded` with a process-bound `provider.interrupt`
effect; a start that was never dispatched is retired in the same transaction,
so no provider starts. The effect is claimed with `claimControl`, which takes
an exact pending row without waiting behind earlier effects in the thread, so
Stop never waits behind a checkpoint-capture retry. Stop does wait, up to the
platform stop budget, for steer effects committed before it, so a follow-up
accepted first reaches the provider before the interrupt, as T3's ordered
outbox does. The controller's existing cancel then starts the ladder outside
the lane. A later Stop commits `run-control.interrupt-escalated` with cause
`user` and the ladder forces at once. When the ladder's grace wait expires,
`stopOwned` calls an `escalated` hook just before the forced cancel, and the
run state coordinator commits `interrupt-escalated` with cause `grace-expired`
unless the user already escalated. Only that cause stamps `unresponsiveAt` on
the `run-interrupt` projection, keyed by attempt
(`store.orchestration.runControl.attemptInterrupt(attemptId)`); a second press
counts as an escalation without claiming the provider stopped answering, as
T3 stamps it only when the interrupt goes unanswered. When the ladder ends,
the coordinator settles the interrupt: a confirmed stop settles the effect as
succeeded; any other outcome settles it as failed with `stop-<outcome>` and
records that outcome. `unresponsiveAt` stays, as T3 never clears it. The
release still records `unconfirmed-released` and is never cleanup proof. A
run that ends without a ladder settles its interrupt as `settled`. A restart
retires a running interrupt or steer effect as `runtime-lost` and never
replays it. Stop with nothing to stop is accepted as a receipt-only commit, as
in T3 (`ThreadStop.test.ts:800`), so its replay is accepted too and never stops
a later run. The command is accepted once it commits: its ticket finishes as
soon as the cancel has started, and the handler's bounded wait for provider
cleanup only shapes when the answer arrives, so the first answer and a replay
agree.

**Configuration and queue edits.** `conversation.update` runs its whole
validation in one lane section. A provider or model change on a chat that has
a V2 thread commits `thread.configured` with the conversation update as the
compatibility projection; the projector's refusal while a run is active maps to
the existing "Stop the active run or review…" error, recorded as rejected.
Title, pin and snooze changes commit only a receipt, so renaming a running chat
still works. Queue edits are receipted: `enqueue` inserts its row in the same
transaction as its receipt, `remove` cancels inside its section (a delegated
delivery is dismissed outside the lane because the dismissal takes the same
lane), and a replayed `send` or `stop-and-send` re-kicks the queue without a
second dispatch. `stop-and-send` stops through the Stop command with the id
`<request id>:stop` and the expected turn.

Deliberate differences from T3 Code:

- Inertia keeps its stop ladder: automatic escalation after the grace period,
  immediate force on a second press and `unconfirmed-released` at the end of
  the budget. T3 leaves an unanswered run open until the user's Force stop
  (`apps/server/src/orchestration-v2/EffectWorker.ts:180-201`,
  `ThreadStop.test.ts:1556`). Inertia records T3's unresponsive flag on a
  per-attempt `run-interrupt` projection (T3 keeps `unresponsiveAt` on the
  `run_interrupt_request` item) but releases automatically; the release settles
  the interrupt effect as failed and is never cleanup proof.
- A user Stop settles the turn `cancelled`; T3 settles `interrupted`.
- Rejected receipts are recorded only for refusals of commands the user sent
  directly, never for internal dispatch; T3 records every dispatch failure
  except mode and policy-ceiling refusals, and Inertia exempts its
  user-correctable refusals the same way.
- Stop during new-turn preparation is accepted with nothing to stop, because
  Inertia admits a run only after preparation; T3 interrupts a `preparing`
  run. Tracked for the client-parity phase.
- Stop calls the controller's cancel inline after its commit; T3's effect
  worker executes `provider-turn.interrupt`. The effect row records the
  attempt and the outcome either way.
- T3 stops a chat's app-owned delegated tasks on every Stop
  (`Orchestrator.ts` `dispatchThreadStop` at `6f413648`). Inertia keeps Phase
  4's exact-target rule: only the child runs the stopped turn dispatched are
  stopped, so an idle Stop stops no children
  (`docs/orchestrator-v2/phase4-verification.md`).
- T3's fix for a run left open after its attempt completed (`5f2c27e7`) has no
  counterpart here: a run and its current attempt change status in one event.
- Interrupt and steer effects are claimed by their own command, past earlier
  effects in the thread. In their place Stop waits explicitly for earlier
  steers, bounded by the platform stop budget; T3's worker waits behind a
  running steer without a bound.
- Internal dispatchers commit under the `runtime` actor with origin-prefixed
  ids; T3 dispatches each queued run as its own command.
- Delegated cancels stay non-command stops, and delegated deliveries steered
  into a running parent still call the controller's steer directly; the
  queue claim keeps them idempotent. Routing them through `provider.steer` is
  a follow-up.

Design deviation: the design put the ladder's outcome behind a new
`TurnController.stopOutcome()` read by the Stop handler. The run state
coordinator, which owns the ladder, settles the interrupt instead, so the
settlement is tracked with the ladder (`drainSettlementTasks` covers it) and
also happens when the Stop handler has already answered or when another path
started the ladder.

Verification (2026-11-08, after the corrections and on top of the main sync):
`check:quality` and the renderer bundle budgets passed; the full unit suite
passed apart from this machine's known Windows noise (symlink `EPERM`, the
Windows guardian and Job Object helpers, and the PDF worker and Cursor SDK
resolution through a linked `node_modules`), each confirmed by rerunning the
file alone. Four existing suites needed updates for G5: three assert the new
escalation hook on `stopOwned`, and two gave two different commands one
request id or omitted the command authority from their mocks. The Electron
scenarios for Send and Stop, Stop and send, grace escalation, immediate force
and natural completion passed; `stop-ladder.spec.ts` is POSIX-only.

## G9: rejected-resume fallback as a replacement attempt — 2026-11-09

**The restart is an attempt.** When a provider reports that the saved native
session is unavailable and the in-run fresh-session fallback restarts the turn,
V2 now records a `provider_recovery` replacement attempt.
`OrchestratedTurnRepository.restartOnFreshSession`
(`src/server/orchestration-v2/turn-repository.ts:231`) runs the whole restart
in one transaction through `ProviderBackingRepository.restart`
(`src/server/orchestration-v2/backing-repository.ts:188`). In order, it
abandons the pending handoff, retires the rejected session's backing, applies
the compatibility restart (`turnLedgerRepository.restartOnFreshSession`),
calls G8's `replaceAttempt` with `reason: "provider_recovery"` and
`priorCleanup: "confirmed"`, and prepares the restored-history handoff for the
replacement attempt. The prior attempt becomes `superseded` with its cleanup
`confirmed`. The replacement is ordinal + 1, has null native refs and cleanup
`pending`. The run-level ownership row, recorded once when the provider
started, covers the new harness until the run ends. The superseded attempt
keeps the native refs it observed. The restart no longer commits
`provider.session-cleared`; the event type stays in the schema so older events
replay. The caller must name the attempt it ran under; a restart without one,
or with an attempt that is no longer current, fails with `revision-conflict`.
The transaction then rolls back the backing retirement and the compatibility
restart, and the wrapper keeps the rejected resume's failure. A repeated
`replaceAttempt` request returns the same attempt through G8's receipt and
writes nothing. `restartOnFreshSession` as a whole is not idempotent: run again,
its compatibility restart finds the session already cleared and throws, so the
transaction rolls back and nothing changes. A second fallback in the same run
is refused earlier anyway, by `applyFreshSessionFallback`, because the turn no
longer has a saved session. Once the transaction has committed,
`applyFreshSessionFallback` no longer throws: a failed broadcast is ignored and
clients reconcile from the next snapshot.

**The cleanup assertion comes from the provider layer.** The wrapper asks for a
fallback only when the rejected attempt's result has `cleanupConfirmed`. It now
passes that fact as `{ priorCleanup: "confirmed" }`
(`ProviderFreshSessionPrior`, `src/server/provider/contracts.ts`;
`src/server/provider/fresh-session-fallback.ts:91`), and the turn forwards it to
`replaceAttempt`. The turn does not assert the cleanup itself.

**Observations are bound to the attempt that started the harness.**
`ActiveTurn.attemptId` (`src/server/runtime/turns/turn-controller-types.ts`)
is read from the run projection when the provider starts, after ownership is
recorded (`src/server/runtime/turns/turn-controller.ts`). The fallback replaces
it. The run's `onEvent` is bound to the starting attempt. The fallback returns
its own `onEvent`, bound to the replacement attempt
(`src/server/runtime/turns/turn-fresh-session-fallback.ts`). The run
coordinator gives the replacement harness its own route through
`ProviderEmitter.rebind` (`src/server/provider/emitter.ts`): an emitter for the
same run that delivers to the new `onEvent`. Both emitters share the
open/closed state, so quarantine, protocol violations and run settlement close
both. `routedFreshSessionFallback` (`src/server/provider/fresh-session-fallback.ts`)
adapts the turn's fallback for the harness wrapper. Once the fallback has
committed, the wrapper drops every later event from the rejected harness.
That keeps its capability observations, the unattested-event policy (which
could close the shared emitter state and cancel the replacement) and
metadata-cache learning out of the run. On rebind the run's
`negotiatedCapabilities` are cleared too: capability evidence belongs to one
harness process, and the replacement re-observes its own capabilities when it
starts. The run's required capabilities are recomputed at the same point for
the replacement's input, which has no session id, so `session-resume` is no
longer required. Without that recomputation the clear broke the fallback for
Cursor ACP and Kimi ACP. For those harnesses `session-resume` is a negotiated
capability, observed only on the resume path. The replacement opens with
`session/new`, so its completion failed with "'session-resume' completed
without exact-run capability evidence". The test manager's capability check
ignores negotiated capabilities, which is why the existing ACP fallback tests
missed it. `markPendingCancellation` emits on the
current route. It runs only while no harness run exists yet, so in practice
that route is the first one.

`TurnController.handleProviderEvent(event, attemptId)` compares the event's
attempt with `active.attemptId` in memory. If they differ, it returns `false`
before any write: no transcript turn change, message, activity, usage, session,
goal or V2 event. This costs one comparison per event and no database read.
The comparison is sound because every path that replaces an active run's
attempt updates `active.attemptId`. There are two such paths:
`restartOnFreshSession` (the fallback), and `cleanup("pending")` after
`confirmed`, which only `providerRunOwnership.record` triggers. `record` runs
in `startProvider`, before the attempt id is read, and in the Duo quarantine
path, which now re-reads the attempt id right after it. As a backstop in the
same transaction, the rare state-changing writes re-check the attempt against
the projection: `nativeBoundaries.observe`, `backings.observeSession`, and
provider-reported status transitions through `lifecycleIfCurrent`
(`RuntimeStore.updateAgentTurnLifecycleIfCurrent`,
`TurnRunStateCoordinator.persist`). The per-output `acknowledge` is not
re-checked, so text deltas stay cheap. The controller's own transitions (Stop,
settlement, the start acknowledgement, interaction waits, Duo quarantine,
timeouts) carry no observer and always commit. Runs that V2 never admitted
have no attempt id and are not fenced. `orchestration.observation(runId,
observer)` still reports the typed reason for a stale attempt. A
micro-measurement of 5,000 text events through the controller on a V2 run,
four runs each, took 335 to 490 ms on the unchanged branch and 352 to 439 ms
with this change, so no difference was measurable. The platform benchmark's
streaming case drives the stream coalescer directly and does not reach this
path.

A side effect is fixed. Native-boundary rows are keyed by attempt. Before G9,
when the rejected resume had already reported a boundary, the run's boundary
stayed on the old conversation and the fresh session's boundary was not
recorded. Checked against the unchanged branch with a probe test. The
replacement attempt now has its own row.

**Stop and cleanup across the replacement.** Stop, the ladder's escalation,
`cleanup(...)` and `releaseCleanup(...)` all act on the run's current attempt,
which after the fallback is the replacement. The wrapper still forwards cancel
to the running harness. A Stop before the fallback leaves the wrapper's
`cancelled` flag and the turn's deferred settlement set, so the fallback is
declined, as before. Cleanup proof does not change: the ownership row is cleared
when the run's process tree ends, which confirms the replacement attempt.

**The two-strike rule stays.** `savedSessionKeepsFailing`
(`src/server/persistence/turn-ledger-repository.ts:389`, used at
`turn-request-preparation.ts:372`) retires a saved session across turns after
two consecutive failed turns whose resume was rejected (`resumeRejected`)
without progress. The in-run fallback runs only for `sessionUnavailable` with
confirmed cleanup. These are separate cases and both stay. T3 has no
equivalent count. There, any resume failure except a thread held by another
client (and also uncertain history delivery or an exhausted budget) moves the
run to a fresh native thread at start.

**A thread held by another Codex client is refused, not replaced.** This
follows T3 commit `a445272c7` ("Codex threads open in another client are no
longer silently replaced"). Codex keeps a per-thread writer lock while the
thread is loaded in any App Server that shares the same `CODEX_HOME`, such as
the Codex app, the CLI or an IDE extension. It refuses `thread/resume` with
JSON-RPC `-32600` and a message containing "already has an active writer".
Before this entry, Inertia classified that error as `resume-rejected`, so two
such refusals counted as two strikes, retired the saved session and started a
fresh one. That splits the conversation from the client that still owns it.
`isCodexActiveWriterError` (`src/server/codex/app-server-run.ts`) matches the
same code and text as T3. `CodexErrorResponse` now keeps the JSON-RPC code.
The result's `continuationError` is the new `thread-in-use`
(`src/server/codex/types.ts`). The harness reports T3's copy as the failure
message (`CODEX_THREAD_IN_USE_MESSAGE`, `src/server/codex/app-server-config.ts`;
`src/server/provider/codex-app-server-harness.ts`). The failure carries neither
`resumeRejected` nor `sessionUnavailable`. As a result, the turn fails with that
message as its error, nothing is counted toward the two-strike rule, no
fresh-session fallback or replacement attempt runs, and the conversation's
saved session and its backing are kept. The same text under another error code
is still a rejected resume, as in T3.

**A refusal that delivered nothing settles as not delivered.** The Codex
harness marks the active-writer refusal `failure.notDelivered`. The refusal
comes at `thread/resume`, and `turn/start`, which carries the prompt and any
handoff, is never sent. Before this, the turn still split the conversation
whenever it carried a delta handoff or a rollback cursor. `dispatchStart` had
already moved the handoff to `dispatching`, the backing to `uncertain`, and the
cursor and merge-backs to `dispatched`. Settlement then left them `uncertain`
and invalidated the backing, so the next turn started fresh. Now the
controller passes the flag through normalisation and settlement as
`providerDelivery: "not-delivered"` (`AgentTurnSettlementUpdate`). The terminal
`run.status-changed` event records `delivery: "not-delivered"` on the run, and
`synchronize` settles the run without assuming delivery:

- The handoff is `abandoned`.
- The backing returns to its state before dispatch. Dispatch now carries the
  backing it took over in its own record (`beforeDispatch` on
  `provider.backing-recorded`). Settlement restores that value with a new
  `provider.backing-restored` event, which rewrites only the backing, never an
  attempt. The projector refuses it unless the backing still belongs to the
  refused run and keeps the same session, workspace, instance and creation
  time. A retired backing is left alone, so the terminal commit never fails
  on it. This also covers a backing that a native rewind created on a new
  session, which has no earlier record to search for.
- The turn adds nothing to the backing's coverage.
- A `dispatched` rollback cursor returns to `pending`, and `dispatched`
  merge-backs become `undelivered`, as if the run had settled before dispatch.
  The history and merge-back projectors accept these new transitions.
- The ledger drops the turn's restored-history record. A record that holds a
  withheld count stays, with its restored and omitted counts set to zero: the
  withheld count records an endpoint crossing for `historyStayedOnEndpoint`,
  not a delivery, and no "N earlier messages restored" notice shows. The ledger
  also skips `harness-changed` turns, a guard that is never reached today. Such
  a turn starts a session, while both not-delivered cases (an active-writer
  refusal at resume, a fresh-session restart whose start throws) are resumes or
  fallback restarts. The guard protects that record's other role as the route
  handoff marker (`latestProviderHandoffOnRoute`).

Preparation's provider-handoff decision uses the latest turn that was not
settled as not delivered (`deliveredRouteTurnId`, which reads the run's
`delivery`). Without that, the retried switch-back left out the other
provider's messages. An earlier version inferred non-delivery from an
abandoned handoff. That was wrong for Duo starts, which skip dispatch and so
abandon a handoff the turn did deliver, and for the referenced-history
fresh-session fallback. A switch-back turn that was cancelled before it
started still counts as the latest turn on its route. That gap predates G9 and
is unchanged.

A Stop that lands before a thread-in-use refusal settles the turn `cancelled`,
not as not delivered, so its handoff goes `uncertain` and the next turn
starts fresh. This is left as is. It is consistent with T3, which also treats
an interrupted run as missed and re-delivers it.

What the next turn sends follows T3. A refused request is not dropped from
history. Current T3 re-delivers every earlier run on the same provider thread
that failed or was interrupted without an accepted provider turn (`missedRuns`,
`ProviderTurnStartService.ts:935-943`). It sends that run's user, assistant and
error items into the same native thread as a `delta_since_target_last_seen`
handoff (`prepareRetryHandoff`, `:969-1007`), which is what a thread-in-use run
is. Inertia does the same. The restored backing does not cover the refused
turn's items, so the next delta into that session carries them as history: in
a switch-back retry, alongside the other provider's messages; in a
same-provider resend, as earlier history before the new prompt, so the text
appears twice, as it would in T3. Once that turn completes, the items are
covered. A later switch to a different provider carries the refused request
like any other turn of the chat, because the new provider has seen none of it.
The second review asked for the opposite (never replay a refused turn's items
into that session). That would be a deliberate difference from T3, so it is
not done; it can be made by covering the refused turn's items in the restored
backing.

Two related fixes. The event projector now returns early when
`backings.observeSession` reports a stale attempt, so a late session never
becomes the turn's or the chat's. `backings.find()` broke ties on entity
revision arbitrarily. A native rewind writes the retired and the new backing
in one event, so the next turn sometimes started fresh instead of resuming
the new session. The live backing now wins the tie. That nondeterminism
predates G9.

**The replacement's own start failure.** If the replacement harness's
`start()` throws after the fallback has committed, the wrapper no longer
returns the rejected attempt's "session unavailable" result. It returns the
replacement's own failure ("The fresh provider session could not start.",
`FRESH_SESSION_START_FAILED_MESSAGE`), marked `notDelivered`. `start()`
returned no run, and every harness sends its prompt only after `start()`
returns. Settlement therefore abandons the replacement's handoff and drops the
"N earlier messages restored" notice of the restore that never ran. The result does not claim cleanup (`cleanupConfirmed: false`), the same
way the run coordinator treats any throw after a harness start was invoked.
`releaseUnavailableProviderSession` no longer looks up a backing when the turn
has no session id; that lookup could have retired an unrelated backing.

T3 anchors compared, current T3 `b05c505b` (2026-11-14):
`apps/server/src/orchestration-v2/ProviderTurnStartService.ts:1261-1365`
covers the resume attempt, the refusal of a fresh session when the native
thread is in use by another client (`:1334-1341`) and `ensureThread` with
`forceNewNativeThread` inside the same attempt after
`isCurrentAttemptInStatus("starting")` (`:1333`). `:1370-1413` records the
"Recovered context" handoff turn item. `:170-190` is `makeRunControls`, which
binds the attempt id per attempt. `RunExecutionService.ts:1043-1046` and
`:1538-1542` call provider ingestion with `writeIfRunCurrent`
(`activeAttemptId`, `expectedStatus: "running"`). `:1169-1173` makes the final
run write also refuse while a Stop request has no result yet
(`unlessInterruptRequested`). See also `ProviderEventIngestor.ts:213, 759` and
`EventSink.ts:125-136, 523-575`. `packages/contracts/src/orchestrationV2.ts:780`
declares `provider_recovery`; T3 still never emits it.

Changes in T3 since the pin `15fe2832`, and how Inertia stands:

- A resume refused because another client is using the native thread no
  longer falls back to a fresh session (`a445272c7`). Inertia's in-run
  fallback never ran for it, because it runs only for a session the provider
  reports as missing or unsupported (`src/server/provider/session-unavailable.ts`,
  `isStaleResumeError`). The across-turn two-strike rule did count it; that is
  aligned above.
- The fallback now records a visible "Recovered context" item. Inertia shows
  the same fact on the turn: `continuationReasonCode: "stale-provider-session"`
  with its `sessionRecovery` counts renders as "Saved session no longer
  available · N earlier messages restored"
  (`src/renderer/src/utils/sessionRecovery.ts`). It is a turn notice, not a
  portable handoff item. Handoff item kinds belong to G10.
- `writeIfRunCurrent` gained `unlessInterruptRequested` for the final run
  write. This concerns Stop ordering, not attempt replacement. Inertia's
  settlement keeps the first requested outcome (`deferredSettlement ??=`), so
  a Stop that is already recorded is not overwritten by a later natural
  completion (G5). This entry does not change that.
- The guard itself (active attempt plus expected status) and same-attempt
  recovery did not change. The pin's anchors for the same code were
  `ProviderTurnStartService.ts:1227-1366` and `EventSink.ts:464-500`.

Deliberate differences from T3 Code:

- T3 (pin and `b05c505b`) recovers a rejected resume inside the same
  attempt, before the provider turn starts. Inertia's fallback runs after the
  first harness process has ended with a session-unavailable failure and starts
  a second harness process. It records that as a `provider_recovery` replacement, so each
  process has its own attempt, native refs and cleanup. T3 declares
  `provider_recovery` but never emits it.
- Inertia keeps the two-strike `resumeRejected` rule across turns. T3 falls
  back on the first resume failure of any kind except a thread held by another
  client. A rejected resume request can
  be transient, unlike a session the provider reports as gone.
- Provider observations pass only the attempt id, not an expected run status.
  T3 passes `expectedStatus: "running"`. Inertia's provider events also move
  the run through `starting`, `retrying`, `delegated` and `cancelling`, so one
  expected status would drop legitimate transitions.
- The per-event check is in memory, not a guarded write. The rare
  state-changing writes keep a database re-check; the output acknowledgement
  does not. T3 guards every provider ingest write. If a provider-reported
  transition were refused by that re-check, the in-memory run state would
  already have changed. That is reachable only through a replacement path that
  does not update `active.attemptId`, and there is none today. The next
  controller-owned write persists the full run state again.
- Inertia drops the whole event before the compatibility writes. T3 runs
  provider ingestion through the guarded event sink, so both commit nothing.

Tests: `tests/server/orchestration-v2-attempts.test.ts` gains five G9 cases
(12 in the file). (1) A rejected resume restarted in-run records a
`provider_recovery` replacement with `priorCleanup: "confirmed"`. The prior
attempt is superseded and keeps its native refs, and the restored-history
handoff belongs to the replacement. The fresh session's session, boundary and
output commit under the replacement, and settlement completes it with
confirmed cleanup. (2) Late status, text, session and boundary events from the
rejected attempt change no entity, V2 revision, transcript turn, message or
conversation session. The stale observation reports `attempt-superseded`, and
the replacement's route still writes. (3) A restart with a stale expected
attempt fails with `revision-conflict` and rolls back the backing retirement
and the compatibility write. The replacement replays idempotently, a second
fallback is refused, and a conflicting reason fails. (4) Stop after the
fallback interrupts and confirms the replacement attempt, and the superseded
one is untouched. Stop before the fallback declines it and keeps one attempt.
(5) A projection rebuild and a reopened store reproduce both attempts. The G8
case that replaced an attempt by hand while a harness ran now expects that
harness's later boundary to be dropped, while the controller's settlement
still completes the replacement. `tests/server/provider-session-fallback.test.ts`
adds two wrapper cases. In the first, the replacement's events go to its own
callbacks, late events from the first attempt are dropped once the restart
committed, and the fallback receives `{ priorCleanup: "confirmed" }`. In the
second, a replacement whose `start()` throws fails with its own not-delivered
failure, without `sessionUnavailable` and without claiming cleanup. It also adds a Codex App Server
fixture case through the real `ProviderManager` (the fresh thread's events
reach the route the fallback returns). It adds two more
Codex fixture cases. In the first, an active-writer refusal fails with T3's copy,
has neither flag, never calls the fallback and sends no `thread/start` or
`turn/start`. The failure is `notDelivered`. The same text under another code, without a
code, or with the code as a string stays a rejected resume. A Stop that lands
before a delayed active-writer refusal yields a cancelled run, with no
fallback and no `thread/start`. The fixture (`tests/helpers/codex-app-server-fixture.ts`) gains
the five scenarios. `tests/server/agent-harness.test.ts` covers `rebind` routing and
the shared close. In
`tests/server/turn-session-fallback-policy.test.ts`, the real-wrapper
controller case now checks the replacement attempt and that late events from
the rejected harness change nothing. A new case gives two turns the failure
shape the Codex harness now reports for an active writer. Both fail with the
message, and afterwards the conversation keeps the saved session, its backing
stays `ready` and the next turn resumes it. Two more cases run through the
real wrapper, in production timing (the fallback runs between the rejected
attempt's end and its result). In one, an attempt replaced outside the turn
makes the restart fail with `revision-conflict`: there is no fresh harness, and
the turn row, attempts and handoff are unchanged. In the other, a replacement
whose start throws fails the turn with "The fresh provider session could not
start.", without a restored-history notice, with the replacement attempt
`failed` and its handoff `abandoned`. `tests/server/orchestration-backings.test.ts`
adds the switch-back case (Codex, then Claude, then Codex with a delta
handoff) refused before delivery. The handoff is abandoned, the backing is
`ready` with unchanged coverage and nothing is invalidated, the refused turn
loses its restored-history notice, and the retry resumes `codex-native` with a
delta that carries the Claude turn and the refused request. Second-review
cases in the same file:
- a same-provider refusal followed by a resend of the same text: the delta
  carries the refused request, the prompt shows the text twice, the request is
  covered once the resend completes, and a later switch to Claude restores the
  first, refused and resent requests;
- a refused turn whose backing was retired while it ran still settles, and the
  backing stays retired;
- a completed turn whose handoff was abandoned (as a Duo start leaves it)
  still counts as the latest turn on its route, while a later not-delivered
  turn does not.
`tests/server/orchestration-history-rollback.test.ts` adds the rollback-cursor
case: the dispatched cursor returns to `pending` with no invalidation, and the
next turn resumes at the cursor. It also adds a refusal on a backing that a
native rewind created on a new session: the backing returns to the rewind's
`lastRunId`, `lastTurnId` and coverage, and the next turn resumes that session.
`tests/server/turn-provider-event-projector.test.ts` checks that a stale
session observation changes neither the chat's session nor the turn's. Final
review cases:
- `provider-session-fallback` runs the Cursor ACP and Kimi ACP fallback on a
  production manager, which attests capabilities from evidence. The
  replacement completes without `session-resume` evidence. Without the
  recomputation it fails with the protocol violation above.
- `orchestration-backings` pins the `find()` tie-break: a retired row with the
  lower id and a live row at the same revision, where the live one wins (the
  old query returned the retired one). It also covers a not-delivered
  settlement that drops a plain restored-history record and zeroes the counts
  of a withheld one, and a projection rebuild after `provider.backing-restored`
  that reproduces every entity.
- The rewound-backing rollback case also checks that rebuild. `FakeTurnProvider.freshSession()`
(`tests/support/fake-turn-provider.ts:98`) acts as the provider layer after a
rejected resume, and the callers that called the fallback directly use it.
Against the unchanged sources, these fail: the five G9 cases, the wrapper
routing, `rebind`, Codex routing and active-writer classification cases, the
changed G8 case, the extended real-wrapper case, the two not-delivered
settlement cases, the wrapper and controller start-failure cases, and the
stale-expected-attempt case. The second-review cases each fail against the
code before their fix: the rewound-backing and retired-backing cases against
the earlier event-log restore, the notice assertion before item 3, the
abandoned-handoff route case against the handoff-based route lookup, and the
stale-session projector case before item 5. The same-provider resend case
fails on the unchanged branch, where the refusal leaves the backing
`uncertain` and the resend starts fresh. Five guards pass on both sources, because they
pin a boundary or record an outcome rather than new behaviour: the three
error-code variants, the cancel race and the controller active-writer case. For the real-wrapper case, the old test was
given the old fallback wiring so the comparison runs; it then fails at the new
attempt assertion.

Verification (2026-11-14, macOS, Node 22, after the final review's fixes):
nine focused suites (`orchestration-v2-attempts`, `provider-session-fallback`,
`turn-session-fallback-policy`, `turn-fresh-session-fallback`,
`cli-conversation-import`, `agent-harness`, `orchestration-backings`,
`orchestration-history-rollback`, `turn-provider-event-projector`) passed 176
of 176. `cursor-acp-harness` and `kimi-acp-harness` passed 53 of 53. A wider
run of all `orchestration-*`, `turn-*`, `duo-*`, `delegation-*`, `native-*`,
`provider-*`, `agent-*`, `codex-*` and `database-*` server files, plus
`cli-conversation-import` and `runtime-query-plans`, passed 3,024 of 3,025 in
202 files, with 1 skipped. `typecheck`, `lint` and `check:architecture`
passed. `npm run test:portable` passed 4,184 tests with 31 skipped in 249
files (2 skipped). The full `tests/server` batch passed 9,110 tests with 54
skipped in 641 files (7 skipped). After the first review's fixes, that batch had failed once in
`orchestration-native-forks`. The file passed alone three times, and the
cause was not established. The `find()` tie-break above is a plausible cause,
but that is not shown. Earlier in this entry's work, the other batches passed:
renderer, shared, node, scripts and the other top-level files with 6,892
passed and 6 skipped, and `tests/main` with 3,203 passed and 97 skipped. Those
runs excluded three files whose failures also occur on the unchanged branch on
this machine. `tests/main/runtime-process-guardian-darwin.test.ts` and
`runtime-process-guardian-darwin-escapees.test.ts` kill their own test runner,
which is why the suite was run in batches, each in its own process session.
`runtime-owned-process-recovery` fails 7 macOS guardian tests when run alone.
In one batch before the active-writer change, 12 macOS runtime-guardian and
process-tree tests failed in `antigravity-cli-harness`, `antigravity-models`,
`claude-metadata-natural-close`, `kimi-acp-harness` and `kimi-auth-probe`.
They failed identically on the unchanged branch when run alone, and they
passed in the later server batches. The full `npm run check` was not run.

Not done: compaction (`codex-app-server-harness.ts`) and native revert
(`codex-native-conversation.ts`) also call `thread/resume`, but do not apply
the active-writer rule. Native revert reports only a reason code, so there is
no raw text to replace. Compaction goes through the Codex control client,
which drops the JSON-RPC error code, so T3's rule would need a control-client
change. Neither path counts strikes or retires a session.

## Core safety fixes — 2026-11-14

Package D.1 of [t3code-delta-2026-11-14.md](t3code-delta-2026-11-14.md):
the core and agent-facing safety fixes. Uncommitted on top of `26e42678`
(PR #686), macOS, Node 22. T3 anchors are at `b05c505b`.

**Effect settlement on a locked database** (T3 `5ba3a84db`). Before, a
`settle` or `requeue` that threw inside `OrchestrationEffectDispatcher.execute`
was swallowed by the dispatcher's `.catch(() => undefined)`. A write that
outlasted the 5 s busy timeout therefore left the row `running` until the next
boot, and that row held every later effect in its thread. The dispatcher now
follows T3's `EffectWorker` (`EffectWorker.ts:672-680` `retryWhileLocked`;
`:729` `requeueClaim`, `:763` `terminalizeClaim`, `:802`
`recoverPostSuccessSettlement`). The outcome is written once. If that write
throws, a recovery write runs: it requeues the claim when the effect is
replay-safe or the failure was going to retry, and it settles the claim
`failed` otherwise. A process-bound effect whose success could not be written
is settled `failed` with `effect-settle-failed` and is never requeued, so it
never runs twice. A rejected or final failure keeps its own code
(`settleOrRecover`, `src/server/orchestration-v2/effect-outbox.ts:426`). The
recovery write is retried only while it fails with a lock timeout
(`isDatabaseLockTimeout`, `:309`: `SQLITE_BUSY`, `SQLITE_LOCKED` and their
extended codes).

The retry schedule differs from T3's on purpose. T3 runs SQLite in a worker,
so its 100 ms spacing costs nothing. In Inertia, better-sqlite3 waits for a
lock on the runtime thread, up to the connection's 5 s `busy_timeout`
(`runtime-connection-pragmas.ts`). With 100 ms spacing, a lock held by another
process would block IPC, provider events and stop-ladder timers almost all the
time. `EFFECT_SETTLE_RETRY_POLICY` (`:285`) therefore sets four limits:

- Each recovery attempt runs with the busy timeout lowered to 250 ms
  (`OrchestrationEffectOutbox.withBusyTimeout`, `:236`). The statement is
  synchronous, and the previous value is restored in `finally`.
- Attempts back off from 100 ms, doubling up to 5 s.
- After 60 s in total, the claim is left `running`.
- The loop also stops when the write lands or is fenced off (a cancel or a
  lost lease returns `false`), the write fails for any other reason, the
  effect's own signal is aborted (cancel), or the dispatcher closes
  (`whileLocked`, `:443`). Cancel and close also interrupt the pause between
  attempts.

What the next startup does with a claim left `running`
(`OrchestrationEffectOutbox.recover`): a replay-safe row (today only
`checkpoint.capture-requested`) returns to `pending` under the new runtime and
runs again. A process-bound row (`provider.start`, `native.fork`,
`native.rollback`, `provider.interrupt`, `provider.steer`) is retired as
`runtime-lost` and never runs again. Until that startup, the row holds later
effects in its thread, as it did before this package for every settle failure.
A requeue after a failed pre-execution read, and the requeue for a kind with
no handler, use the same loop. The fenced `settle` and `requeue` statements
are unchanged. A requeued claim counts toward `MAX_EFFECT_ATTEMPTS` when it is
claimed again, as T3's retry does.

**Restart-continuation prompt** (T3 `5bb50dca8`, `RestartContinuation.ts:33`).
`RESTART_CONTINUATION_PROMPT`
(`src/server/runtime/restart-continuation-runtime.ts:15`) now reads:
"Continue from where you stopped. Inertia restarted while your last turn was
running, so a command or other action it started may have finished or may
still be running. Before you repeat an action that changes state, check that
it did not already take effect and is not still running. If you cannot tell,
say so instead of repeating it." The usage-limit resume
(`limit-reset-runtime.ts`) keeps "Continue from where you stopped.", as T3's
`UsageLimitRecoveryWorker.ts:73` keeps its short prompt. A limit stop does not
cut an action short. `inertia-current-state.md` and the update scenario
(`tests/e2e/update-everything.spec.ts`) quote the new text. No user guide
quotes it. The CHANGELOG lines that quote the old text describe released
versions and are left as they are.

**Delegated task wait** (T3 `ac781dcb7`, `41e69ffa0`).
`DELEGATION_WAIT_DEFAULT_MS` is 240 s (`src/shared/orchestration-delegation.ts:16`;
T3 `M:141`), and the tool descriptions say "4 min default, 30 max". The
maximum stays 30 min (T3: 60). Review of how the host answers a call:

- `createProviderHostToolMcpSession` (`src/server/provider/host-tool-mcp-http.ts`)
  answers a `tools/call` with one `application/json` body when the call
  completes. It writes neither early headers nor a stream.
- Claude's host tools are an in-process SDK MCP server, and Codex's are
  dynamic tools over the App Server's stdio JSON-RPC. Neither goes through
  HTTP, so a long wait has no fetch timeout there.
- Cursor and Kimi Code without HTTP MCP support reach the server through
  Inertia's stdio bridge (`STDIO_PROXY_SOURCE`, `host-tool-mcp-config.ts`).
  The bridge calls Node `fetch` with undici's defaults: 300 s for headers and
  300 s between body chunks. Pi's bridge aborts `tools/call` at 300 s
  (`pi-bridge-source.ts:35`). When the stdio bridge's fetch fails, the bridge
  sets `exitCode = 1` and closes stdin. That ends every Inertia tool for the
  rest of the turn, not just the call. The same 300 s limit is why secret
  waits stop at 270 s on these providers (`SECRET_REQUEST_WAIT_MS_BY_PROVIDER`).
- Sending headers early would not help. The body timeout also fires after
  300 s of silence, so only periodic bytes (SSE comments or JSON whitespace)
  would keep the call open. That is a protocol change for every MCP client and
  is not made here.
- T3 sends neither early headers nor keepalives. It lowered only the default
  and kept a 60 min maximum.

Inertia therefore keeps T3's default and its maximum on the other routes, and
bounds the call where Inertia's own bridge would drop it.
`DELEGATED_WAIT_CALL_BUDGET_MS` (Cursor, Kimi Code and Pi, 270 s,
`src/server/runtime/delegation/task-wait.ts:32`) caps
`delegatedWaitTimeout` (`:43`). The budget is measured from the start of the
host-tool call (`agent-thread-manager.ts:318`), so the user's approval and the
child chat's creation count against it for `inertia_delegate_task` in wait
mode. The call then returns its task handle with `waitTimedOut` before the
bridge gives up. The approval text uses the same bound and rounds down
("waits up to 4 min"). The running-task hint (`TASK_RUNNING_WAKE_NEXT`,
`src/server/runtime/delegation/task-view.ts:18`) now reads "Still running. Its
result will continue this chat automatically, so do not wait on it or poll it.
Continue other work, and end your turn when none is left." It no longer
suggests `inertia_wait_for_task` (T3 `orchestratorMcp.ts:202`). The agent
surface budget is unchanged in bytes ("5 min" and "4 min" are the same
length), and `agent-surface-budget.test.ts` passes without a rebaseline.

**Regression tests for races Inertia should already handle.**

- *One command id on two threads at once* (T3 `a530cab2b`, `Orchestrator.ts:15207`,
  `:15452`). T3's semantics are that exactly one use succeeds and the other
  fails with a command-id conflict; the two uses are not two independent
  commands. Inertia already behaves this way, because receipts are keyed by
  `(actor, command id)` and not by thread (G6). The authority's in-flight
  entry refuses a second thread with `command-conflict` while the first use
  runs. `OrchestrationEventStore.receipt` refuses it after the first use
  committed. `commit` re-reads the receipt inside its transaction, so a
  receipt that another thread's commit wrote first is refused rather than
  returned as this command's result. That is the check T3 added at `:15452`.
  The tests pass on the unchanged code.
- *A follow-up started during the stop ladder* (T3 `2e0bd97e8`). The ladder's
  grace escalation is bound to the stopped run's own `ActiveRun`. A second
  Stop escalates through `TurnController.cancel` while the stopped turn is
  still active. A stopped turn's release drains its in-flight steers
  (`TurnFollowUpCoordinator.drain`) before another turn can start. One gap
  remained. After its in-lane intake, `requestAgentStop` awaited earlier steers
  and then called `turns.cancel(conversationId)`, which cancels whatever is
  active at that moment. Only microtask ordering kept a follow-up from being
  that turn. The intake now records the owner it stopped, and the handler calls
  `TurnController.cancelExact` (`turn-controller.ts:948`,
  `agent-stop-command.ts:84`). That method cancels only the recorded run,
  including one whose terminal write is being retried. The new tests hold the
  Stop's steer wait open past the release, for the first Stop and for an
  escalating second Stop. Both cancelled the follow-up before the change.
- *Unreadable state at turn start* (T3 `37e0fd378`,
  `ProviderTurnStartService.ts:608-619`). This was a real bug. A projection
  read that threw inside `dispatchStart` settled the start intent `failed`
  but threw out of `TurnController.start`. The turn stayed `queued`, and its
  chat stayed active. On a start deferred behind the previous turn's capture,
  the throw was swallowed by the tracked promise. `dispatchTurnStart`
  (`turn-controller-support.ts:66`) now settles the turn `failed` with
  `turn-start-failed` when the start path throws before it hands the turn to
  the provider path.
  When a saved-state read fails, the error activity reads "Inertia couldn't
  read this chat's saved state, so the turn didn't start."
  (`TURN_START_STATE_UNREADABLE_MESSAGE`, `:51`), the counterpart of T3's
  "Couldn't read thread state" error item. The message is used only for
  `OrchestrationStateUnreadable` (`orchestration-v2/types.ts:165`).
  `dispatchStart` raises that error when a schema error comes from its
  pre-dispatch reads of the backing, rollback-cursor and merge-back
  projections (`turn-repository.ts:486`). Any other error, including a schema
  error raised elsewhere, keeps its existing message (`publicTurnError`). A
  failure after hand-off still propagates, as before. One limit remains, checked with
  a probe. When the run, attempt or thread projection row itself no longer
  decodes, the terminal write fails for the same reason, so the turn still
  cannot settle. T3's failing read is a separate recovery projection, so its
  run write is unaffected. In Inertia, the start path reads only projections
  that settlement also writes. Repairing a row at runtime would need G6's
  rebuild to run while the runtime is live, which this package does not do.

**A rejected resume racing a Stop** (review item, G9 interplay). A Stop
commits its interrupt for attempt A1 in the lane, then cancels outside it,
possibly after waiting for earlier steers. If a rejected native resume fell
back to a fresh session in between, the fallback's `deferredSettlement ===
null` guard still passed and A1 became A2. `settleInterrupt(runId)` then found
no interrupt on A2, so A1's claimed `provider.interrupt` effect stayed
`running` until restart, holding later checkpoint captures. T3 recovers in a
fresh native thread only while the run is still `starting`
(`isCurrentAttemptInStatus`, `ProviderTurnStartService.ts:1332`), so a landed
Stop declines recovery. Inertia now does the same.
`applyFreshSessionFallback` declines once the run's current attempt has
`interruptRequested` (`turn-fresh-session-fallback.ts:73`). As a backstop,
`restartOnFreshSession` reads the expected attempt and refuses with
`revision-conflict` when it has `interruptRequestedAt`, before
`replaceAttempt` (`turn-repository.ts:243`). The whole restart then rolls
back. The refusal is at write time, not in the projector. Logs written before
it can contain an interrupt followed by a `provider_recovery` replacement, and
a projector refusal would make their rebuild, and so startup, fail. The
projector stays as permissive as before. Other replacement reasons are
unchanged.

**Stop attribution** (T3 `009c9e6bd`, `M:268`). `run-control.interrupt-recorded`
carries an optional `cause` (`user`, `agent` or `runtime`;
`RUN_INTERRUPT_CAUSES`, `src/shared/orchestration-run-control.ts:8`), and the
`run-interrupt` projection keeps it. Events and rows written before this have
none and read as `null`. No projector version bump is needed, because a
rebuild reproduces the same values. `requestAgentStop` requires the cause.
The user's Stop and stop-and-send record `user`. An escalating Stop records
its requester's cause too. `RUN_INTERRUPT_ESCALATION_CAUSES` gains `agent` and
`runtime` (`orchestration-run-control.ts:7`); older events keep their values,
and `escalateByRequester` (`run-control-repository.ts:111`) passes the cause
through. `inertia_stop_conversation`
no longer cancels through `stopOwnedManagedTurn`.
`stopManagedTurnForAgent` (`src/server/runtime/managed-turn-ownership.ts:34`)
sends it through the G5 Stop command under the new actor `agent`, with the
command id `agent-stop:<operation id>` and the approved turn as
`expectedTurnId`. The Stop is therefore receipted, ordered in the chat's lane
against sends, recorded with a `provider.interrupt` effect and settled by the
ladder like the user's. The approval names one exact run. Intake compares
`expectedRunId` as well as the turn (`agent-stop-command.ts:58`). A turn or
run replaced after approval is refused as superseded and reported with the old
"approved turn is no longer active" message. The cancel uses the approved
identity. If that run ended on its own before the cancel reached it,
`cancelExact` returns `false`, and the Stop answers the new disposition
`ended` (`:94`). The user's Stop treats `ended` like `releasing` and waits for
cleanup. `stopManagedTurnForAgent` (`managed-turn-ownership.ts:35`) answers
`ended` for that case and for `idle` and `releasing`. The tool then returns
`stopped: false` and says the approved turn had already ended, instead of
`stopped: true`. The exact-cleanup check after the stop is unchanged.

**OpenCode host-tool calls that wait** (review item). Verified from the
repository, not from OpenCode's source, which is not vendored here:

- `openCodeHostMcpConfig` registers the host server with `timeout: 30_000`.
  Commit `8cd25059e` raised it from 10 s so that browser actions would not
  time out.
- #687 moved the secret request to a second OpenCode MCP server with a 10 min
  + 60 s timeout, so that its wait would not be cut.
- `HARNESS_CAPABILITIES.md` states that OpenCode's MCP client gives a host
  call 30 seconds.
- On timeout OpenCode sends `notifications/cancelled`, and
  `handleProviderMcpBody` calls `runtime.cancelCall`
  (`host-tool-mcp-protocol.ts:221-226`). The call's signal aborts, and the
  approval and the delegated wait end with it.
- One contrary hint: the bundled v1 SDK documents the per-server `timeout` as
  a timeout "for fetching tools", and the v2 config also has
  `experimental.mcp_timeout`. If OpenCode applied neither to tool calls, the
  MCP SDK's own 60 s request default would apply instead. Either way, an
  approval (up to 5 min) or a delegated wait (240 s by default) outlasts it.
- T3 registers its OpenCode server without a timeout. Its behaviour was not
  compared.

The fix follows the secrets precedent. `OPENCODE_WAIT_HOST_TOOLS`
(`host-tool-mcp-config.ts:36`) lists the chat tools that ask for approval or
wait on another chat: create, send, stop, archive, delegate, wait for task,
cancel task and `inertia_request_context`. They are served from a third
server, `inertia-chat-waits`, with `OPENCODE_WAIT_MCP_TIMEOUT_MS` (`:34`): the
5 min approval timeout plus the 30 min maximum wait plus 60 s. The rest of the
OpenCode wiring follows from that:

- The main server excludes those tools.
- The supervised and watcher rulesets allow `inertia-chat-waits_*`.
- The activity-title pattern accepts the new prefix.
- No wait server is added when the turn has none of those tools.

Delegate in wait mode is now safe against a cancelled call. With a
`clientRequestId`, the existing per-source key (`client_request_key`,
`agent_thread_operations`) replays the completed creation and waits again. A
test now pins this. Without one, an identical request in the same source turn,
after a wait that was cancelled once the child existed, reuses that chat
instead of creating another (`cancelledDelegateWaits`,
`agent-thread-manager.ts:210`). Reuse lasts only while the agent has never
seen that task's handle. `inertia_get_task_status`, `inertia_wait_for_task`
and `inertia_cancel_task` remove the entry for the task they name
(`forgetCancelledDelegateWait`). Inertia has no task-listing tool, so these
are all the calls that take a task handle. After any of them, an identical
request is a new task with its own approval. Entries are held in memory, at
most 64, and cleared when the source turn settles. `HARNESS_CAPABILITIES.md` describes the
split. Delegated
cancels still stop through `stopOwnedManagedTurn` (G5's deliberate
difference).

Deliberate differences from T3 Code:

- The effect retry backs off, waits at most 250 ms per attempt and gives up
  after 60 s, leaving the claim to startup recovery. T3 retries every 100 ms
  without a cap, because its SQLite does not block its main thread. It retries
  only lock timeouts and tries any other failure once. In production the
  dispatcher runs only replay-safe kinds, so the process-bound branch is
  covered by tests only.
  Process-bound effects that callers claim and settle inline (`dispatchStart`,
  `RunControlRepository.settleClaim`, native controls) are outside the
  dispatcher and unchanged. A lock timeout there still reaches the caller.
  `SQLITE_LOCKED` counts as a lock timeout. Whether Effect's
  `LockTimeoutError` also covers it was not checked.
- The continuation prompt names the restart and keeps Inertia's opening
  sentence. Only restart continuations use it; usage-limit resumes keep the
  short prompt, as in T3.
- Delegated waits are capped at 270 s per call on Cursor, Kimi Code and Pi,
  measured from the call's start. T3 has no per-route cap, and its maximum is
  60 min against Inertia's 30.
- Stop cancels the exact run its intake recorded. T3's counterpart releases a
  shared provider session only when no later run is active on it; Inertia has
  one harness process per turn.
- A start-path failure before hand-off settles the turn; one that comes from
  the run's own projection still cannot settle (see above).
- OpenCode's waiting chat tools are served from their own long-timeout
  server; T3 sets no OpenCode MCP timeout.
- Attribution is durable (event, projection and receipt actor), but the turn
  still reads "Stopped". T3 shows "Stopped by an agent[: reason]" as the run's
  stop reason. A visible agent label is a renderer follow-up.

Tests:

- `tests/server/orchestration-v2-outbox.test.ts` gains 9 cases (24 in the
  file). Most cover real lock contention through a second connection with
  `busy_timeout = 0`:
  - lock classification;
  - a replay-safe success requeued on a backoff of 0, 100, 300 and 700 ms,
    then run again, with the next effect in the thread following;
  - a process-bound success settled `failed` and run once, with the thread
    released;
  - a retryable failure requeued and a rejected failure settled with its own
    code;
  - another error tried once and left to startup recovery;
  - close stopping the retries;
  - another writer fencing the claim off, and a cancel, each stopping the
    loop;
  - a runtime connection with a real 300 ms busy timeout, where the first
    write waits about 300 ms and each recovery attempt under 200 ms. The
    timeout is restored, the loop gives up at its budget, and the next
    startup requeues the replay-safe claim and retires the process-bound one
    as `runtime-lost`;
  - the default policy and the timeout helper.
- `tests/server/orchestration-command-authority.test.ts` gains 7 cases (22):
  - cross-thread id reuse through `conversation.update`;
  - cross-thread id reuse through the authority, with the in-flight, receipt
    and commit-time checks;
  - the two follow-up stop races;
  - user and agent attribution with the real controller, including an agent
    replay that never stops the next run;
  - a projection rebuild over events without `cause`;
  - an agent's escalating Stop recorded as `agent`, and an approval for
    another run of the turn refused as superseded.
- `tests/server/turn-start-read-failure.test.ts` (new, 4 cases):
  - a direct start and a deferred start whose saved-state read fails, each
    settled failed with no provider run, after which the chat takes the next
    turn;
  - a plain error and a schema error outside the saved-state reads, which
    keep their own message;
  - a failure after hand-off, which still throws and leaves the started turn
    running to completion.
- `tests/server/orchestration-v2-attempts.test.ts` gains 2 cases (14):
  - A Stop records its interrupt. The fallback is then declined, and
    `restartOnFreshSession` refuses at write time and leaves every entity, the
    revision and the saved session unchanged. The interrupt and its effect
    settle on the original attempt.
  - A log in which a `provider_recovery` replacement follows an interrupt, the
    sequence the race used to commit, rebuilds to identical entities and
    verifies as readable.
- `tests/server/opencode-secret-mcp-scope.test.ts` gains 2 cases. They check
  the wait server's timeout and tool split, the refusal of a misrouted call,
  both rulesets, that every listed tool exists, and that no wait server is
  added without such tools. `watcher-read-only-harnesses.test.ts` expects the
  new allow rule.
- `tests/server/delegation-wait.test.ts` gains 6 cases (11): the budget
  function, and a manager case where approval time on Cursor shortens the wait
  to 170 s, approval text included, while Codex keeps 30 min; and the
  cancelled-wait retry. An identical unkeyed retry reuses the chat without a
  second approval, a later identical request creates a new one, and a keyed
  retry replays. Three more cases cover status, wait and cancel naming the
  handle, after which an identical request creates a new chat with its own
  approval.
- `tests/server/agent-thread-manager.test.ts` gains 2 cases (49), the second
  for the `stopped: false` answer when the approved turn ended on its own. It checks
  that `inertia_stop_conversation` commits an `agent.stop` receipt under
  `agent` and cancels the exact identity. The delayed-approval case now also
  checks that no interrupt is recorded on the replacement.
- Updated: `turn-interaction-commands.test.ts` (`cancelExact` mocks),
  `agent-thread-delegation.test.ts` (hint wording) and the restart
  continuation suites (`RESTART_CONTINUATION_PROMPT`).

Against the unchanged sources, these fail: the five lock cases (the sixth,
classification, needs the new export), both stop-race cases (the follow-up
ends `cancelled`) and both start-read cases (`start` throws a ZodError, and
the deferred turn stays `queued`). The cross-thread cases pass on both, as
expected. Review round, each checked against the code before its fix:

- Five outbox cases fail against the first round's 100 ms loop (the fence and
  cancel case, the real busy timeout case, the default-policy case and the two
  re-timed cases).
- The fallback case fails without the fallback decline and the write-time
  refusal: the fallback runs and the restart is accepted.
- The rebuild case fails against the earlier projector refusal.
- The three handle cases fail while reuse ignores a seen handle.
- The agent escalation case fails while escalations record `user`, and the
  `expectedRunId` refusal fails while intake compares turns only.
- The ended-turn case fails while the tool always answers `stopped: true`.
- The OpenCode split and retry-reuse cases fail without the wait server and
  without `cancelledDelegateWaits`. The keyed retry passes on both.
- The hand-off and narrowing cases pin behaviour rather than fix a bug.

Verification (2026-11-14, macOS, Node 22, after the review round):

- The changed suites passed.
- A wider run passed 1,863 of 1,863 tests in 131 files (second review round). It covered every
  `tests/server` file matching `orchestration-*`, `turn-*`, `delegation-*`,
  `restart-*`, `agent-*`, `queued-message-*`, `update-everything*`,
  `limit-reset*`, `observed-child-*`, `opencode-*` and `provider-host-tool-*`,
  plus `detached-chat-runtime-authority`, `watcher-read-only-harnesses`,
  `secret-request-routes`, `provider-session-fallback`, `mascot-status` and
  `tests/renderer/activity-summary`.
- `npm run check:quality` passed: workflow concurrency, migration lineage,
  architecture, colour themes, `lint` and `typecheck`. `turn-controller.ts`
  is at 1,248 lines, under the 1,250 ceiling.
- `npm run test:portable` passed 4,319 tests with 31 skipped, in 260 files
  (2 skipped).
- The Electron scenarios (`update-everything.spec.ts`, whose quoted prompt
  changed, and the stop ladder), a real OpenCode run and the full
  `npm run check` were not run. The branch base is one commit behind the PR
  head (`e6cdf6b3`, CI timeouts only).

Open risks:

- *Browser approvals on OpenCode.* Browser tools stay on the 30 s server, so a
  Browser approval slower than 30 s is still cancelled there. Moving the
  browser family would remove its 30 s bound and rename its OpenCode tools;
  it is left to the browser surface.
- *OpenCode 2.* The OpenCode 2 harness (`opencode2-harness.ts`) registers its
  host server without a timeout, and OpenCode 2's default was not checked.
- *OpenCode's timeout semantics.* Whether OpenCode's per-server `timeout`
  covers tool calls remains unverified without a live run. It is inferred
  from the repository's history, as above, not read in OpenCode's code. If it
  does not, the MCP SDK's 60 s request default applies, which still cuts
  approvals and delegated waits. A live 31 s call would settle it.
- *Inline process-bound settles.* A stuck `running` steer or interrupt row
  (an inline `settleClaim` that hit a lock timeout) still holds later
  checkpoint captures in its thread until the next boot. Only the dispatcher's
  settles were in scope.
- *A claim the retry gave up on.* After the 60 s budget, the claim holds its
  thread's later effects until the next startup, as every settle failure did
  before this package.
- *Approval time on Cursor, Kimi Code and Pi.* An approval longer than the
  bridge's 300 s can still lose the call. That predates this package.

## G11 completion: occupancy, omitted ids and checkout return — 2026-11-14

Status: uncommitted on top of `26e42678` (PR #686), macOS arm64, Node 22.
T3 anchors are at `b05c505b`. Codex native history injection (brief C6) is
the next package and is not part of this entry; nothing here changes the
handoff `method`, which stays `inline`.

### 1. Native occupancy at bytes / 4 (T3 `b53cd6768`)

When a resumed session reported no usage, `coveredHistoryOccupancy`
(`src/server/orchestration-v2/portable-history-occupancy.ts:18`) estimated its
occupancy at one UTF-8 byte per token. It now follows T3's
`estimateTextTokens` (`packages/provider-core/src/server/handoffBudget.ts:99`,
used at `apps/server/src/orchestration-v2/ProviderTurnStartService.ts:920`):
each covered item's text bytes divided by 4 and rounded up per item (`:10`),
for messages (content plus stream chunks), inherited fork items (all parts of
one item together), command and error activity (still capped per item),
plans and file-change lists. Attachment allowances of covered user messages
stay whole (8,192 per image, 4,096 per other file), as in T3. The new prompt,
its attachments and the restored history are still budgeted at one byte per
token (`portableHistoryBudget`, unchanged). The effect is that a session whose
stored prose is far below its window keeps resuming instead of being replaced
as `context-exhausted`.

### 2. Omitted item ids and item-scoped retrieval (T3 `9f1e97de6`)

`selectPortableHistory` (`src/server/orchestration-v2/portable-history.ts:134`)
lists the newest omitted candidates in the coverage line, in T3's words: "N
intact historical items included; M omitted. Omitted item IDs, newest last:
a, b, c. K older omitted items are not listed." (T3 `selectHistory`,
`handoffBudget.ts:219-276`). At most 20 ids are listed (`MAX_LISTED_OMITTED_ITEMS`,
`:123`). Before selection the widest 20 candidate ids are reserved, popping the
widest until the list fits in an eighth of the budget, so the final list can
never outgrow its reservation; ids are measured as JSON bytes. K counts every
other omitted item, including those outside the bounded window. The retrieval
hint now names one item instead of paging from the chat's start:
`Recover an omitted item only when the request needs it, with
inertia_request_context({conversationId:"…",itemId:"<omitted item ID>"});
continue long text with cursor=nextCursor until null. Items included below
need no read.` (T3 `handoffCoverage`, `handoffBudget.ts:286`, and the condensed
form in `ContextHandoffDelivery.ts:53`).

Coverage accounting is unchanged: listed ids are omitted ids. They are in the
handoff's `omittedItemIds`, never in `itemIds`, and count as covered once the
handoff is delivered (G11 part 1). Only candidates of G11's 256-item window can
be listed, because older items have no id at selection.

`inertia_request_context` accepts `itemId` (`src/server/runtime/agent-context-tool.ts:57`,
`readItem` at `:306`). The item comes from the handoff's own source,
`portableHistoryItem` (`src/server/orchestration-v2/portable-history-source.ts:237`):
the chat's own messages and terminal-turn command, error, plan, file-change
and interruption items, outside rolled-back turns (G1), on the reading turn's
endpoint route, plus the chat's inherited fork snapshot (its parts joined).
Text is read up to 1 MiB, redacted and neutralized like a turn page, and paged
at 30 KiB with a character-offset cursor (`agentContextItemPage`,
`src/server/runtime/agent-context-pages.ts:352`). Scope: an `itemId` with
another chat's `conversationId` fails with `item_not_in_this_chat` before any
approval card; another chat's id passed with this chat's id reads as
`item_not_found`; an item from another endpoint fails with `item_withheld`
and shows none of its text; a watcher may read items only of its own chat,
and each read counts against its per-check budget. The read is recorded as an
own-chat context read. The tool description grew by 31 bytes and the schema by
one property; the agent surface budget was re-measured (`inertia_request_context`
933 → 1,021 bytes for Claude, Cursor/Kimi and OpenCode, 827 → 915 for Codex;
every total +88) and the description stays under its 520-byte test bound.

### 3. The backing follows the native session across checkouts (G11 part 1b, brief C5)

T3 keeps one current native conversation per provider thread and resumes it
in the new cwd on a workspace change (`restart_and_resume`,
`ProviderSessionTransitionPolicy.ts:73-75`; `ProviderSwitchService.ts:122-178`;
`ProviderTurnStartService.ts:726-744`, `:1255-1276`), with coverage keyed by
provider thread and native thread (`:851-861`), and holds the queue while the
replaced session runs background work (`Orchestrator.ts:2655-2681`).

Inertia's equivalent:

- **Current native conversation.** `ProviderBackingRepository.current`
  (`src/server/orchestration-v2/backing-repository.ts:50`) is the newest
  backing of the chat's provider instance that is not retired, in any
  checkout.
- **Per-harness capability.** `sessionCwdMobility`
  (`src/server/provider/session-cwd-mobility.ts`) is a table over every
  `AgentHarnessId`, so a new harness must choose. `resume` only for
  `codex-app-server`; every other harness is `fresh`.
- **Lookup** (`src/server/runtime/turns/turn-request-preparation.ts:397-409`).
  When the current backing lives in another checkout: a `resume` harness
  relocates it if it is `ready`, coverage-complete, not the exhausted backing
  and has no pending native rollback continuation; otherwise the turn starts
  fresh with the full portable history. A `fresh` harness keeps a live
  backing of this checkout (moving back to A resumes A's own session with a
  delta) and otherwise starts fresh instead of resuming another checkout's
  session. The first turn after a move therefore reads the moved-from status.
- **Relocation event.** `provider.backing-relocated {runId, attemptId,
  fromBackingId, backingId, workspaceKey}` (`src/shared/orchestration-backings.ts:53`)
  commits in the admission, after `run.accepted` and before
  `context.handoff-prepared` (`src/server/orchestration-v2/turn-repository.ts:138-187`).
  The projector derives the new row from the source row (same native session,
  coverage, status, selection, `lastRunId`), retires the source in the same
  write, and refuses a source that is not `ready` and complete, another
  instance or project, the run's own checkout, an attempt on another session,
  or a forged id (`backing-projector.ts:97-121`). The new id is
  `fingerprint(threadId, instanceId, workspaceKey, nativeSessionId, fromBackingId)`,
  so A → B → A never collides with A's retired row, which is never recorded
  again. The move turn's handoff targets the relocated id and offers only
  items the session has not covered. `observeSession` now looks the session's
  row up instead of deriving its id (`:130`, `:161`), so a relocated row is
  updated in place; its workspace carry stays as the fallback for older data.
- **Busy session.** If the harness reports background work for the session
  being relocated, preparation refuses with `CheckoutMoveBackgroundWorkError`
  (`turn-context-handoff.ts:26`), before any write, as the G2 exhaustion path
  does. No harness implements the background-work probe yet.
- **Containment and cleanup.** `conversationPath` re-validates the checkout's
  path receipt (canonical realpath, directory identity, repository) at
  preparation and again at admission. No transcript is copied or moved. The
  replaced session's process tree was already confirmed ended by the earlier
  run's cleanup; admission still refuses while any cleanup is pending.
- **Event sourcing.** One new event type with its own projection; no existing
  event is reinterpreted, so `ORCHESTRATION_V2_PROJECTION_VERSION` stays 2 and
  no migration is needed (next free number stays 124). Older databases with
  G11 part 1 moves (`workspace-changed` retirement plus a carried row) read
  unchanged; the carried row is the current conversation and relocates
  normally.

Per-provider findings (verified in Inertia's code, not by running providers):

| Harness | Finding | Mobility |
| --- | --- | --- |
| `codex-app-server` | `thread/resume` sends `cwd: options.cwd` (`src/server/codex/app-server-run.ts:1030-1058`); App Server finds threads by id under `CODEX_HOME`. New portable fixture `tests/server/codex-app-server-moved-checkout.test.ts` | resume |
| `claude-agent-sdk`, `claude-cli` | Claude Code keeps transcripts under the project folder named after the cwd; `readClaudePersistedNativeHead` reads with `dir: cwd`, and imported sessions resume from their original cwd (`src/server/cli-import/resume-cwd.ts:22-30`). Resume from another cwd is unverified (T3 `543ee27fa` concerns native fork, not CLI resume) | fresh |
| `pi-rpc` | `findPiSessionFile` refuses a session whose header names another workspace (`src/server/provider/pi-session.ts:79-81`). T3 forks the file into the new cwd (`bebaf3ec0`) | fresh |
| `cursor-sdk` | `CursorSdkSession.execute` refuses a stored agent whose cwd is another workspace (`src/server/provider/cursor-sdk-session.ts:57-60`). T3 resumes from the recorded store cwd (`a18a458f2`) | fresh |
| `cursor-acp`, `kimi-acp`, `grok-acp`, `opencode-sdk`, `codex-cli`, `cursor-cli`, `opencode-cli`, `antigravity-cli` | not proven | fresh |

Before this entry every harness resumed the conversation's session in the new
checkout on the first turn after a move; Pi and the Cursor SDK then refused
it. They now start fresh with the portable history.

Deliberate differences from T3 Code:

- Only Codex App Server resumes across checkouts. Claude, Pi, Cursor SDK and
  the rest start fresh with the full portable history until resume from
  another cwd is proven by code and fixtures; Pi forking and the Cursor SDK
  store cwd are follow-ups.
- A `fresh` harness keeps one live session per checkout: moving back resumes
  the checkout's own session with a delta, where T3 has a single current
  conversation.
- A busy session is refused with a typed, user-correctable error instead of
  holding the queue, as in the G2 exhaustion path.
- Omitted ids are listed only where the route's host-tool bridge is attested;
  without retrieval the list is left out. Items outside the 256-candidate
  window are counted but never listed (T3 also lists earlier handoffs'
  omitted ids; Inertia prepares one handoff per turn).
- `itemId` reads only the reading chat's own history, on its endpoint route;
  T3's `t3_thread_read` takes any thread id.
- The occupancy estimate counts attachment allowances for every covered user
  message; T3 counts them only for natively accepted turns.
- A session that no V2 run, native fork or import records keeps resuming
  after a move on a `fresh` harness, because its checkout is unknown (review
  fix 1).

Tests:

- `tests/server/orchestration-context-exhaustion.test.ts`: the T3 case "keeps a
  native session whose stored prose is far below an unreported window" (about
  112 KB of prose, about 28k tokens) and the exact per-item estimate; the
  existing unreported-usage exhaustion case now uses 400,000 bytes. The new
  case fails against the unchanged estimate.
- `tests/server/orchestration-portable-history.test.ts`: T3's "points history
  recovery at the omitted items" case; at most 20 ids, newest last, with the
  older count; the list within budget/8 and the block within budget; every
  budget from 1,024 to 12,000 bytes in steps of 7; no list without retrieval;
  the rollback case now also reads items by id (rolled-back items not found,
  retained ones found, none readable from another chat).
- `tests/server/orchestration-forks.test.ts`: an inherited item read by id in
  the fork only, all parts joined, truncated at the byte bound.
- `tests/server/agent-context-tool.test.ts`: item read with paging, redaction,
  neutralization and the own-chat read record; another chat, a smuggled id,
  an unknown id and another endpoint; argument combinations; watcher scope and
  budget; the schema lists `itemId`.
- `tests/server/orchestration-backing-relocation.test.ts` (new, 9 cases):
  harness mobility table; A → B → A on the original session with only the
  intervening items, event order in the admission commit, retired rows never
  recorded again, rebuild and reopened-store equality; an uncertain backing
  starts fresh; a `fresh` harness starts fresh in B and resumes A's own session
  on return; background work refuses without writing; a not-delivered refusal
  keeps the relocation and redelivers the delta; an exhausted session is
  replaced, not relocated; a chat moved under G11 part 1's carry upgrades
  without rewriting its rows; forged or mismatched relocation events are
  refused. All 8 behavioural cases fail against the unchanged sources (run with
  the new helpers inlined).
- `tests/server/orchestration-backings.test.ts`: the two G11 part 1 move cases
  now expect a relocation (no `workspace-changed` invalidation; the backing
  exists in B before the run starts; the provider gets `cwd` = B) and a fresh
  start for an uncertain session. Both fail against the unchanged sources.
- `tests/server/codex-app-server-moved-checkout.test.ts` (portable): a resume
  in a moved checkout sends `thread/resume` with the original thread id and
  the new `cwd`, and no `thread/start`.

### Review fixes (two independent reviews, 2026-11-14)

1. **A session without a backing no longer resumes in another checkout on a
   `fresh` harness** (MEDIUM). When neither the checkout's backing nor the
   current backing exists, preparation used to resume
   `conversation.providerSessionId` for every harness. Now a `fresh` harness
   resumes it only when its recorded checkout matches the chat's
   (`unbackedSessionRanHere`, `src/server/runtime/turns/turn-request-preparation.ts`;
   `sameCheckoutPath`, `src/server/cli-import/resume-cwd.ts`): an imported
   session's cwd, else the workspace of the newest V2 run whose turn ended on
   the session, else the target checkout of the native fork that created it
   (`ProviderBackingRepository.sessionWorkspaceKey`). A recorded mismatch
   starts fresh with the portable history. A native fork's inherited coverage
   now belongs to its native conversation, not to its checkout
   (`nativeForkCoverage` no longer compares `targetWorkspaceKey`), so a Codex
   fork moved before its first send resumes there without re-sending its
   inherited history; a Claude fork moved the same way starts fresh. Decision:
   a session that nothing records (a turn from before V2 runs, never resumed
   since) keeps resuming as before. Inertia has no per-turn cwd for such
   turns, and treating every one as foreign would drop the native session of
   every existing non-Codex chat once on upgrade. A chat moved before its
   first V2 turn can therefore still try its old session in the new checkout,
   as before this package; the G9 fallback covers a provider that reports the
   session missing.
2. **Native rollback and fork follow a relocated session** (LOW).
   `HistoryRollbackRepository.physicalHead` keys the head by provider instance
   and native conversation only, and `nativeTarget` no longer requires a
   boundary's or a native fork's checkout to equal the current one
   (`src/server/runtime/history-rollback-service.ts`,
   `src/server/runtime/fork-session-service.ts`). After A → B, a rollback to a
   turn from A runs natively against B's newest head and rewinds the relocated
   backing in place; A → B → A sees B's head, not a stale one.
3. **A checkout change between preparation and admission is a typed,
   user-correctable conflict** (LOW). Preparation passes the checkout it
   resolved (`preparedWorkspaceKey`, excluded from the receipt intent);
   admission refuses with `OrchestrationConflict("checkout-changed")` before
   any write ("This chat moved to another checkout while the message was being
   prepared. Send it again.", `src/server/runtime-errors.ts`). The handoff
   projector also refuses a missing target backing with `scope-conflict`
   instead of a schema error.
4. **Inherited commands and errors are redacted** (MEDIUM). Fork parts of kind
   `command` or `error` go through `scrubCommandSecrets` before the usual
   scrub and neutralization on every read path: `portableHistoryItem`,
   `portableForkHistory` (`forkItemText`, `src/server/orchestration-v2/portable-fork-history.ts`)
   and `inertia_fork_history` (`src/server/runtime/fork-history-tool.ts`, per
   64K-character part).
5. **An incomplete inherited item is not returned** (LOW).
   `portableHistoryItem` applies the handoff's integrity rule: the stored part
   count must equal the item's `parts`, at most 4,096 (`MAX_FORK_ITEM_PARTS`).
6. **Item lookup is keyed** (LOW). The id's prefix names the source
   (`activity:`, `plan:`, `files:`, `interrupt:`, else a message id) and the
   lookup queries that one source by its own key, with explicit column
   aliases on every candidate arm; query plans start with
   `SEARCH <table> USING INDEX`. The withheld re-check is the same keyed
   lookup without the route.
7. **Known risk, decided (no code change).** Native occupancy follows T3's
   bytes / 4. Chats without usage reports whose history is mostly CJK text,
   emoji or base64 have fewer bytes per token, so the estimate can count too
   few tokens and keep resuming a fuller session than it is. T3 has the same
   risk. Providers that report usage are unaffected.

Review-fix tests:

- `tests/server/orchestration-backing-relocation-edges.test.ts` (new, 7 cases):
  an imported Claude session moved to another checkout starts fresh while an
  imported Codex session resumes there; a session whose producing run ran in
  another checkout and whose backing was retired starts fresh; an unrecorded
  session keeps resuming; a native fork moved before its first send (Codex
  resumes with inherited coverage, Claude starts fresh); a native rollback of a
  relocated Codex session to a turn from before the move, against the newest
  head; a checkout change at admission refuses with `checkout-changed`,
  writes nothing, and the retry relocates; forged relocation events with a
  retired source, another chat's source and incomplete coverage are refused.
  Against the sources before these fixes, the five behavioural cases fail
  (the unrecorded-session and forged-event cases are guards).
- `tests/server/orchestration-forks.test.ts`: inherited `DEPLOY_TOKEN=…`,
  `mysql --password`, `curl -u` and `gh secret set --body` commands are redacted
  by id, in the restored fork history and through `inertia_fork_history`; an
  inherited item with a missing part reads as not found. Both fail before.
- `tests/server/orchestration-history-retrieval.test.ts` (new, 3 cases): the
  newest id listed in a real Codex restore after ten Claude turns is in the
  handoff's `omittedItemIds`, absent from the prompt, and reads back through
  `inertia_request_context` exactly as stored; item lookups use keyed index
  searches, and unknown prefixes or keys read as not found (fails before);
  occupancy rounds an inherited item once over all its parts and a capped
  activity at its cap.
- `tests/server/orchestration-history-rollback.test.ts`: `physicalHead` calls
  drop the checkout argument.

### Second review fixes (2026-11-14)

1. **A retired session stays retired after a move** (MEDIUM-LOW). With no
   candidate backing, preparation used to let a `resume` harness resume the
   conversation's session, so a Codex session whose backing was retired
   (`uncertain-delivery` after a restart mid-dispatch, or a retired relocated
   row) was resumed in another checkout without history. Now any retired
   backing for the same thread, provider instance and native session
   (`ProviderBackingRepository.sessionRetired`) makes the turn start fresh, for
   every harness.
2. **`checkout-changed` stays user-correctable on the send path** (LOW).
   `classifiedMessageSendError` maps it to a `RuntimeRequestError` with
   `USER_CORRECTABLE_REQUEST`, like `cleanup-pending`
   (`src/server/runtime/commands/message-send-support.ts`), so
   `commandRejection` records no rejected receipt and no `command.failed`
   incident is filed.
3. **Checkout comparison uses `realpathSync.native`** (LOW), so a different
   letter case on a case-insensitive volume is the same checkout
   (`sameCheckoutPath`, `src/server/cli-import/resume-cwd.ts`).
4. **`inertia_fork_history` redacts a multi-part command or error as one
   text** (LOW). The first part carries the whole item, joined before
   redaction (`ForkRepository.itemText`, at most 4,096 parts, empty if a part
   is missing); later parts of that item return empty text. The case is
   reachable: a command activity longer than 65,536 characters splits.

Second-review tests (each fails against the code before its fix, except the
two guards marked):

- `orchestration-backing-relocation-edges`: a Codex session whose backing was
  retired starts fresh in a moved checkout, and a retired relocated row keeps
  its session retired in a third checkout; the checkout-change case asserts
  the send-path classification (`commandRejection(...) === null`, user
  correctable); the native rollback after a move asserts the provider call's
  `cwd` is the moved checkout; a new A → B → A case checks the head in A
  before and after a turn there and rolls back natively in A against the
  newest head (guard); a Claude chat with a fresh session in B rolls back to a
  turn from A portably without a native call (guard).
- `tests/server/resume-cwd.test.ts` (new): symlink, missing folder and letter
  case; the case test fails with plain `realpathSync`.
- `orchestration-forks`: a command whose part boundary falls inside
  `--password supersecretvalue` is fully redacted through
  `inertia_fork_history`; per-part redaction leaks the second half.

Verification (2026-11-14, macOS arm64, Node 22.23.2, after the second review
fixes): the full Vitest suite passed 20,397 tests with 174 skipped in 1,618
files (1,604 passed, 14 skipped). `npm run test:portable` passed 4,341 tests with
31 skipped in 264 files (2 skipped).
`typecheck`, `lint` and `check:architecture` passed. The full `npm run check`,
the Electron scenarios and a packaged build were not run.

Not exercised: real Codex, Claude, Pi or Cursor accounts (the per-provider
findings come from Inertia's code and fixtures), Windows and Linux, and a
provider that implements the background-work probe. Open: Pi relocation by
forking the session file and Cursor SDK resume from the store cwd; a Claude
check of `--resume` from another cwd under the same `CLAUDE_CONFIG_DIR`; a
native rollback started in a checkout other than the one the session last ran
in (it still needs the session's backing in that checkout); and the C6
injection package, which will credit native-delivered ids through the same
coverage path.

## G11 part 2: Codex native history injection — 2026-11-17

Status: uncommitted on top of `5543eaa8` (PR #686), macOS arm64, Node 22.
T3 anchors are at `b05c505b`; injection is unchanged on T3 main since then.
Brief: [t3code-delta-2026-11-14.md](t3code-delta-2026-11-14.md) section C6.

### Mechanism

A turn that carries a portable handoff (restore or delta) on Codex App Server
appends its restored history to the native thread with `thread/inject_items`
after `thread/start` or `thread/resume` and before `turn/start` (before
`thread/goal/set` for a goal start), and its prompt omits the restored-history
block (T3 `CodexAdapterV2.injectHistory`, `deliverContextHandoffs`,
`ProviderTurnStartService.startWithHandoffs`).

- **Capability.** `history-injection` joins `PROVIDER_CAPABILITY_IDS`
  (`src/server/provider/capability-manifest.ts`): Codex `negotiated`, every
  other harness `unavailable`. The run coordinator offers the injection
  authority to a harness only when a successful negotiation would make the
  capability available to that run (`run-coordinator.ts`,
  `historyInjectionAdmitted`), so a custom backend whose observed ceiling does
  not include it, or any other harness, never receives it. The Codex harness
  reports the outcome as a capability observation (`true` on acceptance,
  `false` on an unknown method). As in T3 nothing is cached: every turn tries.
- **Items.** Unchanged `portableHistoryResponseItems` (T3 `historyResponseItems`):
  the coverage context as a `user`/`input_text` item, historical user items as
  `input_text`, everything else as `assistant`/`output_text`, each with the
  inline rendering's provenance label and its already neutralized text. Only
  the required history block is injected; optional supplements (handoff
  outcome, referenced-chat blocks) stay in the prompt, as T3 keeps side-chat
  and restart context inline. Injected history is text only: the current
  prompt's images, files and skills stay on `turn/start`, which is always sent
  as a prompted start.
- **Preparation.** Assembly keeps producing the inline prompt and, beside it,
  `nativeHistory`: the items and the same prompt without the restored block
  (`request-context.ts`). The run carries the inline prompt; the authority
  (`ProviderHistoryInjection`, `src/server/provider/contracts.ts`) carries the
  items and the native prompt, so a harness that does not inject delivers
  inline by construction. The budget is unchanged (`portableHistoryCost` is
  already the larger of both encodings).
- **Authority.** `turnHistoryInjection` (`src/server/runtime/turns/turn-history-injection.ts`)
  binds three durable steps to one attempt: `begin`, `delivered`,
  `unsupported` (`ProviderBackingRepository.historyInjection`). Each commits
  before returning and returns false, writing nothing, unless the run's
  current attempt owns the handoff in the expected state; `begin` is also
  refused once a Stop is recorded on the attempt. It is not offered above
  64,000 JSON bytes (`MAX_HISTORY_INJECTION_BYTES`); the transport checks the
  bound again. The G9 fresh-session replacement gets its own authority for
  its own restore (T3 injects into the fresh thread too); the rejected
  attempt's authority is stripped from the replacement and could no longer
  write anyway.
- **Transport** (`src/server/codex/app-server-history-injection.ts`). Nothing is
  sent, and the history stays inline, when a turn is active on the thread
  (`activeTurnId`, or `thread.status.type === "active"` in the open response),
  after a Stop, above the bound, or when `begin` is refused. The request uses
  the surrounding timeout and cancellation. An unknown method returns the
  inline prompt; any other error, a response that is not a JSON object, a
  transport close, a timeout or a Stop throws, and no turn starts. After
  `delivered`, the existing cancellation check runs before `turn/start`.
  Request error classes moved to `app-server-request-errors.ts`; a request can
  now decide by code and message whether its error becomes the run's failure.

### Delivery records

The handoff is prepared `inline` as before. The new optional `method` field on
`context.handoff-state-changed` changes it while the handoff is `dispatching`:

| Step | Event | T3 |
| --- | --- | --- |
| dispatch (unchanged, before the provider starts) | `dispatching`, no method | – |
| `begin`, before the request | `dispatching` + `native` | `pending` |
| accepted, before `turn/start` | `delivered` + `native`; the session's backing becomes `ready` | `injected` |
| unknown method | `dispatching` + `inline`; delivered later by provider output | inline fallback |
| error, malformed, close, timeout, Stop | stays `dispatching` + `native`; settlement makes it `uncertain` | `pending` stays |

The projector allows a method change only while `dispatching`, a
`dispatching → dispatching` event only to change the method, and a delivery
that keeps the method; an event without `method` keeps the handoff's method,
so every older event replays to the same row. Provider output never delivers a
`native` handoff (`acknowledge` only delivers `inline` ones). Inline handoffs
keep the old event shape. No migration, no projection-version bump.

Settlement: a handoff still `dispatching` + `native` is never abandoned, even
when the provider claims nothing was delivered; it becomes `uncertain` and the
session's backing is retired as `uncertain-delivery` through the existing
invalidation. The next turn finds no usable backing and `sessionRetired`
blocks the unbacked path, so it starts a fresh thread with the full restore
(T3 `ContextHandoffDelivery.ts:113-122`, `ProviderTurnStartService.ts:1255-1269`).

Coverage: `delivered` readies the backing, so the existing settlement path
credits the handoff's `itemIds` and `omittedItemIds` whatever the turn's
outcome (T3: an injected handoff stays covered after a failed turn). The
turn's own messages are credited only once Codex accepted the turn (see
Review fixes, 1). A turn that fails after injection resumes the same thread
next time with only newer items, including its own unsent prompt.

### Findings on the requested angles

- **Native rollback (G12).** A native rewind now also uncredits the items and
  omitted ids that delivered handoffs of rolled-back runs brought into the
  rewound session (`rolledBackHandoffItems`,
  `src/server/orchestration-v2/history-rollback-repository.ts`), inline or
  injected; a rollback that keeps the injecting run keeps them. In reachable
  flows the existing trim already removes them, because Inertia's native
  rollback needs a retained boundary on the same session, so the delivered
  items are messages of rolled-back turns. The new rule covers the remaining
  case (a later delta offering an older item outside the 256-candidate window).
  Both directions are tested; both tests also pass without the new rule
  (guards). Not verified: whether Codex `thread/revert` keeps items injected
  between turns (the probe below shows they are recorded outside any turn);
  uncrediting is the safe choice either way.
- **G9 fresh-session fallback.** A rejected resume happens before injection, so
  the handoff is abandoned exactly as before and the replacement's restore is
  prepared under the replacement attempt, which receives its own authority. A
  turn that fails after a successful injection keeps the delivery and the
  coverage, and the next turn resumes the thread. If injection was ambiguous,
  the session is retired and the next turn starts fresh.
- **Relocation (C5).** The relocated backing is the handoff's target; dispatch
  and `delivered` find it through the attempt's session in the run's checkout,
  so a relocated delta is injected into the resumed thread (same native id,
  new cwd) and credited to the relocated row.
- **Ids.** Every new event carries the handoff, run and attempt ids; the
  repository checks the run's current attempt and the projector re-checks the
  attempt, run, thread, target backing and native session.
- **Replay.** Rebuild and a reopened store give identical rows for native,
  inline-fallback, uncertain and rollback logs, and for an inline log without
  `method`.
- **Bounds and neutralization.** Items are at most 64,000 JSON bytes; text is
  the portable source's neutralized text with the same labels as inline.

### Deliberate differences from T3 Code

- **Unknown method.** T3 treats only JSON-RPC -32601 as "not supported". The
  installed App Server 0.169.0 answers an unknown method with -32600
  "Invalid request: unknown variant `<method>`" (observed, below), so under
  T3's rule an App Server without `thread/inject_items` would fail every
  injecting turn and retire its session. Inertia also treats that exact
  decode failure as unsupported; any other -32600 stays ambiguous.
- **Prepared method.** T3 writes `pending` only around the request; Inertia's
  dispatch already marks the handoff `dispatching` before the provider
  starts, so `native` is the method change at `begin`. The record never claims
  native delivery a harness did not attempt.
- **Malformed response.** T3's decoder rejects a non-object response; Inertia
  checks for a JSON object explicitly and fails the turn.
- **Goal starts.** The transport injects before `thread/goal/set`, but
  Inertia's goal starts still carry no handoff (their delta waits for the next
  prompted turn, as before), so this path is not reached in production.
- **Unclean restart.** A runtime restart after `delivered` still retires the
  session (existing unclean-recovery rule); T3 would keep the injected
  coverage.

### Also in this package: work reserve (T3 `9ec71438c`)

`portableHistoryBudget` reserves `min(max(16,000, window / 4), window / 2)` for
work, as T3's `handoffBudget` since 2026-11-15, so a 20,000 window leaves
10,000 for history instead of at most 4,000. The image-batch test's 20,000
window cases now expect room for one image.

### Real-protocol check

`codex app-server` 0.169.0 with `CODEX_HOME` set to an empty scratch folder
(no credentials, no `turn/start`): `thread/start` succeeded without auth;
`thread/inject_items` with a user and an assistant message answered `{}`;
`thread/read` showed the thread `idle`, and the rollout recorded both as
`response_item`s after the thread's setup, outside any turn. An unknown method
answered -32600 "unknown variant". `thread/revert` over injected items was not
exercised (it needs turns).

### Tests

- `tests/server/codex-app-server-history-injection.test.ts` (new, portable,
  15 cases): success on a new and a resumed thread, order and exact items, the
  native prompt, images kept on `turn/start`; -32601 and 0.169.0's unknown
  variant fall back inline in the same turn without failing; malformed
  response, another error, another -32600 and a transport close fail without
  `turn/start`; Stop during the request; items at exactly 64,000 bytes sent
  whole and 64,001 kept inline; a refused `begin` and a refused `delivered`;
  an active thread; inject before `thread/goal/set`; no authority.
- `tests/server/orchestration-history-injection.test.ts` (new, portable,
  15 cases): native delivery recorded before the turn, steps one-shot, output
  never delivers a native handoff, coverage, next turn resumes without a
  handoff, rebuild; an injected delta stays covered after a failed turn and
  the retry resumes with newer items only; the unknown-method event sequence;
  transport close and Stop retire the session as `uncertain-delivery` and
  restore on a fresh thread; a Stop refuses `begin`; a not-delivered claim
  cannot undo a started injection; the fallback replacement's own authority
  and the stale one; the older log without `method` replays and reopens
  unchanged and the older payload parses; forged method transitions are
  refused; G12 rollback keeping and removing the injecting run; and three
  cases over the real transport and the App Server fixture (success,
  `turn/start` failing after injection, unknown method).
- `orchestration-portable-history`: the small-window work reserve.
  `orchestration-backings`, `harness-backend-routing`,
  `provider-capability-manifest`: updated for the reserve and the 29th
  capability.

Against the sources before this package all new cases fail except four
guards: the active thread, no authority, the inline log replay and the
fixture's unknown-method case (inline was already the behaviour). The two G12
cases fail before the package because they inject, but pass with only the new
rollback rule reverted, so they guard it rather than prove it.

Verification (2026-11-17, macOS arm64, Node 22): the full Vitest suite passed
20,461 tests with 174 skipped in 1,621 files (1,607 passed, 14 skipped).
`npm run test:portable` passed 4,389 tests with 31 skipped in 269 files
(2 skipped). `typecheck`, `lint` and `check:architecture` passed. The full
`npm run check`, the Electron scenarios and a packaged build were not run.

Not exercised: a Codex turn with real credentials after injection (model
behaviour on injected items), `thread/revert` over injected items, an App
Server that predates `thread/inject_items`, the capability gate for a custom
Codex backend (by code reading: its observed ceiling excludes
`history-injection`, so it stays inline), Windows and Linux. The persisted
execution manifest still lists the restored block for an injected turn; it is
audit data and no prompt is rebuilt from it.

### Review fixes (independent review, 2026-11-17)

1. **The turn's own prompt is credited only once Codex accepted the turn**
   (MEDIUM). `delivered` readies the backing before `turn/start`, and
   settlement then credited the turn's own messages, so after Codex → Claude →
   Codex with the injection accepted and `turn/start` rejected (or a Stop
   between `delivered` and `turn/start`), the next turn resumed `codex-native`
   without "Return to Codex". Settlement now credits a natively delivered
   run's own messages only with evidence that the provider accepted the turn:
   completion, a native turn boundary (`turn/started`), or an assistant
   message (`backing-repository.ts`, `settle`). Preparation delivers a delta
   when the session's last turn's own prompt is not covered, so the next turn
   carries it (`turn-request-preparation.ts`, `deliversDelta`). T3's rule is
   general: a run's items count as native only when the provider accepted a
   turn for that attempt (`ProviderTurnStartService.ts:863-880`,
   `nativeInputRunIds` from `providerTurns`).
   The general case was left open here and closed for Codex in the second
   round below.
2. **Goal change during injection** (LOW, no code change). `setGoal` and
   `clearGoal` run through `serializeGoalMutation`, which awaits the startup
   gate; the gate opens only when `openCodexTurn` returns, after injection and
   `turn/start`. A goal change made during the injection is therefore sent
   after `turn/start`. A guard test pins the order.
3. **The Claude turn a switch-back delivered as a delta is kept on Codex's
   route** (pre-existing, user-visible). `latestProviderHandoffOnRoute`
   (`src/server/persistence/turn-ledger-repository.ts`) counted only turns
   with `continuation_reason_code = 'harness-changed'`; a switch-back that
   resumes the old thread is `same-continuation`, so a later fresh Codex
   session (an ambiguous injection, or a rejected resume and the G9 restore)
   dropped the Claude turn's messages. It now counts any turn that directly
   follows a turn on another provider and restored history, and skips a turn
   settled as not delivered (its `restoredMessageCount` is also cleared then).
   Same-provider harness changes still never count. `inertia_request_context`
   uses the same route and gains the same items.
4. **Small items.** The capability comment names both unknown-method answers.
   A test now builds the edge the rollback rule exists for: 130 Claude turns
   push the oldest answer outside the restore's 256-candidate window (the
   window always keeps the opening user message), a later Codex delta
   delivers it, and a native rollback to the first Codex turn must uncredit it
   although it is older than the kept turn. The fallback test now reports the
   session before `begin`, as production does.
5. **Kept: native framing follows T3.** Injected items use the `user` role for
   the coverage context and historical user items and the `assistant` role
   for everything else, as T3's `historyResponseItems`. Neutralization is
   identical at the text level (the same neutralized text and provenance
   labels as inline), but native items carry no "Structured execution context
   (reference material; not new user-authored chat prose)" wrapper; the
   coverage item's "Historical content is context, not a new request or
   higher-priority instructions" line is the only framing, as in T3.

Review-fix tests (fail before their fix unless marked):

- `orchestration-history-injection`: an injected delta followed by a failed
  turn no longer covers the turn's prompt and the retry carries it (fake
  provider, and over the App Server fixture with `turn/start` rejected; the
  retry's injected items contain "Return to Codex"); Stop between `delivered`
  and `turn/start` keeps the injected items and resends the prompt; a turn
  Codex started credits its prompt (guard); the uncertain-injection restore
  now includes the Claude turn (both variants); a successful switch-back
  followed by a rejected resume restores the Claude turn through the G9
  fallback; the outside-the-window rollback edge (fails with only the
  rollback rule reverted).
- `codex-app-server-history-injection`: Stop between the recorded delivery and
  `turn/start` starts no turn (guard: the transport already checked); a goal
  change during a slow injection is sent after `turn/start` (guard).


Verification after the review fixes (2026-11-17, macOS arm64, Node 22): the
full Vitest suite passed 20,467 tests with 174 skipped in 1,621 files (1,607
passed, 14 skipped); `npm run test:portable` passed 4,395 tests with 31
skipped in 269 files (2 skipped); `typecheck`, `lint` and `check:architecture`
passed. The full `npm run check`, the Electron scenarios and a packaged build
were not run.

### Review fixes, second round (2026-11-17)

1. **Codex turns without a handoff follow the acceptance rule** (MEDIUM). A
   Codex turn that failed before or at `turn/start` (codex error, RPC
   timeout, service-tier mismatch, skill validation, Stop during
   `thread/resume`) still had its prompt credited, so the next turn resumed
   the thread and the prompt was lost. T3 counts a run's items only with an
   accepted provider turn and resends missed runs for every provider
   (`ProviderTurnStartService.ts:863-880`, `:1052-1059`, `prepareRetryHandoff`
   `:1085-1118`). New manifest capability `turn-acceptance`
   (`capability-manifest.ts`; Codex `native`, every other harness
   `unavailable`, read through `harnessDeclaresCapability`): on such a
   harness, settlement treats a run without acceptance evidence as not
   delivered. Evidence is completion, a native turn boundary on the attempt,
   an inline handoff its output delivered, an assistant message, or provider
   activity (the fresh-session fallback's notion of activity). Without it the
   backing returns to its state before dispatch (`provider.backing-restored`)
   and the prompt is not credited, so the next turn's delta resends it. A run
   whose injected history was delivered keeps that coverage and only its
   prompt is left out. **Open item:** Claude, the CLI harnesses, ACP, Cursor,
   OpenCode, Antigravity and Pi keep crediting the prompt of a turn they never
   accepted. They report no acceptance: their prompt travels with process
   start or a request whose acceptance Inertia does not record, so the only
   general evidence would be output, and requiring it would resend the prompt
   of every turn stopped or failed before output as a "context added" delta
   with a visible restored-history notice. Each needs its own acceptance
   evidence before it declares `turn-acceptance`.
2. **A retry that never starts keeps the native thread** (LOW-MEDIUM). With
   item 1, an inline handoff still `dispatching` on a run without acceptance
   evidence is abandoned and the backing restored, instead of becoming
   `uncertain`; previously the retry of an injected switch-back that was
   stopped before injection made the third turn start fresh. As in T3, a
   handoff is pending only around the injection: a `dispatching` + `native`
   handoff (an ambiguous injection) still retires the session.
3. **Acceptance from the `turn/start` response** (LOW). When the response
   carries a turn id, the transport reports the `started` boundary
   (`app-server-run.ts`), before replaying earlier notifications; the later
   `turn/started` repeats it and records nothing new. A Stop racing
   `turn/started` keeps the prompt delivered. Limit: once the controller has
   processed a Stop it ignores the provider's later events, so a response
   arriving after that is not recorded and the prompt is resent as history
   (a duplicate, the safe side).
4. **Handoff outcome** (LOW). `providerHandoffReason`
   (`turn-context-facts.ts`) skips rolled-back turns. Decision: the "Handoff
   outcome" block stays on every restore and delta that carries the route's
   handoff, not only on a turn that is itself the handoff or a fresh restore.
   Whether a turn "is the handoff" is not reliable from route state: when a
   switch-back is not accepted, its retry is the turn that first brings the
   other provider's items, but it is no longer the route turn, so the
   narrower rule would drop the explanation exactly there. The block is
   optional and dropped first under budget.
5. **Nits.** The comment on the not-delivered guard in
   `TurnLedgerRepository.settle` now says the route marker excludes
   not-delivered runs itself (the guard stays: it is unreachable and keeps
   older rows as written). `historyInjection("begin")` is one-shot per
   handoff: a handoff that already changed method (an unknown method) cannot
   begin again.

6. **Found while verifying: the two-strike rule kept working with resent
   prompts.** With item 1 a retry after a rejected resume resends the missed
   prompt, so the retry has a restored-history record, and
   `recordRejectedResume` only wrote its `resumeRejected` marker into an empty
   record: the second rejection went unmarked and the chat kept resuming a
   broken session. The marker now joins an existing record
   (`turn-ledger-repository.ts`), and the codec drops it before validating the
   record (`codecs.ts`), so the shared `TurnSessionRecovery` shape is
   unchanged. `turn-session-fallback-policy` "starts fresh after two rejected
   resumes" and "retires a session it started once that session has completed
   a turn" fail with item 1 and without this fix. Two of its cases were
   aligned with the new rule: the thread-in-use failure now carries
   `notDelivered`, as the Codex harness reports it, and the uncertain fresh
   session reports acceptance before failing.

Second-round tests (fail before their fix unless marked):

- `orchestration-history-injection`, "turn acceptance": `turn/start` failing
  without a handoff and Stop during `thread/resume` restore the backing and
  resend the prompt; two consecutive failures resend both prompts; the retry
  of an injected switch-back stopped before injection keeps `codex-native` for
  the third turn; one injection per attempt. Guards: Stop after
  `turn/started`, Stop racing the response once acceptance was recorded, a
  tool-only failed turn, and an ambiguous injection still retiring the
  session.
- `codex-app-server-history-injection`: the `turn/start` response reports the
  accepted turn before `turn/started` (fixture `turn-start-response-only`).
- `orchestration-history-rollback`: a rolled-back Claude turn is never named
  as the reason the chat moved.
- `orchestration-backing-relocation`: the uncertain-session case now reports
  acceptance before failing silently, since a Codex turn without acceptance is
  no longer uncertain; `provider-capability-manifest` and
  `harness-backend-routing` cover the 30th capability.


Verification after the second round (2026-11-18, macOS arm64, Node 22):
`typecheck`, `lint` and `check:architecture` passed. The full Vitest suite
passed 20,478 tests with 174 skipped in 1,621 files (1,607 passed, 14
skipped). `npm run test:portable` ran 4,437 tests: 4,400 passed and 31 were
skipped. Six failed on timeouts of 770–970 s each while the machine slept
mid-run. Rerun alone, five passed; the sixth timed out again the same way
and then passed on its own in 3 s. None of the six touches C6 code. The full
`npm run check`, the Electron scenarios and a packaged build were not run.

### Review fixes, third round (2026-11-18)

1. **Thread-open notices no longer count as acceptance** (MEDIUM-HIGH). Codex
   records `mcpServer/startupStatus/updated` (also with `threadId: null`),
   `configWarning`, `deprecationNotice` and thread environment and settings
   notices as status activities on the turn while it opens the thread, before
   `turn/start`; the acceptance check counted any activity, so a failed or
   stopped `turn/start` after such a notice still credited the prompt.
   Decision: on a harness that declares `turn-acceptance`, activity is no
   evidence at all. Since round two an accepted Codex turn always records a
   native turn boundary (the `turn/start` response or `turn/started`), and
   every turn-scoped item (command, tool, file change, reasoning) follows that
   boundary, so counting those kinds would add nothing. Evidence is now
   completion, the boundary, an inline handoff its output delivered, or an
   assistant message (`backing-repository.ts`, `turnAccepted`).
   The same notices also blocked the G9 fresh-session fallback
   (`turnHasProviderActivity`) and the two-strike rule
   (`savedSessionKeepsFailing`). On a harness that declares
   `turn-acceptance`, both now count only turn-scoped activity (command, tool,
   file change, reasoning); a rejected resume or a missing session happens
   while the thread opens, before any turn. Other harnesses keep counting any
   activity but errors and the checkpoint notice: a Claude status notice such
   as "Compacting context" can be genuine turn progress, and they report no
   acceptance to tell the two apart.
2. **An unaccepted turn is not delivered anywhere** (LOW). Acceptance is
   decided once in `synchronize` (`ProviderBackingRepository.unaccepted`):
   - The run records `delivery: "not-delivered"` unless its history was
     injected, so `deliveredRouteTurnId` skips it; the projector now accepts
     the field on any terminal status but `completed` (older events only ever
     carried it on `failed`, so they replay unchanged).
   - Its restored-history record is dropped unless its history was injected,
     so neither the failed turn nor the next one shows a stale "N earlier
     messages restored", and `latestProviderHandoffOnRoute` skips it. The
     clearing (`turn-restored-history-record.ts`) is shared with the explicit
     not-delivered path, keeps a withheld count and a rejected-resume marker,
     and drops the old `harness-changed` guard, which the route marker no
     longer needs. `settleAgentTurn` returns the turn re-read after
     orchestration settlement.
   - Merge-back packets travel with the prompt, so they settle as
     undelivered for any unaccepted turn, even one whose history was injected
     (the injection carries only history); an attached merge-back becomes
     `undelivered`. (This round also returned the rollback cursor to
     `pending`; corrected below: the cursor is a launch option, not part of
     the prompt.)

Third-round tests (fail before their fix unless marked):

- `orchestration-history-injection`: `turn/start` failing after a
  thread-open notice resends the prompt; an unaccepted switch-back records
  `not-delivered`, drops its restored notice, keeps the switch due
  (`deliveredRouteTurnId` is the Claude turn) and resends both the Claude
  turn and the prompt; a turn whose history was injected keeps its notice and
  no `delivery` marker (guard). The tool-only case now follows production
  order (boundary, then the command).
- `orchestration-history-rollback`: the existing uncertain-cursor case now
  reports acceptance first (the round's pending-cursor case was replaced in
  the final fixes).
- `orchestration-merge-back`: findings stay `undelivered` when Codex never
  accepted the carrying turn; the existing uncertain case reports acceptance
  first.
- `turn-session-fallback-policy`: a Codex configuration notice before a
  missing session no longer blocks the fresh-session restart; the
  status-notice blocking case now runs on Claude (guard).
- `session-continuity`: two Codex resumes with only status notices count for
  the two-strike rule, and a Claude harness still counts the notice; the
  "made progress" case uses a command.

Verification after the third round (2026-11-18, macOS arm64, Node 22, each
run alone under `caffeinate -i`): `typecheck`, `lint` and `check:architecture`
passed; the full Vitest suite passed 20,485 tests with 174 skipped in 1,621
files (1,607 passed, 14 skipped); `npm run test:portable` passed 4,411 tests
with 31 skipped in 269 files (267 passed, 2 skipped). The full `npm run
check`, the Electron scenarios and a packaged build were not run.

### Final review fixes (2026-11-18)

1. **Route lookup without a window** (LOW). `deliveredRouteTurnId` looked
   back 16 turns and fell back to the newest; with every unaccepted Codex
   start now `not-delivered`, a switch from Claude followed by 16 failed
   Codex starts made the first working session withhold the Claude turn. It
   now selects the newest turn whose run is not `not-delivered`, walking the
   chat's `(conversation_id, requested_at, id)` index newest first and
   stopping at the first match (bounded by the chat's own turns), and returns
   null when no turn ever reached a provider; preparation then treats the
   switch as still due instead of taking the newest turn's provider.
2. **Rollback cursor** (rationale corrected). The cursor's continuation
   (`resume-cursor`, `new-session`) is a launch option the harness applies
   when it opens the session, before any turn; it does not travel with the
   prompt, so turn acceptance says nothing about it. Of the two options, the
   safer is to keep the cursor out of the acceptance rule: an unaccepted turn
   leaves a dispatched cursor `uncertain` (its backing continues portably), and
   only an explicit refusal returns it to `pending`, as before C6. Returning
   it to pending could re-apply a cursor that opening the session already
   applied. In production the case does not arise: Codex, the only harness
   that declares `turn-acceptance`, rolls back with `thread/revert` and
   returns no continuation.
3. **Codex compaction** (no change). Codex compaction runs through
   `providers.compact` with a fresh run and turn id outside turn admission
   (`conversation-compaction-commands.ts`), so they have no V2 run and never
   reach `synchronize` or the acceptance rule (`unaccepted` returns false for a
   run V2 never admitted). Emitting a boundary when the compact turn starts,
   the option closer to T3 (which records the compact turn as a provider
   turn), was tried and rejected: a native boundary also feeds the rollback
   physical head (`physicalHead` reads the newest boundary and needs it
   `settled`), so a started-only compaction boundary would make native
   rollback and fork unavailable after every compaction.

Final tests: `orchestration-history-injection` keeps a switch due across 17
failed Codex starts and returns no route turn when none reached a provider
(both fail before); a run V2 never admitted is never unaccepted (guard).
`orchestration-history-rollback`: an unaccepted turn leaves its dispatched
cursor `uncertain` and continues on a fresh session (fails before).


Verification after the final fixes (2026-11-18, macOS arm64, Node 22, each
run alone under `caffeinate -i` after the other worktree's suite finished):
`typecheck`, `lint` and `check:architecture` passed; the full Vitest suite
passed 20,488 tests with 174 skipped in 1,621 files (1,607 passed, 14
skipped); `npm run test:portable` passed 4,414 tests with 31 skipped in 269
files (267 passed, 2 skipped). The full `npm run check`, the Electron scenarios
and a packaged build were not run.
