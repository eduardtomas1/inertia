# Inertia research progress

Status: COMPLETE. Both deliverables written and reviewed; ready for coordinator integration and handoff.

- Audited base remains `9340d9f2b66a880890337d1b1563d5944ce7025d`. Branch and Git mutations remain coordinator-owned. This track changed only `inertia-*.md`.
- Deliverables: [current-state audit](inertia-current-state.md) and [source map](inertia-source-map.md), 11,264 words combined at final review, covering the requested boundaries and incremental migration seams.
- Focused check: Node v22.23.2, Darwin arm64, direct Vitest, five files / 85 tests passed. Files: continuation policy, authoritative run state, interleavings, provider capability manifest, harness capabilities. No install/build/native rebuild by this track.
- Full gate: coordinator reports exit 0 with 1,404 files / 17,600 tests passed, 13 files / 149 tests skipped, successful builds/bundle gates. Counts and build/budget tail independently checked in `.cache/orchestrator-v2/npm-check.log`; this track did not rerun it.
- Exact serving model/effort remains unobservable. Effective permissions: unrestricted filesystem, network enabled, approval never. Requested Astra/XHigh is not asserted as independently verified.
- Existing orchestration is substantial: durable turn/operation ledgers, exact ownership, cleanup proof, queue/update/quota/watcher/Duo owners, capability attestation and bounded context. Runtime replay is generation-local in memory, not a durable event store.
- Important lifecycle nuance: bounded failed cleanup can leave a turn visibly terminal while durable provider ownership remains unresolved. Terminal status must not become a cleanup receipt.
- Managed chats differ from provider-native delegates. Managed mutation approval is explicit even in Full Access; completed parent leaves child work running, while non-success cancels only exact dispatched attempts. No general managed-parent completion inbox or DAG scheduler found.
- New nuance recorded: compaction allocates exact provider run/turn correlation IDs but deliberately has no durable AgentTurn. Not all provider work is a user-message turn.
- Native resume, context handoff, crash interruption and planned-update continuation remain distinct. Ordinary sends do not establish a universal lifetime checkout mutex.
- No real provider calls, account/credential inspection, application changes, installation, branch switching, commits, pushes or subagent delegation.
- Final review passed: 176 local document/source links checked for existence and line bounds; 115 unique evidence IDs; balanced fences and valid table blocks; no whitespace-check diagnostics; source SHA unchanged. The V3/V4 table break was fixed. No further edits are planned by this track; coordinator may integrate the deliverables.

## Final comparison cross-check — 2026-10-29

Status: COMPLETE. Read all of `docs/orchestrator-v2/design-discussion.md` and the dossier `README.md` once against the finished Inertia audit. No material factual corrections or contradictions were found in their descriptions of Inertia.

The review specifically checked exact source/target ownership, terminal outcome versus cleanup proof, domain-specific idempotency, native versus managed children, per-call managed mutation approval, route-bound context, crash versus update continuation, current provider breadth, workspace/reversal semantics, and the reported verification scope. Recommendations and proposed acceptance tests are clearly labeled as future work. T3-specific claims were outside this independent cross-check.

Optional clarification, not a required correction: after the proposed-contract diagram's sentence “Prefer adding references to existing turns and ownership records,” consider adding: “This diagram describes the initial turn-based coordination slice; provider control operations such as compaction can have exact run/turn correlation IDs without a durable AgentTurn and should retain that distinction.” The current proposal is not wrong when scoped to its stated first slice. Evidence: current-state section 7; source-map H10; `src/server/runtime/commands/conversation-compaction-commands.ts:325`.

Reviewed file fingerprints:
- `docs/orchestrator-v2/design-discussion.md`: SHA-256 `b27e15b5607824b221e39b78a94f2ad5baed9d224269e11ea33ec4eb42b659ac`.
- `docs/orchestrator-v2/README.md`: SHA-256 `54db305f6884ffc40c9f17e07c74982e5d29f074a03781fa559db768293b02d8`.

Only this progress record was edited. No coordinator document, production code, Git state or tests were changed/run during the cross-check. The bounded review goal is complete.
