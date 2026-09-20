# Inertia correctness audit — 20 September 2026

## Scope and baseline

This audit started from a clean worktree at freshly fetched `origin/main`,
`d56f972b32fadfa29169bb8390401f5ca49e419b`, on `codex/full-correctness-audit`.
Node 22.23.2 and `npm ci` installed the reviewed lockfile without dependency
changes. The original Desktop checkout and sibling worktrees were not modified.
No release, version change, tag, merge, dependency update, CI-speed optimization,
or broad source cleanup belongs to this work.

The inventory contains **1,208 source/assets files**: main 172, node 45,
preload 6, renderer 441, server 441, shared 103; also 1,099 test/support/fixture
files, 101 scripts, 11 GitHub configuration/workflow files, and two benchmarks.
Those are inventory counts, **not a claim that every line received equal manual
review**. Review followed complete product paths across process boundaries,
with deep reads and adversarial tests at authority, lifetime, cancellation,
and publication boundaries. Broad architecture/type/lint/test/build gates
complement the manual reviews. Passing tests do not prove absence of defects.

Historical CI/dead-code/package-size PDFs were not audit instructions or required
inputs; the coordinator explicitly made them optional background for this fresh
code audit. Sibling tasks own those changes. The icon worktree was reviewed
read-only; its additional finding was reported to the coordinator, who owns
that implementation.

## Coverage map

| Domain | Source/process surfaces and paths traced | Evidence and depth |
| --- | --- | --- |
| Native desktop, Windows and restart/update | Electron entry, runtime supervisor and recovery admission, process journals/guardian, Windows Job and ConPTY authority, terminal lifecycle, discovery and launch, installed update receipts, AppImage identity/singleton, window state and notifications | Native reviewer traced lifecycle and platform branches, inspected package/release boundary checks read-only; deterministic failure tests plus exact-baseline Windows/Linux CI evidence. Native report below distinguishes full small-module reads from targeted large-module review. |
| Attachments | Renderer imports/drafts/handoff/preview → main selection/import registry/workers → retained conversation store → runtime resolver/extraction scheduler → provider image/document adapters; PDF/image/spreadsheet/text extraction and cancellation | Attachment reviewer traced ownership, limits, detached capabilities, private generated files, worker cancellation and utility termination. Three reproduced fixes and broad focused tests. |
| Providers and turns | Discovery/auth/model metadata and six supported production routes; custom backend profiles/vault broker; approvals/input/host tools; admission, follow-up, queue, streaming, settlement, resume and restart ownership | Provider reviewer traced every production route, exact-run cleanup and turn persistence linkage. Two reproduced fixes; portable contracts and live-provider limitations documented. |
| Renderer and performance | Streaming projections/subscriptions/reconnect, transcript virtualization/scroll/focus, drafts/composer ownership, four-pane split and detached windows; workspace files/editor/search, terminal lifecycle, settings and usage | Renderer reviewer plus root review. Reproduced four-pane subscription identity/capacity defect. DOM tests and planned native geometry/performance evidence; no unsupported speedup claim. |
| Persistence and recovery | Migration catalog/runner/lineage, SQLite repositories, export/import/backup/quarantine workers, path authority, execution ledger, Duo recovery and WebSocket sequencing | Root and independent persistence reviewer. Transaction/future-schema and worker-exit boundaries checked; reproduced authorized import-root replacement race. Released migrations remain unchanged. |
| Git and workspaces | Project/conversation path identities, source-control authority bindings, bounded shell-free runner, repository discovery/scans, branch/remote/worktree operations, checkpoint/reversal and reviewed commit transactions | Root deep review of reversal/rollback/index ownership and workspace containment; native reviewer examined executable/process settlement. Reproduced newer staged-work rollback loss and added a native Git writer-lock compare/restore. |
| IPC, preload and Private Connect | Main/detached preload surfaces, trusted frame/role checks, Zod command/router coverage, scoped detached capabilities, bounded authenticated WebSockets; pairing/session/grants/Tailscale/HTTP projection and mutation delivery receipts | Root deep review of authenticated dispatch and await boundaries; five stale-read authority scenarios reproduced. Detached attachment IDs remain explicit bearer capabilities; no demonstrated cross-window ID leak. |
| Preview/browser evidence, credentials and diagnostics | Native preview session/input/approval boundary, evidence ownership, credential vault and custom backend broker, privacy filtering and diagnostic export | Independent bounded reviewer checks, plus main/preload boundary and architecture gates. No live credentials used during tests. |
| Build/release/recovery tooling | Reviewed lockfile, Electron Vite/Private Connect build, guardian compiler/integrity, migration lineage, renderer budgets, fuses, package/installer/update smoke, checksum/provenance workflows | Read-only review and relevant gates. No weakened checks or release identity changes. Native head-specific PR checks must distinguish this patch from baseline CI. |

## Root review notes

Deep or complete small-module reads: `src/server/workspace-path-authority.ts`,
`persistence/project-repository.ts`, `persistence/conversation-worktree-repository.ts`,
`persistence/statement-cache.ts`, `persistence/database-family-quarantine.ts`,
`persistence/database-recovery-import-worker-client.ts`, migration runner transaction
and lineage admission, `runtime-protocol.ts`, `runtime/websocket-boundary.ts`,
`runtime/runtime-client-authority.ts`, `runtime/detached-chat-runtime-security.ts`,
`runtime/commands/command-router.ts`, `runtime/secure-file-authorities.ts`,
`runtime/commands/source-control-authority.ts`, all server Private Connect gateway/
input/prompt admission modules, main Private Connect dispatch/authority/persistence
and HTTP/socket response paths, and `private-connect/runtime-response.ts`.

Git deep reads include `git/paths.ts`, `git/reversal.ts`, `git/reversal-files.ts`,
`git/reversal-scope.ts`, `git/reversal-registry-adapter.ts`, `git/commit-index.ts`,
and the index-lock/publication/recovery functions in `git/commit-transaction.ts`,
`git/commits.ts`, and worktree ownership/removal portions of `git/worktrees.ts`.
Workspace reads include traversal/authority boundaries and project deletion,
file read/write and terminal-resume command admission. Main secure-file claim,
transaction support, cleanup and root verification were cross-checked against
these consumers. No destructive Git command ran against user worktrees.

Renderer root reads include `TerminalPanelSession.tsx` subscription/output bounds,
resize/RAF/observer disposal and reconnect ownership, `FileEditorDialog.tsx`, file
browser state/reset paths, `useWorkspaceFiles.ts`, `selectWorkspaceFile.ts`,
`useMessageSearch.ts`, stable-controller/action and lazy-surface hooks, global
shortcuts, conversation selection queue, and usage provenance/date arithmetic.
Thirteen focused renderer tool/lifecycle suites passed 159 tests in 2.73 seconds.
These DOM measurements do not certify real xterm layout or native focus.

Rejected or bounded suspicions:

- Runtime Private Connect prompt receipts do not independently serialize identical
  delivery IDs, but the main service owns a durable receipt and an in-flight map
  before runtime dispatch. No live duplicate-delivery path was established.
- `openAttachmentExternally` does not add a conversation binding to its UUID;
  attachment preview/handoff/store intentionally use opaque bearer capabilities.
  Detached projections omit other conversations and no supported ID leak was
  demonstrated. Adding one isolated owner check would not establish a coherent
  replacement authority model.
- The streaming selector shortcut can ignore a changed selector with the same
  state, but current callers use stable module selectors. It is a latent API
  concern, not a reproduced current product defect; no speculative change made.
- Surface-loader error state does not reset for a different loader, but live
  calls use fixed module loaders and unmount through the error boundary. No live
  loader-replacement failure was established.
- Registered owned worktrees are intentionally retained for manual Git removal
  because Git cannot atomically bind removal to a prior identity inspection.
  The audit did not restore unsafe automatic deletion.
- Migration failure and foreign-key table rebuild boundaries are transactional;
  future-version databases and backups are not silently rewritten. Released
  migrations and fixture lineage remain unchanged.

## Confirmed defects and verification

Eleven distinct defects were reproduced and fixed. Each domain report records
its failing-before experiment and independent review depth. Tests use synthetic
credentials and disposable repositories/directories; no live provider accounts
or user data were used.

| Defect / user-visible failure | Fix and regression evidence |
| --- | --- |
| Generated attachment storage could follow a replaced root when writing/deleting | Pin initial directory identity and recheck around mutations and every deletion retry; four replacement regressions. `3a37fa2d`. |
| Negative or unsuccessful auth probes could show a provider connected | Negative status takes precedence; positive readiness requires successful exit. Sixteen cases failed before; 37 focused tests pass. `2d6e74c0`. |
| Private Connect async reads could return data after revocation, grant reduction or session replacement | Revalidate current session identity and original grant generation after the runtime await. Five authority-change scenarios; final service suite 36 tests pass. `a1d91fe2`. |
| Synchronous journal errors escaped runtime crash recovery and left lifecycle requests unsettled | Preserve cleanup authority, block replacement and settle through existing failed-recovery path. Three failing-before scenarios, including actual directory removal. `fb4e5e0c`. |
| Provider maintenance refusal before launch could leave a durable turn running forever | Issue an exact no-start receipt only for typed pre-launch installation refusal; unexpected errors remain fail-closed. 37 focused tests pass. `8cadc26f`. |
| Claude image preparation allocated unbounded parallel reads and ignored cancellation | Reuse pinned, bounded sequential image reads with preparation cancellation at initial and follow-up call sites. Four failing-before cases; 61 focused tests pass. `6057801d`. |
| Temporary attachment storage could rebind to a replaced session root | Pin the first root and verify import/read/release/disposal mutations against it; five failing-before cases among six new tests, 81 final focused tests pass. `fdb844ac`, helper placement `434ff843`. |
| Reversal rollback could overwrite newer staged changes | Reserve Git's native index lock; compare expected selected entry and original index identity/bytes; publish a private restored index only with unchanged marker ownership. Preserve newer staged data and foreign locks. Real Git regression and linked-worktree/split-index probes. `9ac12394`. |
| Concurrent cold credential reads could erase a newly saved credential | Share initial load promise and clear it after success/failure, retaining serialized mutations. Lost-save reproduction plus shared-failure/retry regression. `97990fb4`. |
| Recovery import could publish into a replaced destination/staging directory and commit wrong paths | Retain selected-root and staging identity through publication, SQL completion and abort; five authority-swap regressions. Preserve journal when reconciliation is unsafe. `1309d432`. |
| Third/fourth split panes lost subscriptions; reconnect could remap vacant owners | Shared bounded four-owner contract and exact optional owner/ID URL pairs; backward-compatible legacy URLs, detached scope unchanged. Five initial failing cases plus vacant-middle reconnect failure; 112 subscription/integration tests pass. `23893a8d`. |

## Verification ledger

At this draft stage, required full/local native gates are **pending the shared
local heavy-test slot**. No pass is claimed until the command completes. This
section will be replaced with final results before the PR is ready for review.

| Check | Recorded result |
| --- | --- |
| `npm ci` with Node 22.23.2 | Passed; lockfile unchanged, zero dependency vulnerabilities reported. |
| Focused Node/Happy DOM domains | See reports below for exact files/counts; overlapping batches are not summed as unique tests. |
| `npm run check:architecture` | Passed after helper extraction: 1,130 source files, 4,256 internal edges. Initial two line-ceiling failures retained as resolved evidence; no ceiling weakened. |
| `npm run test:windows-codex` on macOS | Four tests passed; four native-only tests skipped. This does not establish native Windows behavior. |
| `npm run test:linux-package` on macOS | Two files / nine tests passed; metadata/asset contracts, not actual Linux execution. |
| Streaming render isolation | 200 token events produced 200 transcript/turn renders and zero shell/layout/sidebar/header/scene/chat-workspace/composer renders. Deterministic DOM evidence, not native frame timing. |
| `npm run check` | Pending. |
| `npm run test:portable` | Pending; includes new provider cases. |
| Local Electron E2E / packaged smoke / fuses | Pending. |
| Native desktop benchmark | Pending; report absolute measurements without an unmeasured baseline speedup claim. |
| Exact-head Windows/Linux CI | Pending PR checks. Baseline CI passed on all six native platform/architecture jobs, and is explicitly not this patch's certification. |

One early direct-Vitest provider sweep produced four Antigravity failures because
the generated runtime guardian had not been built. Direct Vitest bypasses npm's
pretest prerequisite. This result is retained in the provider report; the normal
full gate must build the guardian and pass these cases, without relaxing timeouts.

## Detailed evidence and independent review

- [Source and tooling inventory](2026-09-20-source-inventory.tsv): baseline file-to-domain map; inventory is broader than manual deep-read coverage.
- [Native desktop, Windows, terminals and update review](2026-09-20-correctness/windows.md).
- [Attachments and document/provider handoff review](2026-09-20-correctness/attachments.md).
- [Provider, turn, browser evidence, credentials and diagnostics review](2026-09-20-correctness/providers.md).
- [Persistence, migrations, recovery, workspace identity and Duo review](2026-09-20-correctness/persistence.md), including independent provider/vault/Claude review.
- [Renderer, reconnect, draft/focus and performance review](2026-09-20-correctness/renderer.md).
- [Independent aggregate change review](2026-09-20-correctness/independent-review.md). The reviewer excludes their own changes; a different reviewer checked those. The Git reviewer found an additional lock-marker gap, fixed and regression-tested before commit.

## Remaining limits

Native Windows and Linux execution for the final patch depends on hosted CI;
local macOS simulations and historical baseline checks are labeled separately.
No live provider credentials/accounts, OS credential-service roundtrip, provider
canary drift, unusual antivirus/corporate policy, RDP/fast-user-switching, power
failure, or exhaustive high-DPI/multi-monitor behavior was exercised by these
source/fixture reviews. Upstream Kimi may report a partial-output error as a
normal end-turn event; the protocol cannot reliably distinguish that case.

Filesystem identity checks bracket asynchronous work and fail closed on tested
replacements, but Node pathname APIs do not make every final validation/syscall
pair atomic against hostile component replacement. Temporary/generated directory
identity does not include birthtime; inode reuse was not reproduced. The Git
rollback uses a real writer lock and byte/identity checks; native Windows rename
semantics still require branch-specific hosted validation. Large native helper,
migration, provider projection and preview hook modules received targeted review
plus fixture coverage, not a claim of formal or exhaustive line-by-line proof.

