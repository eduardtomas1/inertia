# ORCHESTRATOR V2 — research and implementation

Research date: **2026-10-29**. The research phase is complete. The user subsequently authorized coding and explicitly selected the full audited T3 Code orchestration system. Implementation is underway on `orchestrator-v2`; PR #686 must remain unmerged.

**Current scope:** [Implementation plan and completion contract](implementation-plan.md). The earlier incremental recommendation in the design discussion is superseded by the user's direction. The evidence in the research documents remains useful; its proposed scope does not constrain this implementation.

## Reading order

| Document | Purpose |
| --- | --- |
| [Implementation plan](implementation-plan.md) | Full T3 target, completion checklist, active ownership and integration boundaries. Start here. |
| [Implementation progress](implementation-progress.md) | Production integration checkpoints, executed checks and remaining work. |
| [Design discussion and comparison](design-discussion.md) | Research comparison and historical proposal; the reduced-scope recommendation is superseded. |
| [Inertia current state](inertia-current-state.md) | Independent audit of current execution, providers, contexts, managed/native children, workflows, persistence, workspace and client behavior. |
| [Inertia source map](inertia-source-map.md) | Implementation symbols, line anchors, inspected test assertions and audit limitations. |
| [T3 orchestration study](t3code-orchestration.md) | Domain model, transaction/outbox boundary, provider transitions, handoff/fork/delegation, recovery, MCP and migration. |
| [T3 evolution](t3code-evolution.md) | Original merge versus stable releases/current source, later corrections and stale-documentation findings. |
| [Announcement coverage](announcement-coverage.md) | Where each visible feature category from the supplied posts/screenshots was investigated, with evidence levels. |
| [T3 source map](t3code-source-map.md) | 28 source groups and concrete implementation landmarks, pinned to the audited commit. |
| [Verification](verification.md) | Executed checks, results and behavior not exercised. |
| [Source manifest](source-manifest.json) | Machine-readable revision/release provenance, source groups, landmarks and selected evolution commits. |
| [Research brief](research-brief.md) | Authorized scope, two-chat assignment, goal and completion standard. |
| [Inertia research record](inertia-research-progress.md) | Independent chat's goal/access confirmation and audit completion record. |

## Snapshot boundaries

| Software | Pinned revision |
| --- | --- |
| Inertia audit base | `9340d9f2b66a880890337d1b1563d5944ce7025d` — v0.0.80, `origin/main` when research began |
| [T3 PR #2829 merge](https://github.com/pingdotgg/t3code/pull/2829) | `de343914273eceb852a1d1d739cd1d38df7796ee` — October 2 |
| [T3 current source](https://github.com/pingdotgg/t3code/commit/dd148481531a0a090780a2ade20588566db099a2) | `dd148481531a0a090780a2ade20588566db099a2` — October 29, 20:43:23 UTC |

The latest stable observed was v0.1.5; current-source claims are not a promise that every feature shipped in that release. The first stable V2 was v0.1.0 on October 15. All release boundaries are in the manifest.

## Findings that change the proposed approach

- Inertia's renderer event sequence is a bounded, generation-scoped replay mechanism. T3's domain events, command receipts and effect outbox are durable. These solve different problems; adopting durable work intent does not require replacing the entire renderer protocol.
- Inertia's managed chats already have lineage, ownership, limits and exact-target cancellation. A general parent result inbox/wake contract is the missing coordination piece, rather than child creation itself.
- T3's provider handoff is explicitly lossy and budgeted. Current code uses deterministic historical-entry selection and delivery coverage; it does not clone private/native execution state.
- Native child visibility, managed delegation and conversation forks are different concepts in both studies. Their control and completion rights must remain explicit.
- T3's later fixes concentrate on races between restart, Stop, input, background children and delivery. One approval feature was reverted; several old design notes are stale. The dossier records these corrections rather than treating announcement bullets as specifications.

## Local evidence and reproducibility

The pinned T3 checkout is available locally at `.cache/orchestrator-v2/t3code`. The cache also contains the public PR/release/migration metadata, selected history and Inertia verification logs. It is ignored by Git; the PR contains the durable research documents and manifest, not a vendor copy of T3 or build artifacts.

Useful read-only commands from the Inertia directory:

```sh
git -C .cache/orchestrator-v2/t3code rev-parse HEAD
git -C .cache/orchestrator-v2/t3code show de343914273eceb852a1d1d739cd1d38df7796ee:apps/server/src/orchestration-v2/EventSink.ts
git -C .cache/orchestrator-v2/t3code log --first-parent --oneline de343914273eceb852a1d1d739cd1d38df7796ee..dd148481531a0a090780a2ade20588566db099a2 -- apps/server/src/orchestration-v2
```

On another machine, clone `https://github.com/pingdotgg/t3code.git` into an ignored research directory and check out the recorded SHA; the pinned source links also work without the cache. Historical objects in the partial clone may be fetched on demand. No upstream dependency installation is necessary to read the study.

## Verification and limits

The full Inertia `npm run check` passed under Node 22.23.2: **1,404 test files / 17,600 tests passed**, with **13 files / 149 tests skipped**, followed by build and bundle checks. The independent track also passed **5 focused files / 85 tests**. See [verification.md](verification.md) for exact scope.

T3's source and selected tests were inspected, not executed. No live provider, T3 UI, Windows/Linux runtime or packaging behavior was exercised. The public fetch could not retrieve Maria's complete long post; the supplied screenshots/accessibility text define the announcement coverage. These limits are reflected in the individual documents.

Implementation status and remaining work are tracked in [implementation-plan.md](implementation-plan.md). The verification numbers above describe the research base, not validation of subsequent code changes.
