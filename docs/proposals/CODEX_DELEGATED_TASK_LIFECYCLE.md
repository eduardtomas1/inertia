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

When the activity identifies a child:

1. register ownership;
2. emit or enrich a normalized subagent trace;
3. replay buffered child notifications for that child in original arrival order.

### C. Add a bounded pre-registration notification buffer

Child notifications that reference an unowned non-root thread should not be immediately projected and should not be retained without bounds.

Recommended limits:

- maximum 32 candidate child thread IDs;
- maximum 64 notifications per candidate child;
- maximum 256 total pending notifications;
- maximum 1 MiB of serialized bounded notification data;
- maximum age equal to the existing child-drain window or another explicit value no greater than a few seconds.

Only notification methods already recognized as possible child lifecycle methods should be buffered. Approval requests, credential-bearing data, arbitrary server requests, and unrelated notifications must never enter this buffer.

On valid ownership registration, replay the notifications synchronously in arrival order through the same child-notification handler used for normally ordered traffic.

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

Parent completion should continue waiting for known live children for a short bounded period.

Before finalizing the parent:

1. process the parent terminal notification;
2. replay any now-owned pending child notifications;
3. wait for known live child terminal signals up to the configured drain timeout;
4. finalize immediately when no child remains live;
5. after timeout, mark only genuinely unresolved live traces with the uncertainty fallback.

The timeout must never become unbounded and must not delay cancellation.

A child that has already emitted a confirmed successful terminal event must never be changed to `lost` by parent settlement.

### H. Keep `lost` as internal uncertainty, not failure

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

### I. Coordinate with PR #92 without coupling the protocol fix to it

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

---

## Test plan

### Protocol and adapter tests

Target the smallest relevant layer around `CodexAppServerEvents`:

- ownership registration from both sources;
- pending child notification replay;
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

### Renderer tests

Extend `subagent-disclosure.test.ts` and `subagent-disclosure.dom.test.tsx` for:

- neutral `Outcome unavailable` copy;
- confirmed failure remaining visually distinct;
- completed children collapsing normally;
- uncertain outcomes remaining discoverable;
- resumed child showing current live state rather than stale completed result;
- accessible labels containing provider route, current state, and duration;
- group summary distinguishing completed, working, cancelled, failed, and uncertain counts.

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
- [ ] The root thread cannot appear in its own delegated-agent tree.
- [ ] Ownership cycles and contradictory parent assignments are rejected.
- [ ] Nested delegated agents retain correct parentage.
- [ ] A confirmed child `turn/completed` is persisted as completed.
- [ ] Parent settlement cannot rewrite a confirmed child terminal outcome as `lost`.
- [ ] A child with no observed terminal outcome settles after a bounded timeout without blocking the parent indefinitely.
- [ ] A Codex child can resume after a completed episode only from explicit newer provider evidence.
- [ ] Resumption clears stale terminal result text and adopts the new child turn identity.
- [ ] Stale or weaker events cannot overwrite newer authoritative state.
- [ ] Confirmed failure, cancellation, and interruption remain distinct.
- [ ] `lost` is presented as outcome unavailable, not as confirmed failure.
- [ ] A sanitized real-wire fixture reproduces the original failure before the fix and passes after it.
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
