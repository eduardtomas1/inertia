# ORCHESTRATOR V2 research brief

## Authorized outcome

Study current Inertia orchestration and T3 Code's orchestration replacement, including the original PR and later evolution. Store evidence-backed findings locally in Inertia, compare the two designs, and prepare the `orchestrator-v2` branch and an **ORCHESTRATOR V2** research PR. Discuss implementation afterward. This phase does not authorize production refactoring, schema changes or merging the PR.

The branch name is exactly `orchestrator-v2`, following the user's correction. The audit base is Inertia `9340d9f2b66a880890337d1b1563d5944ce7025d` from `origin/main`, rather than the nine-commit-older local `main` initially present.

## Two research tracks

The coordinating chat owns T3 research, source pinning, comparison, verification, Git and the PR. Its persistent goal requires completing the research and reviewable deliverables, not merely producing a plan.

The user-requested second local chat is **ORCHESTRATOR V2 — Inertia study**, in this Inertia project. It was created with `gpt-6-astra` and `xhigh`. Its session confirmed full filesystem access, network enabled and approval policy `never`. The chat-creation API did not expose a separate permission override; effective access was confirmed inside that chat rather than assumed from the model selection. Its local chat identifier is provided in the coordinating handoff rather than published in this dossier.

Its research assignment, summarized, is:

> Create a persistent goal to finish an independent, source-grounded audit of Inertia orchestration. Read repository instructions; trace execution ownership, lifecycle, queueing/steering, provider adapters and capabilities, native and managed children, context/fork/restart behavior, persistence, IPC/UI projections, permissions, workspace identity and tests. Write and review `inertia-current-state.md` and `inertia-source-map.md`. Distinguish implemented behavior, tested behavior, gaps and uncertainty. Do not modify production code or perform coordinator-owned Git/dependency/full-gate operations. Do not stop after a plan or partial inventory.

The actual initial assignment and follow-up are visible in the created chat. `inertia-research-progress.md` records its confirmed goal and working boundaries. No additional research agents were requested or started.

## Completion standard

- Both software studies exist locally, with pinned revisions and concrete source/test references.
- All visible announcement categories are accounted for; inaccessible text and unexecuted behavior are labeled.
- Current implementation is distinguished from old design notes, the original merge and release availability.
- The comparison identifies existing Inertia strengths, gaps, invariants to retain, migration choices and meaningful acceptance scenarios.
- Repository verification is recorded accurately; source review is not presented as live-provider testing.
- Changes remain documentation-only; the branch is pushed and a draft research PR is available for discussion.

No token or time budget was imposed. Both research goals were intended to persist until these deliverables were complete.
