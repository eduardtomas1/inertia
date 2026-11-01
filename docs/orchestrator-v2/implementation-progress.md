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
A human `message.send` that creates a new turn replays its accepted result
after a lost acknowledgement, including after restart, without becoming a
follow-up (`turn-repository.ts:84-88`). Steer and follow-up dispositions carry
no receipt (`src/server/runtime/commands/turn-interaction-commands.ts:349-411`),
and the desktop renderer mints a fresh `requestId` for every command
(`src/renderer/src/lib/runtimeCommands.ts:11-13`), so replay helps only a
caller that resends the same request id.

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
delivers the intervening context. Items omitted from a delivered handoff are not
counted as covered and are offered again on the next switch-back
(`src/server/orchestration-v2/backing-repository.ts:141-147`). Uncertain handoff
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
as a documented difference; flagging the attempt unresponsive while escalation
runs is planned with the Stop command work (G5). The stop ladder's terminal
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
  attempt will be flagged unresponsive while escalation runs, and Stop becomes
  a receipted durable command with a process-bound interrupt effect, in G5.
- **File restore.** T3's isolation rule is adopted in addition to the
  time-bounded check (landed in G3).
- **Crash and shutdown continuation.** Decided in the recovery phase; recorded
  as a tracked gap, not a deliberate difference.

Authoritative V2 commands today: new-turn `message.send`,
`conversation.fork`, `conversation.rollback` and `conversation.merge-back` are
receipted; `checkpoint.revert` and first-send fork preparation are ordered on
the conversation lane without a receipt. Stop, steer and follow-up sends,
configuration, queue edits and approvals bypass V2.

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
