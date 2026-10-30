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
