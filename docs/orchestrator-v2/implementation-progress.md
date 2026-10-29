# Implementation progress

V2 is **in progress**, not complete. The full target remains
[implementation-plan.md](implementation-plan.md). No merge is authorized.

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

## Next integration work

Provider backing/session history and coverage; deterministic portable context;
native/portable fork and deferred rollback integration; remaining commands,
effect publication and client projections. The second Astra chat is implementing
Pi after completing the Codex/Claude native-operation adapter package. All other
full-scope items remain open on the completion checklist.
