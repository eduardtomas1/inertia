# Persistence, recovery, identity, and Duo audit (wave 2)

Workspace: the audit worktree, branch codex/full-correctness-audit. Reviewer: windows_native. Baseline d56f972b; no migration schema edited. This is a scoped independent source/Node integration audit, not a native Windows execution claim.

## Confirmed and fixed

**P1: Recovery import could write into a replaced destination and commit unrelated filesystem authority.** The durable journal captured the selected directory device/inode but asynchronous staging and publication did not use it. Replacing the selected directory after async staging creation, after staging publication, or after message insertion allowed import to succeed, create project records under the replacement path, and delete the journal. A related staging-junction swap with the selected root unchanged created externalRoot/project-00001 before final project validation rejected the escape.

Commit **1309d432**, files `src/server/persistence/database-recovery-import.ts`, `tests/server/database-export.test.ts`: retain selected-root identity in PreparedRecoveryImport; verify it before/after async writes, publication, and transaction completion; bind the canonical direct staging directory identity and verify the same inode after publication; reject replaced authority before abort cleanup. Preserve journal when the destination cannot safely be reconciled. Five regressions cover three selected-root phases, staging junction escape, and replacement of the published directory. The three root cases and staging-junction case were run failing before the corresponding fix. All five pass after. Tests restore the original directory and verify journal reconciliation still succeeds while unrelated marker/data are preserved.

## Inspection map and depth

Read completely or traced end-to-end:
- `persistence/database-recovery-import.ts`, `database-recovery-store.ts`, `database-export.ts`, `database-export-file.ts`: bounded export parsing, safe file write/publication, idempotency digest/receipts, staging batches, abort, SQL transaction and journal deletion; RuntimeStore import/open methods and server command busy/worker/reconciliation wiring.
- `persistence/database-recovery-import-worker-client.ts`, worker protocol and worker; `runtime/database-recovery-queue.ts`: one request/worker, cancellation settlement and termination barrier, late results, close timeout, durable journal recovery after worker exit.
- `persistence/database-recovery.ts`: primary quick-check, schema-history/relationship checks, future-schema refusal, quarantine and backup restore, integrity validation worker, cancellation, partial publication, scheduled/coalesced backup lifecycle and retry/retention. Validator database handle closes before receipt; worker success waits for exit. Large schema-specific validator branches read; this does not certify all released DDL definitions line-by-line.
- `database-backup-cancellation.ts`, `database-backup-sidecar-cleanup.ts`, `database-family-quarantine.ts`: regular-file checks, interrupted partials, Windows transient handle retention, backup-family sidecars and quarantine rollback.
- `runtime/runtime-sync-hub.ts`, `runtime-sequencing.ts`, `snapshot-broadcast-coalescer.ts`, `runtime-snapshots.ts`: epoch/sequence/window coalescing and subscriptions. Four-pane owner bug independently found and owned/fixed by attachments agent; no edits to their files here.
- `workspace-path-authority.ts`, `runtime/conversation-work-authority.ts`, `persistence/stored-conversation-workspace.ts`: durable directory/repository receipts, realpath and inode/birthtime verification, enrollment behavior, reservation versus filesystem authority distinction, shared and exclusive nested-checkout reservations.
- `persistence/workspace-run-repository.ts`, `recovery-repository.ts`, `duo-conversation-creation.ts`: atomic Duo conversation adoption, startup interrupted status/stream compaction, provider cleanup exclusions, activity bookkeeping.
- `runtime/duo/duo-launch-coordinator.ts`: preflight concurrency, durable dispatch claim, source reservation, ownership receipts, compensation, adopted conversation boundary, cleanup wait, cancellation, restart reconciliation, comparison dispatch/retry/recheck and checkout reservation.
- `runtime/duo/duo-{worktree-recovery,inactive-recovery,inactive-turn-settlement,active-turn-quarantine,provider-cleanup,launch-status,comparison}.ts`: receipt-scoped cleanup, ambiguity retention, provider cleanup ordering, bounded comparison input and status guidance.
- `persistence/paired-launch-repository.ts`: creation/adoption, idempotent claims, worktree ownership state machine, removal receipts, dispatch completion, cancellation, comparison and deletion locks. Read almost entirely; deletion-recovery query inspected alongside its call sites rather than every query fragment.

Targeted migration depth:
- Full catalog invariants and runner execution/transaction/error handling; targeted legacy backfill association/diagnostic code. `migrations/catalog.ts`, `runner.ts`, `runtime-catalog.ts` relevant recovery/Duo/authority entries; workspace authority and durable-data definitions. Legacy schema and provider-table rewrites rely additionally on existing upgrade and frozen-lineage fixtures. No released migration rewritten.

## Rejected suspicions / preserved boundaries

- Worker-thread `process.chdir` during import abort is unsupported, but caller waits for worker termination and then reconciles in the runtime owner; that explains why worker cancellation retains a journal until owner cleanup. No separate confirmed bug.
- Backup cancellation races validator settlement intentionally: partial files remain unpublished and shutdown does not wait indefinitely on SQLite; success waits for worker exit before rename. Windows transient cleanup retains partial names for next startup. No premature validated-backup receipt found.
- Future-version primary databases are refused, and future-version backups are excluded from pruning. Malformed schema history is not silently restored as an ordinary corrupt primary.
- Duo dispatch claims are durable and never replayed after ambiguous acceptance. Adopted worktrees are excluded from compensation. Comparison claim rechecks durable cancellation/status after waiting for source cleanup; async settlement rechecks are coalesced.
- Workspace reservation resolution may reconstruct a missing path only for in-memory exclusivity; privileged operations still require durable WorkspacePathAuthority validation. No evidence that the reservation resolver independently authorizes filesystem access.
- No additional proven defect in these reviewed paths beyond recovery import and the separately owned four-pane subscription issue. No claim that every persistence repository or every released migration body was exhaustively audited.

## Verification

Node22, macOS ARM64, real temporary directories and better-sqlite3:
- export/import-worker/recovery-queue: **51 tests passed, 3 files** (2.80s).
- recovery, backup sidecar cleanup, migration lineage/upgrades, workspace authority, Duo inactive recovery/cancellation retention/pending launches: **155 tests passed, 8 files** (12.37s).
- Changed-file oxlint passed; `tsc --noEmit -p tsconfig.test.unit.json` passed after sibling renderer edits settled; `git diff --check` passed.
- Full gate and native Electron/Windows/Linux execution reserved to parent. Existing baseline hosted CI native receipts recorded separately in local-log:inertia-audit-windows.md. New recovery tests have not yet been executed natively on Windows in this subtask.

## Independent review of sibling provider/vault changes

Read-only reviewed commits 2d6e74c0, 8cadc26f, 6057801d (Claude caller wiring and bounded reader), 97990fb4. No actionable regression found.

- Auth readiness: negative text precedes positive word matching; Claude structured true requires successful exit; aborted/timed-out probes remain unknown; outer detection still requires complete process cleanup and protocol support. Kimi/OpenCode dedicated behavior remains separate.
- Provider maintenance refusal: traced ProviderManagerInstallationAuthority.acquire -> ProviderInstallationLeaseCoordinator.acquireUse. Typed admission refusal is thrown before a use token is registered and before launch preparation/harness start. Exact conversation/run/turn receipt settles only the refused owner; unrelated errors and post-launch uncertain cleanup retain existing safety lock.
- Claude: both initial and follow-up image prompt paths receive the same preparation AbortSignal; cancel aborts it before prompt queue cancellation. Prompt reservations are released on failure; initial preparation cancellation maps to cancelled outcome through the existing catch, while cleanup still awaits the owned process. Reader pins descriptor identity, checks bounded per-file/aggregate bytes before allocation, reads in chunks, rejects changed snapshots, closes in finally. No direct provider process was started during this review.
- Credential vault: cold reads share one promise; success installs a single snapshot before queued mutation persists, failure clears the in-flight promise for retry; writes remain serialized and update memory only after persistence succeeds. Read-only concurrent callers may observe the prior committed snapshot while a write is pending, which is unchanged behavior.

Independent verification: **95 tests passed across 7 files** (4.45s): provider-auth-readiness, provider-run-admission-cleanup, claude-prompt, claude-agent-sdk-lifecycle, claude-agent-sdk-harness, credential-vault, credential-vault-load-race. These are local Node fixtures, not live-provider or native platform attestations.
