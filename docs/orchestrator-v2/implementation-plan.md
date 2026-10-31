# ORCHESTRATOR V2 implementation

The user authorized implementation on 2026-10-29 and explicitly selected the
audited T3 Code system, superseding the smaller recommendation in
`design-discussion.md`. The branch is `orchestrator-v2`; PR #686 must remain
unmerged. Research snapshots and evidence remain in this directory.

## Completion contract

This is one implementation effort. Intermediate packages are checkpoints, not
completion of V2. A checked item requires production wiring and behavioral
tests, not just interfaces, documentation, or a disconnected prototype.

- [ ] Authoritative typed commands, immutable events, projections, atomic
  receipts/outbox, per-thread command/effect ordering, guarded writes, bounded
  replay, and explicit process-bound versus replay-safe effects.
- [ ] Separate application threads, runs, attempts, provider instances,
  sessions, native thread/turn references, context coverage, and runtime requests.
- [ ] Provider registry/capability contracts, per-model options, account/provider
  changes, switch-back coverage and ordered queued configuration changes.
- [ ] Portable context assembly, bounded deterministic history selection,
  omitted-history retrieval, intact current prompts, delivery state and
  ambiguity handling; native continuation where supported.
- [ ] Lazy forks at stable boundaries, native forks/revert where supported,
  portable cross-provider forks, inherited history and context merge-back.
- [ ] Managed delegation across providers/models, explicit task context,
  permission ceilings, nested completion, stable result generations,
  follow-up/cancel/wait, durable parent inbox and wake acknowledgements.
- [ ] Native children represented separately as observed child threads, with
  provider-specific status/results and supported control operations.
- [ ] Durable message/configuration queues, edits/cancellation/reorder,
  native steering or explicit interrupt/restart fallback, automatic-result
  priority, delivery attribution and retry identities.
- [ ] Restart reconciliation before admission, exact ownership/cleanup,
  persisted questions, expiring approvals, bounded continuation and usage-limit
  recovery with stop/snooze precedence.
- [ ] Typed agent tools for threads, history/search, queues, delegation,
  forks/merge-back, configuration, questions, project/worktree operations,
  attachments, previews and scheduled tasks. Agents cannot approve permissions.
- [ ] General scheduled tasks and durable scheduling/claim/recovery semantics.
- [ ] Pi integration, official Cursor SDK integration, OpenCode 2 integration
  and ACP registry/discovery/authentication, in addition to Codex/Claude and
  existing Inertia providers. Capability gaps are explicit, never fabricated.
- [ ] Client projection/subscription/reconnect, provider changes in timeline,
  lineage/results/queue/fork/scheduling UI, accessible interaction and mobile
  Private Connect equivalents where applicable.
- [ ] Append-only upgrade migrations, representative legacy fixtures,
  deterministic provider fixtures, race/crash/replay coverage, complete
  `npm run check` and required portable/platform checks.
- [ ] PR updated with implementation, evidence and exercised/unexercised
  environments; branch pushed; **no merge into main**.

## Ownership and current package

**Resumed on 2026-10-30 to finish the current phase-3 checkpoint and the
already-started Cursor SDK integration. The user requests commit and push of
this checkpoint, then a stop. V2 remains incomplete and the PR stays draft;
no merge or CI monitoring is authorized. Final verification is recorded in
[phase3-verification.md](phase3-verification.md).**

The primary chat owns the event/command/effect core, schema, runtime integration,
client integration and overall validation. The requested second Astra/XHigh
chat has completed the Codex/Claude native fork and rollback adapter package
and subsequently implemented Pi and OpenCode 2. Cursor SDK and ACP work remains
unfinished at the user-requested pause. Its APIs and validation notes are in
`provider-implementation-progress.md`. Both chats use persistent goals.

**Resumed by the user on 2026-10-30.** PR #686 stays a long-lived draft. The
primary chat resumed with production command ordering and deferred native
rollback (context only, separate from Git reversal); a parallel agent owns the
official Cursor SDK package. Migration 109 is reserved for Cursor SDK.

The user then bounded the current stop point to phase 3 (forks, history
rollback and context merge-back with their in-flight integration), followed by
a comparison against T3 Code `32ecd71726fee16f335484c1f95cbce126d461f6`. Later
phases were deliberately not started; the checklist above stays open.

**Resumed on 2026-10-31.** Phase 0 stabilization is done (see
`implementation-progress.md`). The phase-3 polish package is in progress. T3
Code was recompared at `15fe2832727893cbdd2214383f9f971474849695` (v0.1.6 plus
six commits); the delta and decisions are in `t3code-delta-2026-10-31.md`.
Later phases remain open. PR #686 stays draft; no merge.

Current code and check results are recorded in `implementation-progress.md`.

The first package establishes the transactional core and routes real runtime
admission/lifecycle through it. Inertia's existing process-tree cleanup,
credential isolation, exact workspace authority and scoped filesystem reversal
remain enforced while command authority moves into V2. The implementation uses
the audited T3 semantics; it does not assume that T3's monolithic service layout
or Effect dependency is required to reproduce its system.
