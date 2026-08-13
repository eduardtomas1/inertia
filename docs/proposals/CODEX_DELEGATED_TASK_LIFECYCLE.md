# Proposal: reliable Codex delegated-task lifecycle

**Status:** Draft proposal

**Scope:** Codex App Server delegated agents, persistence semantics, regression coverage, and truthful presentation

**Runtime changes in this pull request:** None

## Executive summary

Inertia can currently show a successful Codex delegated agent as red or failed-looking even when the child completed its work correctly.

The failure is not primarily visual. It begins at the Codex App Server protocol boundary:

1. Codex may announce a child thread through parent-side collaboration activity.
2. The child may emit status, activity, text, and `turn/completed` notifications immediately.
3. An explicit child `thread/started` notification carrying the parent relationship may be absent, late, or arrive after child notifications.
4. If Inertia has not registered the child thread as owned by the parent, those child notifications are not projected as delegated-agent lifecycle events.
5. The trace can remain live until the parent settles.
6. Parent settlement converts every still-live delegated trace to `lost`, except when the parent itself was cancelled.
7. The renderer treats `lost` as an outcome that needs review, producing the misleading red result.

This proposal defines a bounded implementation that makes child ownership tolerant of real event ordering, preserves authoritative outcomes, allows a successfully completed Codex child to be reused, and presents missing lifecycle evidence as uncertainty rather than failure.

The recommended implementation is deliberately narrower than a general agent-system rewrite. It keeps Inertia's local-first architecture, current provider contracts, and existing delegated-agent UI.

---

## Problem statement

### User-visible symptom

A Codex parent agent delegates work to one or more child agents. The child performs the work and the transcript may contain its successful result, but Inertia later displays the child with a red state such as `Lost` or another failed-looking outcome.

This breaks trust in the execution ledger: the user cannot tell whether the child failed, completed, was cancelled, or merely stopped reporting before Inertia observed a terminal event.

### Current implementation boundaries

The relevant code is concentrated in:

- `src/server/codex/app-server-events.ts`
  - recognizes Codex App Server notifications;
  - tracks child ownership and child lifecycle projection;
  - drains child activity before completing the parent run.
- `src/server/provider/codex-app-server-harness.ts`
  - forwards normalized delegated-agent updates through the provider emitter.
- `src/server/runtime/turns/turn-provider-event-projector.ts`
  - persists normalized `subagent` provider events.
- `src/server/persistence/execution-ledger-repository.ts`
  - resolves delegated-agent identity, rejects stale events, and currently prevents a terminal trace from becoming live again.
- `src/server/runtime/turns/turn-settlement-coordinator.ts`
  - settles every remaining live trace as `cancelled` when the parent is cancelled, otherwise as `lost`.
- `src/renderer/src/utils/subagentDisclosure.ts`
  - classifies `failed`, `interrupted`, `lost`, and `unknown` as outcomes needing review.
- `src/renderer/src/components/SubagentDisclosure.tsx`
  - renders status, hierarchy, route, duration, details, Stop, and Guide parent controls.

### Real protocol ordering that must be supported

The adapter must not assume this idealized order:

```text
child thread/started
child turn/started
child activity
child turn/completed
parent turn/completed
```

Codex can instead produce an order equivalent to:

```text
parent collaboration activity announces child thread
child status/activity/turn notifications
child turn/completed
parent turn/completed
```

The parent-side collaboration event can be the first authoritative ownership signal. Child notifications can also race with registration.

The implementation must therefore treat ownership discovery and child lifecycle projection as two cooperating concerns rather than requiring one specific notification order.

---

## Root causes

### 1. Child ownership has more than one authoritative source

Inertia already supports explicit child `thread/started` registration, but real Codex traffic can identify the child first through parent-side collaboration activity.

If that activity is rendered only as parent transcript activity and is not also used to register the child relationship, subsequent child notifications are not recognized as belonging to the active parent tree.

### 2. Child notifications can precede registration

Even after parent-side ownership registration is added, the transport can deliver child notifications before the ownership event is processed.

Ignoring those notifications permanently loses the only successful terminal signal. Accepting arbitrary unowned notifications would be unsafe. The adapter needs a small, bounded pending-notification buffer keyed by child thread identity.

### 3. Parent settlement turns missing evidence into `lost`

`TurnSettlementCoordinator` currently settles every still-live delegated trace as:

- `cancelled` when the parent turn is cancelled;
- `lost` for every other parent terminal outcome.

That fallback is useful for preventing permanently live UI, but it becomes misleading when a child terminal event was emitted by Codex and merely missed by the ownership/projection layer.

The fallback must remain, but it should occur only after the Codex adapter has completed its bounded child-drain period and replayed any newly owned child notifications.

### 4. A terminal child identity cannot currently resume

`ExecutionLedgerRepository.upsertSubagentTrace` treats a known terminal trace as immutable and rejects a later live update for the same identity.

That protects against stale or replayed events, but Codex child threads are reusable. A child can complete one delegated turn, become idle, and later receive another turn within the same parent run.

Terminality belongs to the child execution episode, not necessarily to the reusable child thread identity.

### 5. `lost` is presented too similarly to failure

`lost` means Inertia ended local tracking without receiving an authoritative terminal outcome. It does not mean Codex reported that the delegated task failed.

The UI must reserve failure language and danger treatment for confirmed failures.

---

## Goals

The implementation should:

1. Register Codex child ownership from both explicit child-thread starts and parent-side collaboration activity.
2. Tolerate child notifications arriving before ownership registration without accepting unrelated provider traffic.
3. Prevent the root thread from becoming its own child and prevent ownership cycles.
4. Preserve nested delegated-agent hierarchy.
5. Project successful, failed, cancelled, interrupted, waiting, and uncertain outcomes truthfully.
6. Allow an explicitly resumed Codex child to become live after a previous completed episode.
7. Prevent stale lower-sequence events from reviving or overwriting newer state.
8. Avoid converting a confirmed successful child into `lost` during parent settlement.
9. Keep all protocol buffers bounded by count, size, and time.
10. Add a sanitized real-wire regression fixture that exercises the complete adapter path.
11. Preserve Claude, Cursor, and OpenCode behavior.

## Non-goals

This proposal does not:

- replace the delegated-agent UI;
- redesign the entire provider abstraction;
- add a hosted relay, remote runtime, or cloud control plane;
- add Grok Build or another provider;
- persist raw provider protocol frames;
- expose private prompts, local paths, repository identifiers, credentials, or unredacted logs;
- add complete per-episode delegated-agent history in the first implementation;
- duplicate the broader main-agent execution-state redesign proposed by draft PR #92.

---

## Proposed design

### A. Introduce an explicit Codex child-ownership registry

Within `CodexAppServerEvents`, maintain a registry keyed by child thread ID:

```ts
interface CodexChildOwnership {
  childThreadId: string;
  parentThreadId: string;
  source: "thread-started" | "collaboration-activity";
  registeredAtSequence: number;
}
```

The registry remains in memory for the lifetime of the active Codex App Server run. Raw provider payloads are not persisted.

Ownership can be registered from either:

1. `thread/started` when the notification explicitly identifies an owned parent thread;
2. a parent-side collaboration/subagent activity item that identifies the target child thread and an owned source parent thread.

#### Registration invariants

A candidate relationship is accepted only when:

- child and parent IDs are bounded non-empty strings;
- the parent is the root thread or an already owned descendant;
- child ID differs from the root thread ID;
- child ID differs from parent ID;
- following parent links cannot create a cycle;
- an existing child relationship is not silently reassigned to a different parent;
- the active run has not settled.

Repeated equivalent registration is idempotent.

A contradictory relationship should be ignored and recorded only as a bounded sanitized diagnostic activity. It must not cancel an otherwise healthy run unless the event violates an existing security boundary.

### B. Parse parent-side collaboration activity as lifecycle evidence

The adapter should add a narrowly scoped parser for the Codex activity/item shape that represents child creation, interaction, waiting, resumption, and shutdown.

The parser must be version-tolerant without guessing. At proposal review time,
the CLI-generated v2 schema exposes `collabAgentToolCall` with
`receiverThreadIds`/`agentsStates` plus `subAgentActivity`, while the current
[official App Server documentation](https://developers.openai.com/codex/app-server/)
describes the newer `collabToolCall` shape with singular
`receiverThreadId`/`newThreadId`/`agentStatus` fields. Treat these as explicit,
separately tested wire variants that normalize to one internal structure. An
unknown item type or an incomplete hybrid of the two shapes remains ordinary
bounded activity and must not register ownership.

The parser should return a normalized internal structure rather than exposing raw JSON beyond the protocol layer:

```ts
interface ParsedCodexCollaborationActivity {
  parentThreadId: string;
  childThreadId: string;
  childTurnId: string | null;
  action:
    | "spawned"
    | "interacted"
    | "waiting"
    | "resumed"
    | "shutdown"
    | "unknown";
  role: string | null;
  name: string | null;
  summary: string | null;
}
```

The exact accepted field names must be derived from a captured, redacted Codex App Server fixture. Unknown or future activity shapes should remain ordinary bounded activity and must not be guessed into lifecycle transitions.

Collaboration prompts and raw reasoning are not display metadata. They may be
used transiently by Codex itself, but the adapter must not copy them into a
delegated trace description, progress, result, diagnostic, log, or renderer
event. A trace can use bounded explicit role/name metadata, an allowlisted
provider status message, final child agent output, or neutral local copy.

When the activity identifies a child:

1. register ownership;
2. replay buffered child notifications for that child in original arrival
   order, because they preceded the registering activity on the wire;
3. emit or enrich a normalized subagent trace from the registering activity,
   subject to the same authority/sequence guard as any later state snapshot.

Reversing steps 2 and 3 can make an earlier buffered `turn/started` look like a
new resume after a later terminal collaboration snapshot. Ownership discovery
must not reorder lifecycle evidence.

### C. Add a bounded pre-registration notification buffer

Child notifications that reference an unowned non-root thread should not be immediately projected and should not be retained without bounds.

Recommended limits:

- maximum 32 candidate child thread IDs;
- maximum 64 notifications per candidate child;
- maximum 256 total pending notifications;
- maximum 1 MiB of serialized bounded notification data;
- maximum age equal to the existing child-drain window or another explicit value no greater than a few seconds.

Only notification methods and item variants already recognized as possible
child lifecycle evidence should be buffered. Parse them first into a bounded,
allowlisted internal envelope containing only the required thread/turn/item
identities, lifecycle status/error metadata, and sanitized final child-agent
text. Do not retain whole JSON-RPC params merely because their method is
allowlisted: raw reasoning content, collaboration prompts, command input or
output, paths, environment data, approvals, credentials, arbitrary server
requests, and unrelated item bodies must never enter this buffer.

On valid ownership registration, replay the normalized envelopes
synchronously in original arrival order through the same child lifecycle
projector used for normally ordered traffic. Replay must not reconstruct or
re-emit discarded raw fields.

An otherwise-valid child ownership announcement whose parent is not yet owned
is a deferred ownership prerequisite, not an immediate rejection. Keep it in
the same count, byte, and age bounds, keyed by its missing parent. When that
parent becomes owned, validate and replay newly unlocked child edges in wire
order, iterating through descendants under the same root/self, cycle,
contradictory-parent, and duplicate guards. This allows grandchild ownership
and lifecycle traffic to arrive before the parent edge without guessing or
leaving the descendant stranded.

The allowlist includes a bounded normalization of child
`thread/status/changed` notifications. Preserve only thread identity and the
documented status kind/waiting flags. Status is weaker authority than explicit
turn start/terminal evidence: it may describe a live child as active or
waiting, but a late generic active status cannot create a new episode or
revive a terminal one. Pre-registration status envelopes follow the same
bounded replay rules as other lifecycle evidence.

On timeout, contradictory ownership, parent cancellation, transport close, or disposal, discard the pending candidate without persisting raw content.

### D. Define child thread identity separately from child turn identity

For Codex:

- `providerAgentId` should represent the reusable child thread ID;
- `providerTaskId` should represent the current child turn/episode ID when available;
- `providerToolUseId` should remain the collaboration/tool activity identity when available.

`providerAgentId` is the primary matching identity for Codex child state. A new child turn ID can replace the previous episode-local task ID after an explicit resume/start event.

The adapter must not create two simultaneous live traces for the same Codex child thread within one run.

### E. Permit controlled child resumption

The current persistence rule should be narrowed rather than removed.

A terminal trace may become live again only when all of the following are true:

- provider is Codex App Server;
- the event has a strictly greater monotonic sequence;
- the event is derived from explicit provider evidence of a new child turn or resume, not a generic status string;
- `providerAgentId` matches the existing reusable child thread;
- the parent run is still active;
- the transition does not conflict with a newer task ID or terminal event.

On a valid resume:

- replace the episode-local `providerTaskId` when a new child turn ID is available;
- set the normalized state to live;
- clear the previous episode's terminal `result` so it is not shown as current progress;
- preserve stable role/name/parent identity;
- emit progress such as `Resumed by parent agent` only when Codex did not provide a more useful bounded summary.

A stale lower-sequence event remains a no-op.

A generic late `running` event without explicit resume/start evidence must not revive a terminal trace.

#### Persistence API recommendation

Do not encode the resumption exception as a broad `allowTerminalRevival` boolean supplied by arbitrary callers. Add a typed transition reason to the normalized provider event or persistence input:

```ts
type SubagentLifecycleEvidence =
  | "activity"
  | "state"
  | "turn-started"
  | "turn-terminal"
  | "explicit-resume"
  | "settlement-fallback";
```

The repository can then enforce the transition matrix centrally.

### F. Make authority and sequence rules explicit

The Codex adapter already distinguishes activity, state, and turn authority. The implementation should formalize the following ordering:

```text
turn-terminal > turn-started/explicit-resume > state > activity > settlement-fallback
```

Rules:

- sequence is the first stale-event guard;
- for equal logical generations, stronger authority may enrich or settle weaker state;
- weaker activity cannot overwrite a confirmed turn terminal outcome;
- settlement fallback cannot overwrite a confirmed terminal outcome;
- an explicit later child turn start creates a new live episode even though the previous episode ended successfully;
- a confirmed child failure must not be rewritten as success by a late activity summary from the same episode.

The implementation should keep this logic in one testable helper rather than spreading status precedence across notification branches.

### G. Preserve the bounded parent-completion drain

Parent completion should continue waiting for known live children and
non-expired lifecycle-eligible pending candidates for a short bounded period.

Before finalizing the parent:

1. process the parent terminal notification;
2. replay any now-owned pending child notifications and ownership prerequisites;
3. wait for known live child terminal signals and non-expired pending
   candidates/prerequisites up to the configured drain timeout;
4. finalize immediately only when no child remains live and no eligible
   pending candidate or prerequisite remains;
5. when ownership arrives during the drain, validate/replay it before
   re-evaluating completion;
6. after timeout, discard unresolved orphan candidates and mark only genuinely
   unresolved owned live traces with the uncertainty fallback.

The timeout must never become unbounded and must not delay cancellation.
Cancellation clears pending candidates and prerequisites immediately under the
transport cleanup barrier. In particular, `child turn/completed -> parent
turn/completed -> ownership activity` must replay the child before parent
finalization, while a genuinely unrelated orphan candidate expires without
holding the parent indefinitely.

A child that has already emitted a confirmed successful terminal event must never be changed to `lost` by parent settlement.

### H. Define reconnect, restart, and cleanup ownership

The ownership registry and pending buffer are transport-owned, in-memory state;
they are never restored from the database or transferred to a replacement
provider process.

- A renderer reconnect reloads the already persisted delegated traces for the
  active run and does not reset adapter sequence, duplicate registration, or
  replay raw provider traffic.
- A Codex transport close, cancellation, or adapter disposal clears every
  pending envelope, child result accumulator, drain timer, and ownership link
  before provider cleanup can be reported complete.
- A utility-runtime restart must not revive the previous transport registry.
  Existing recovery semantics settle the interrupted parent and any still-live
  delegated traces once, using `cancelled` only with cancellation evidence and
  the neutral uncertainty fallback otherwise.
- Notifications from an old transport generation cannot be accepted by a new
  run or mutate its traces, even when provider thread IDs are reused.

These are cleanup and ownership barriers, not a request to persist raw wire
traffic or silently reconnect an interrupted provider process.

### I. Keep `lost` as internal uncertainty, not failure

The first implementation can keep the existing persisted `lost` value to avoid an unnecessary database migration, but its user-facing meaning should change.

Recommended labels:

| Internal state | User-facing label | Meaning |
|---|---|---|
| `completed` | Completed | Codex reported successful child-turn completion |
| `failed` | Failed | Codex reported failure |
| `cancelled` | Cancelled | Codex or the user cancelled/stopped the child |
| `interrupted` | Interrupted | Execution was interrupted |
| `lost` | Outcome unavailable | Tracking ended without a terminal provider outcome |
| terminal `unknown` | Unknown provider outcome | Codex reported a terminal state Inertia could not classify |

`lost` and terminal `unknown` may request review, but they should use neutral/warning treatment rather than the same danger treatment as confirmed failure.

The detail for `lost` should explain the cause when known, for example:

> The parent turn ended before Inertia received this delegated task's final provider outcome.

Do not claim the delegated work failed.

### J. Coordinate with PR #92 without coupling the protocol fix to it

Draft PR #92 proposes a broader visual language for truthful main-agent states. This implementation should reuse compatible tokens and copy where practical.

However, the protocol and persistence fix must be independently correct. Merging a visual redesign cannot repair missed child registration or terminal events.

Recommended dependency order:

1. merge the Codex lifecycle and regression fix;
2. rebase or coordinate delegated-agent visual refinements with #92;
3. keep any large transcript redesign outside this change.

---

## Required regression fixture

### Why a real-wire fixture is mandatory

The existing delegated-agent tests cover many synthetic cases, but a synthetic fixture that always emits child `thread/started` before child events cannot reproduce this defect.

Add a sanitized fixture captured from a real Codex multi-agent App Server run. It must preserve:

- JSON-RPC method names;
- event ordering;
- root thread, child thread, turn, item, and tool-use relationships;
- parent-side collaboration activity;
- child status/activity/text/terminal notifications;
- parent completion ordering.

It must replace all sensitive values with stable placeholders:

- prompts and generated prose;
- usernames and home paths;
- repository names and remotes;
- account identifiers;
- tokens, credentials, environment values, and rate-limit account metadata;
- proprietary source code;
- machine-specific paths.

The fixture must be deterministic and secret-free so it can run in CI and `npm run test:portable`.

### Minimum replay scenarios

The fixture suite should cover:

1. parent collaboration activity registers a child without an earlier child `thread/started`;
2. child notifications arrive before registration and are replayed;
3. explicit child `thread/started` still works;
4. the root thread is never registered as its own child;
5. nested child ownership is retained;
6. child successful completion is persisted before parent completion;
7. parent completion does not convert that child to `lost`;
8. parent completion arrives before the final child signal and drains successfully;
9. a genuinely missing child terminal signal becomes `lost`/Outcome unavailable after the bounded timeout;
10. the same child thread completes, resumes with a new child turn, and completes again;
11. stale events from the first child turn cannot overwrite the resumed state;
12. confirmed child failure remains failed;
13. cancellation settles live children as cancelled;
14. unowned child traffic is discarded after bounds expire;
15. malformed or oversized collaboration activity is ignored safely.
16. both the generated `collabAgentToolCall` variant and documented
    `collabToolCall` variant normalize to the same ownership transition;
17. reasoning, collaboration prompts, commands, paths, and unrelated item
    bodies never enter pending envelopes or persisted/renderer traces.
18. a child terminal envelope preceding parent completion and a later ownership
    activity participates in the bounded drain and is persisted before parent
    finalization;
19. an unrelated orphan candidate expires without making parent completion
    unbounded;
20. grandchild ownership and lifecycle arriving before its parent edge replay
    in wire order once the parent becomes owned;
21. child `thread/status/changed` active/waiting evidence replays below turn
    authority and cannot revive a terminal episode.

---

## Test plan

### Protocol and adapter tests

Target the smallest relevant layer around `CodexAppServerEvents`:

- ownership registration from both sources;
- pending child notification replay;
- pending-candidate participation in parent drain and bounded orphan expiry;
- deferred nested ownership replay when a prerequisite parent arrives;
- bounded child `thread/status/changed` active/waiting normalization;
- cycle and root-self guards;
- nested ownership;
- authority precedence;
- parent drain timing;
- transport close and cancellation;
- sequence monotonicity;
- explicit resume evidence.

### Persistence tests

Extend execution-ledger coverage for:

- explicit controlled `completed -> running` resumption;
- replacement of episode-local task identity;
- clearing stale terminal result on resume;
- rejection of generic or stale revival;
- preservation of confirmed failure/cancellation;
- parent linkage when children are observed before their parent trace;
- settlement fallback never overwriting an existing terminal trace.

### Runtime projection tests

Verify that normalized provider events:

- persist once;
- broadcast once;
- survive snapshot reload;
- remain attached to the authoritative conversation/run/turn identity;
- do not leak raw provider data.

### Reconnect, restart, and cleanup tests

Verify that:

- renderer reconnect hydrates one copy of each persisted child trace while the
  active adapter continues with monotonic sequence;
- transport close and cancellation discard pending envelopes and child result
  accumulators before cleanup is confirmed;
- utility-runtime restart settles interrupted live children once and cannot
  replay an old transport generation into a resumed conversation;
- snapshot reload preserves confirmed terminal child outcomes and neutral
  uncertainty copy without requiring raw-wire persistence.

### Renderer tests

Extend `subagent-disclosure.test.ts`, `subagent-disclosure.dom.test.tsx`, and
`goal-panel.dom.test.tsx` for:

- neutral `Outcome unavailable` copy;
- confirmed failure remaining visually distinct;
- completed children collapsing normally;
- uncertain outcomes remaining discoverable;
- resumed child showing current live state rather than stale completed result;
- accessible labels containing provider route, current state, and duration;
- Goal Panel rows exposing the same truthful state and duration semantics as
  the disclosure, including neutral/warning treatment for unavailable outcomes
  rather than the existing failure/danger styling;
- group summary distinguishing completed, working, cancelled, interrupted,
  failed, and uncertain counts without collapsing interruption into failure or
  uncertainty.

Audit the corresponding `GoalPanel.tsx` and delegated-state CSS selectors as
part of the implementation. Every delegated-work surface must render `lost` as
neutral `Outcome unavailable`, preserve interruption as its own outcome, and
provide route, state, and duration in its accessible name.

### Full verification

The implementation PR must run:

```sh
npm run check
npm run test:portable
```

Any platform/provider surface not exercised must be stated explicitly in the PR handoff.

---

## Acceptance criteria

The implementation is complete when all of the following are true:

- [ ] Parent-side Codex collaboration activity can authoritatively register a child thread.
- [ ] Explicit child `thread/started` registration remains supported.
- [ ] Child notifications received shortly before registration are replayed within strict bounds.
- [ ] Non-expired pending child candidates participate in the bounded parent
      drain; unrelated orphans expire without blocking completion indefinitely.
- [ ] Deferred nested ownership replays when its prerequisite parent becomes
      owned, including grandchild-before-parent ordering.
- [ ] Buffered child notifications remain ordered before the later activity or
      thread event that registered their ownership.
- [ ] The root thread cannot appear in its own delegated-agent tree.
- [ ] Ownership cycles and contradictory parent assignments are rejected.
- [ ] Nested delegated agents retain correct parentage.
- [ ] A confirmed child `turn/completed` is persisted as completed.
- [ ] Parent settlement cannot rewrite a confirmed child terminal outcome as `lost`.
- [ ] A child with no observed terminal outcome settles after a bounded timeout without blocking the parent indefinitely.
- [ ] A Codex child can resume after a completed episode only from explicit newer provider evidence.
- [ ] Resumption clears stale terminal result text and adopts the new child turn identity.
- [ ] Stale or weaker events cannot overwrite newer authoritative state.
- [ ] Child status notifications expose active/waiting truth below turn
      authority and cannot revive a terminal episode.
- [ ] Confirmed failure, cancellation, and interruption remain distinct.
- [ ] `lost` is presented as outcome unavailable, not as confirmed failure.
- [ ] Subagent Disclosure and Goal Panel both present unavailable,
      interrupted, failed, cancelled, completed, and working states truthfully
      with route/state/duration accessibility coverage.
- [ ] A sanitized real-wire fixture reproduces the original failure before the fix and passes after it.
- [ ] Generated and documented collaboration-item variants normalize without
      guessing at unknown or hybrid payloads.
- [ ] Pending buffering, persistence, diagnostics, and renderer events exclude
      raw reasoning, collaboration prompts, commands, paths, and unrelated item
      bodies.
- [ ] Renderer reconnect and utility-runtime restart preserve exact ownership,
      cleanup, and no-stale-replay barriers.
- [ ] Claude, Cursor, and OpenCode delegated-agent tests remain green.
- [ ] `npm run check` and `npm run test:portable` pass.

---

## Implementation sequence

### Phase 1 — Reproduce

1. Capture and redact a real Codex multi-agent App Server sequence.
2. Add a replay test that currently demonstrates the successful child ending as live/lost.
3. Confirm the test fails for the expected ownership/ordering reason rather than renderer styling.

### Phase 2 — Ownership and buffering

1. Add the narrow collaboration-activity parser.
2. Register child ownership from parent activity.
3. Add bounded pre-registration buffering and replay.
4. Add root-self, cycle, and contradictory-parent guards.

### Phase 3 — Lifecycle and persistence

1. Centralize Codex child authority/transition logic.
2. Add typed lifecycle evidence.
3. Permit explicit newer child resumption.
4. Clear episode-local stale result/task state on resume.
5. Ensure parent fallback cannot overwrite confirmed terminals.

### Phase 4 — Truthful presentation

1. Relabel `lost` as Outcome unavailable.
2. Separate warning/uncertainty styling from confirmed failure.
3. Improve group summary counts without expanding successful history by default.
4. Coordinate visual tokens with #92.

### Phase 5 — Verification

1. Run focused adapter, persistence, runtime, and renderer suites.
2. Run `npm run check`.
3. Run `npm run test:portable`.
4. Manually exercise one real Codex multi-agent run when credentials and the current CLI are available.

---

## Risks and mitigations

### Risk: accepting unrelated child traffic

**Mitigation:** only register children from an already owned parent, validate bounded IDs, prevent cycles, and buffer only recognized child notification methods for a short period.

### Risk: stale events revive completed work

**Mitigation:** require strictly greater sequence plus explicit turn-start/resume evidence; generic activity/status cannot revive terminal state.

### Risk: a reused child erases useful history

**Mitigation:** keep this change focused on truthful current state and preserve prior terminal activity in the transcript. Complete per-episode delegated-agent history can be designed separately if product demand justifies a schema extension.

### Risk: parent completion is delayed

**Mitigation:** retain the existing short bounded drain timeout; cancellation bypasses waiting; no retry loop is unbounded.

### Risk: provider-specific logic leaks into shared runtime

**Mitigation:** parse Codex protocol evidence inside the Codex adapter, then emit a normalized typed lifecycle event. Shared persistence enforces generic transition invariants without understanding raw Codex JSON.

### Risk: raw captured traffic leaks private data

**Mitigation:** fixture review must reject prompts, source, paths, remotes, account data, tokens, and environment values. Keep only stable placeholders and protocol structure.

---

## Rollout and observability

No feature flag should be necessary if the implementation is fixture-backed and preserves existing normalized contracts.

Add only bounded, sanitized diagnostics for:

- rejected child self-registration;
- contradictory parent assignment;
- pending child buffer overflow/expiry;
- unresolved child count at drain timeout;
- explicit child resumption.

Diagnostics must contain opaque shortened identities at most, never prompts, paths, commands, provider payloads, or credentials.

The release note should describe the user-visible result, not the internal protocol details:

> Codex delegated agents now retain accurate completion states across real multi-agent event ordering and reuse, and missing outcomes are no longer shown as confirmed failures.

---

## Migration impact

The recommended first implementation does not require a new table.

If a contract field for lifecycle evidence is runtime-only, no database migration is needed. If persisted state must distinguish uncertainty reasons, add an append-only transactional migration and test upgrades from representative older fixtures.

Do not rewrite released migrations.

---

## Research baseline

This proposal was prepared from a read-only audit of:

- Inertia `main` at commit `86c4b87af863836b09faa3931e8100c9225b909a`;
- `pingdotgg/t3code` at commit `b73232b` as a comparative implementation and real-protocol-fixture reference.

The comparison is used only to identify protocol behavior and testing gaps. The proposed design remains aligned with Inertia's existing architecture and does not copy t3code's monorepo or remote-control-plane design.

---

## Decision requested

Approve this proposal as the implementation contract for a follow-up Codex thread and code PR.

The implementation PR should reference this document, keep changes focused on the listed acceptance criteria, and report any protocol behavior that could not be exercised against a real Codex App Server run.
