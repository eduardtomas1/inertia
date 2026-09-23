# Shared-checkout workflow refresh

PR #460 lets a workflow refresh load saved state when a resumed provider
terminal or another operation already owns the checkout. Native goal writes
still require exclusive provider authority and reject while that authority is
unavailable. An admitted refresh retains its reservation until settlement,
including rejection; a blocked refresh never releases another owner's work.

## Integration and the existing CI failure

The original head was `5eff8eb4f6464a9c946ed01498380acd7e250ff3`, based on
`558395da97498dd06201d7e5802b446272afd56c`. Run `35842300003` failed only Intel
macOS: `layout.spec.ts:100` measured panel right 915 against a maximum of 893.
All other native platforms and Windows unit shards passed. This is the same
geometry and complete fixture preimage already investigated for #454/#459.
The exact animation phase of that hosted failure was not captured.

Current main `178940bbd95a660d8bbf12b755ecbd97022df973` was merged without
conflicts. It includes the reviewed fixture that waits for the panel's finite
entrance animations before measuring, preserving the original containment
assertions and deadlines. The two original #460 files were unchanged by the
integration. No CI run was blindly retried and no extra layout change was
introduced here.

## Saved-state warning

Review found that a blocked native Codex refresh returned ordinary saved state
without `goalRefreshWarning`. The renderer clears the request error for that
successful response, and reservation release does not trigger another load.
That could present a stale objective, status or budget without indicating that
the requested refresh did not happen.

The response now carries a warning for a native-goal-capable route, even when
its saved goal list is empty. It preserves an existing warning, leaves local
goal routes unchanged and copies the response rather than mutating controller
state. The existing UI warning surface displays it. No background retry,
post-terminal reconciliation or new retry button is introduced. No protocol
shape, provider API, persistence, reservation or mutation authority changes.

## Validation

The command fixture now returns a complete typed workflow state. Four cases
cover native/local routes crossed with active-terminal/checkout contention,
including frozen saved state and the terminal reservation short circuit.
Additional controls preserve an existing warning, exercise real shared-checkout
authority without releasing the other conversation, and verify exact rejection
identity plus release for an admitted refresh. Existing mutation and held
refresh checks remain.

Before the warning change, the two native cases failed specifically because
`goalRefreshWarning` was null; the other 11 command tests passed. Afterward,
all 74 workflow command/controller/persistence, authority and renderer hook
checks passed. All 20 GoalPanel DOM checks also passed, including rendering a
saved-data warning while keeping local goals and skills available.

A fresh bundle build passed unchanged budgets. All six layout Electron
scenarios passed in 12.3s, and the native goal Stop/runtime-crash recovery case
passed in 12.3s, with existing worker policy, bounds and zero retries.

Final Node 22 quality checks, all 9,920 tests plus seven child controls, and the bundle build passed. The full suite used CI concurrency (`--maxWorkers=2`), retained 146 platform skips, and completed its test phase in 455.58s. Architecture, lint, types and all bundle budgets passed unchanged.

Independent review of the actual final production/test changes found no
remaining actionable finding. Current-main integration is exact and the stale
saved-data review issue is addressed. Local validation used macOS ARM64 and
Node 22.23.2; native Intel macOS, Windows and Linux still require the new
exact-head CI. Live provider accounts, release signing and publication were
not exercised or changed.

## Changed files beyond current main

- `src/server/runtime/commands/agent-workflow-commands.ts`: saved-state refresh
  fallback and an explicit native-goal warning, with unchanged mutation guards.
- `tests/server/agent-workflow-commands.test.ts`: typed saved state and authority,
  warning and failure controls.
- `docs/pr-evidence/workflow-refresh/README.md`: integration and validation evidence.
