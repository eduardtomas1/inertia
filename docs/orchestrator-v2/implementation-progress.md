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
the V2 projection transactionally. Unconfirmed cleanup blocks replacement work;
queued messages remain waiting until exact cleanup is confirmed. Restart retires
old process-bound effects and reconciles run projections before admission.
Original human send requests can replay their accepted result after a lost
acknowledgement, including after restart, without becoming a follow-up.

The event store also supports bounded reads, projection rebuild, optimistic
revision checks and actor-scoped command collision detection. The outbox has
ordered per-thread claims, fenced claim acknowledgements, explicit replay
policy and bounded retries. Generic asynchronous command lanes and the effect
dispatcher are implemented/tested infrastructure; the existing controller still
executes the start effect directly. Other command families have not yet moved
to V2. This checkpoint is not full event-sourced transcript/provider control.

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
T3's 16k default / 64k maximum budget, current-prompt reservation, known native
occupancy, context-window and response reserves. Recent user/assistant and
opening messages receive priority; the final order remains chronological.
Oversized entries are omitted whole. Provenance and omitted-history retrieval
instructions accompany the handoff. Historical attachments, private reasoning
and live tool state are not replayed. Existing endpoint containment, file-change
metadata, authorized chat references and watcher attribution are preserved.

Native provider backings now have durable instance/workspace/session identity
and bounded item coverage. A tested Codex → Claude → Codex round trip resumes the
original Codex session and delivers only intervening context. Uncertain handoff
delivery prevents native reuse; an ordinary outage alone does not retire a
valid session. Preparation, dispatch, delivery, abandonment and uncertainty are
separate durable states. Rejected native resumes can persist a replacement
handoff before fresh-session retry. Projection replay reproduces backing state.

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
  then portably. No native operation is replayed.
- **Retained history.** Rolled-back turns stay in the transcript as audit
  history but are excluded from portable history, fork capture and future
  context handoffs; forking from a rolled-back turn is refused. Inherited fork
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
| Delta content | Compact summary lines incl. commands and file changes; at `15fe2832` rolled-back runs and cancelled queued messages excluded | Bounded message excerpts via packets; rolled-back turns excluded; commands/file changes not included |
| Initiator | User or agent (MCP tool) | User only; agent tool deferred with the agent-tool phase |
| Rollback | Checkpoint rollback coordinates native rollback and optional file restore; rolled-back runs kept as audit | Context rollback separate from Git `checkpoint.revert`; native or portable, audit history kept; no combined file restore |

Upstream since the old pin (all 2026-10-29): `6b1245cc` (Stop always completes,
force stop), `6d12bb1e` (Stop during restart), `36dac688` (restart continuation
retries/parent stop) and `8ab098a4` (held queue release). Phase-3 impact: Inertia
rollback/merge-back already refuse while a run is active, cleanup is pending or
unconfirmed, or a native control is uncertain, and only exact cleanup evidence
releases them; a deferred cursor survives a start that never dispatched. Force
stop, held-queue release and parent-stop continuation semantics belong to the
queue/delegation phases and were not implemented here.

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
  changed, or too many files changed.
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
the macOS lifecycle sentinel and queued messages waited until restart. Stop must
always complete (T3 Code 6b1245cc): the stop ladder's terminal release is now
authoritative evidence that the runtime handed the unconfirmed tree to the
process guardian and no longer owns it. The attempt records
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
