# Release review corrections (#356)

This review was reproduced against `a74fc93b`, the final-feature integration
above main `65bfbb18`. It supplements the exact public v0.0.54 to v0.0.55
review; it does not claim all 83 items in the independent issue were proven or
resolved. PR #357 incorporates the bounded corrections below.

| Finding | Confirmed behavior and correction | Regression evidence |
| --- | --- | --- |
| D1 | An unreadable but valid backup was deleted when the primary was missing/corrupt. Operational validation failures now abort before quarantine, and rejected originals remain. Strict integrity, structural and foreign-key validation remain required for restore. | `tests/server/database-recovery.test.ts`: real permission failures preserve bytes; restored permissions recover the saved conversation; injected SQLite access/I/O/lock failures preserve the primary. |
| D3 | Git can create a branch before worktree creation fails. The pending recovery record now remains until the existing double-read inspection proves no branch, target or registration remains. | `tests/server/git-worktree-cleanup.test.ts`: real unwritable parent, pre-existing branch, and branch-lock failure. |
| S3 | Persistence exceptions in provider-result or cancellation handling could skip exact cleanup after watchdogs had stopped. The tracked stop now starts even when cancellation cannot be saved. Terminal completion and ownership release still require their existing persistence and cleanup proofs. | `tests/server/turn-controller-result-persistence.test.ts` and `turn-controller-cancellation-persistence.test.ts`: deferred receipts, persistent write errors, successful retry, and missing/mismatched/force-detached quarantine. |
| P1 | Cursor had initiated termination, but MCP cleanup rejection allowed its result to return before joining it. Termination is now always joined; either cleanup failure remains explicit. | `tests/server/cursor-acp-cleanup-join.test.ts`: real ACP SDK over in-memory streams, normal completion, early cancellation and simultaneous cleanup failure. |
| M3 | Storage/listener failure could leave Private Connect starting and updates busy. Failure handling now includes gateway construction, persistence and listening; cleanup respects the attempt's port ownership. | `tests/main/private-connect/service-enable-failures.test.ts`: storage error, Node listener error, ready-state persistence failure and fresh retry. |
| S4 | Runtime shutdown waited for admitted review/compaction commands that had not received lifetime cancellation. Both now request their exact provider stop during quiescence, retaining phase ordering, deadlines and checkout authority until cleanup is confirmed. | `tests/server/runtime-shutdown-isolated-cancellation.test.ts`, `isolated-run-controller.test.ts` and `conversation-compaction-commands.test.ts`: prelaunch cancellation, deferred cleanup, unconfirmed ownership and no false success. |
| S5 | Terminal output disconnected a valid shared runtime backlog above 1 MiB. Terminal delivery now shares the existing transport policy, retaining its 64 MiB cap and 5-second stall deadline. | `tests/server/terminal-socket.test.ts`: hydration, progress, stalls, oversize, immediate/async write failure and delivery ownership. |
| X1 | Two assertions assumed English number grouping. They now verify the existing system-localized counts; prompt rejection and unenforced-budget wording remain asserted. | Both affected DOM suites: 19 passed under `ca_ES.UTF-8` and 19 under `en_US.UTF-8`; original code failed two assertions in Catalan. |

## Claims requiring different treatment

- **S1:** the existing checkpoint command explicitly confirms whole-project
  restoration. A disposable Git repository proved that later unstaged edits
  have no automatic recovery snapshot, while later untracked files survive and
  staged blobs remain in the unchanged real index. Conversation ownership,
  verified checkout paths and shared-checkout active-run exclusion are enforced.
  This behavior is unchanged from public v54; a recovery snapshot/Undo remains
  a separate safety improvement.
- **S2:** the capability-refusal example is already covered by
  `provider-run-admission-cleanup.test.ts`: an exact no-spawn receipt permits
  failure settlement and retry. Unexpected/post-start throws intentionally
  retain ownership. Clearing ownership on every synchronous throw is unsafe.
- **D2:** actual SQLite query plans confirm compaction queries can scan history
  by turn ID. No user-visible latency threshold was established by that query
  plan alone. Indexing remains a separate measured performance follow-up.
- **Windows ARM64 cold shell startup (Refs #356):** the new managed-action
  helper took 7.045s and 8.212s to emit the ComSpec-unset PowerShell fixture's
  first marker on fresh hosted runners. Both exited normally with code 7 and
  exact complete-Job cleanup. The [8.212s observation](https://github.com/eduardtomas1/inertia/actions/runs/34727886221)
  recorded only 843ms of payload CPU, but did not identify the wait's cause.
  Direct and inherited-Node controls were faster; parent image, environment
  reconstruction and Job nesting were not independently isolated. This remains
  an open performance observation, not a claimed latency fix. Only the new
  ARM64 fallback fixture permits 15s for its marker; x64 remains at 4s. Native
  admission stays at 3s, complete-Job Stop at 2s, and all exit, I/O, sibling and
  ownership assertions remain unchanged.

The database permission and worktree permission witnesses require an
unprivileged POSIX user. Their Windows cases remain covered by injected
operational errors and portable ownership assertions; they do not claim POSIX
permission semantics on Windows. Provider and Private Connect regressions use
synthetic/in-memory services and never spend a real reset credit.

The combined `a74fc93b` gate passed 8,553 tests, 1,310 portable contracts and ten
native macOS ARM64 scenarios before these later corrections. Those results are
baseline evidence, not certification of the subsequent commits. PR #357 tracks
final combined validation and the separate Windows managed-action Stop and
usage-popover geometry corrections. The Linux Limits fixture now owns a real
private D-Bus/Secret Service session and asserts encrypted storage; it does not
weaken the production refusal to store credentials with a plaintext backend.
