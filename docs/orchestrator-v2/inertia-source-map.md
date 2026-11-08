# Inertia orchestration source map

Baseline: `9340d9f2b66a880890337d1b1563d5944ce7025d`, audited 2026-10-29. Companion: [current-state analysis](inertia-current-state.md).

Paths are repository-relative; links point to the inspected source and use one-based line anchors. Line numbers describe the baseline, not future edits. A reference identifies the entry point for an assertion, not a claim that every line in its file was audited. Evidence IDs are used by the current-state document.

**Evidence levels:** implementation rows below were inspected in source; test rows explicitly distinguish assertion review, test-name inventory, and execution. A test name alone does not prove coverage of every adjacent claim. “Not found” conclusions are scoped to the searches and entry points listed near the end.

## A. Process, composition and trust

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| A1 | [src/server/index.ts:148](../../src/server/index.ts#L148), `startRuntime`; post-ready tasks :181; turn composition :652; settlement owners :694; command admission :865; listen :945 | Actual runtime composition root. Persistence/recovery before readiness; deferred discovery; independent workflow owners; loopback listener. |
| A2 | [src/main/index.ts:347](../../src/main/index.ts#L347), `isTrustedRendererLocation`; :365 `assertTrustedIpc`; window flags :774; utility fork :1101 | Main-process trusted-origin checks, isolated sandboxed renderer, supervised runtime utility process and sanitized environment. |
| A3 | [src/preload/index.ts:202](../../src/preload/index.ts#L202), `getRuntimeConnection` bridge | Explicit renderer-to-main runtime connection API, not direct renderer provider/process control. |
| A4 | [src/main/runtime-supervisor.ts:58](../../src/main/runtime-supervisor.ts#L58), `RuntimeSupervisor`; startup :217; recovery :240; manual recovery :273; shutdown :478 | Runtime lifecycle and bounded shutdown/restart; unconfirmed cleanup can block replacement. Explicit modern Darwin recovery is identity-bound. |
| A5 | [src/server/runtime-startup-recovery.ts:45](../../src/server/runtime-startup-recovery.ts#L45), `initializeRuntimePersistence`; :185 `prepareRuntimeStartupRecovery` | Ownership is cleared only through enumerated cleanup/boot/recovery evidence. Interrupted turns, Duo, watcher wakes and maintenance are reconciled before receipts are consumed. |
| A6 | [src/server/persistence/provider-run-ownership-repository.ts:49](../../src/server/persistence/provider-run-ownership-repository.ts#L49), `record`; :87 `clear` | Durable conversation/run/turn/runtime-generation/boot ownership; exact match on clearing. |
| A7 | [src/node/runtime-owned-process-invocation.ts:53](../../src/node/runtime-owned-process-invocation.ts#L53), POSIX invocation wrapper | Native guardian wrapping without a shell; separate user-interactive PTY boundary. Platform implementations are in `runtime-owned-process-{darwin,linux,posix}.ts`. |
| A8 | [src/main/runtime-supervisor-stop-recovery.ts:95](../../src/main/runtime-supervisor-stop-recovery.ts#L95), `reconcileStoppedRuntimeQuarantine` | Supervisor cleanup and process-tree proof are distinct; reconciliation persists cleanup evidence before forgetting quarantine. |
| A9 | [src/server/git/runner.ts:295](../../src/server/git/runner.ts#L295), bounded Git process execution; spawn :330 | Shell-free Git, sanitized environment, deadlines, output bounds and runtime-owned process integration. |
| A10 | [src/server/runtime/websocket-boundary.ts:29](../../src/server/runtime/websocket-boundary.ts#L29), limits; origin :85; admission :133 | 16-client and 32-in-flight defaults, payload bounds, origin/capability validation, detached authority, concurrent dispatch. |

## B. Persistence and migration

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| B1 | [src/server/database.ts:130](../../src/server/database.ts#L130), `RuntimeStore` repository fields; :150 `conversationWork` | Repository facade with separate worktree/context/turn/workflow domains and in-memory work authority. |
| B2 | [src/server/persistence/turn-ledger-repository.ts:95](../../src/server/persistence/turn-ledger-repository.ts#L95), turn creation; :262 `begin` | Canonical route/harness/ownership validation; transaction joins message, turn, execution context, context consumption and relevant queue/continuation facts. |
| B3 | [src/server/persistence/turn-ledger-repository.ts:998](../../src/server/persistence/turn-ledger-repository.ts#L998), terminal update; :1013 execution-context persistence | Immutable terminal update behavior and content-addressed context blobs/manifests with collision validation. |
| B4 | [src/server/persistence/turn-settlement-projection.ts:19](../../src/server/persistence/turn-settlement-projection.ts#L19), `settleProjectedAgentTurn` | Transactional durable turn and conversation/workspace projection settlement. |
| B5 | [src/server/persistence/migrations/catalog.ts:3](../../src/server/persistence/migrations/catalog.ts#L3), schema constants and catalog; [recent-migrations.ts:34](../../src/server/persistence/migrations/recent-migrations.ts#L34) | Legacy count 17, current schema 106, append-position numbering and recent ordered definitions. [runtime-catalog.ts:41](../../src/server/persistence/migrations/runtime-catalog.ts#L41) begins explicit turn ownership. |
| B6 | [src/server/persistence/migrations/runner.ts:278](../../src/server/persistence/migrations/runner.ts#L278), `runDatabaseMigrations` | Catalog validation, unknown-version rejection, pending upgrades in a transaction, migration ledger inserts, final FK check and enforcement restoration. Legacy backfill diagnostics distinguish inferred history. |

## C. Commands and renderer synchronization

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| C1 | [src/server/runtime/commands/command-router.ts:37](../../src/server/runtime/commands/command-router.ts#L37), `RUNTIME_COMMAND_TYPES`; handler index :57; executor :96 | Command set derives from schema; ownership must be total and unique. Mutating handlers publish authoritative changes before normal success acknowledgment where the router owns publication. |
| C2 | [src/server/index.ts:865](../../src/server/index.ts#L865), command execution closure | Admission checks closed/update/recovery/import/detached state and tracks active operations before handler dispatch. |
| C3 | [src/server/runtime-sequencing.ts:154](../../src/server/runtime-sequencing.ts#L154), `RuntimeSequencer`; bounds :16; replay :204; retention :228 | In-memory 2,048-event / 4-MiB replay, generation-local sequence, refresh on mismatch/eviction, snapshots as hydration boundaries. Explicitly not event sourcing. |
| C4 | [src/server/runtime-sequencing.ts:128](../../src/server/runtime-sequencing.ts#L128), `projectRuntimeFrame` | Cursor-only unsubscribed detail maintains contiguous sequence; interaction inbox remains live. |
| C5 | [src/server/runtime/runtime-sync-hub.ts:117](../../src/server/runtime/runtime-sync-hub.ts#L117), connect/hydration path; subscribe :233 | Socket ownership precedes hydration; replay or fresh welcome/details, pending interactions, then completed cursor. Mounted pane subscription ownership is explicit. |

## D. Turn admission, state, steering and cleanup

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| D1 | [src/server/runtime/turns/turn-controller.ts:110](../../src/server/runtime/turns/turn-controller.ts#L110), `TurnController`; queue :554; start :744; provider launch :818 | Single active application turn per conversation, exact maps, update/goal/watcher/Duo gates, host bridge and durable ownership before provider launch. |
| D2 | [src/server/runtime/turns/turn-request-preparation.ts:84](../../src/server/runtime/turns/turn-request-preparation.ts#L84), `prepareTurnRequest`; route resolution :188 | New run/turn identities, route/model/image/performance checks, prepared execution context, durable begin before live adoption. |
| D3 | [src/server/runtime/turns/turn-live-adoption.ts:31](../../src/server/runtime/turns/turn-live-adoption.ts#L31), live adoption; failure repair :93 | Durable queued work is repaired if stream/map adoption fails; no assumption that failed in-memory setup means no database effect. |
| D4 | [src/server/runtime/run-state-engine.ts:37](../../src/server/runtime/run-state-engine.ts#L37), `AuthoritativeRunStateEngine`; event gate :72; terminal :158; acknowledgment :202 | Monotonic exact-owner state machine, interaction/descendant precedence, first terminal request, durable commit acknowledgment and no reopening. |
| D5 | [src/server/runtime/turns/turn-follow-up-coordinator.ts:48](../../src/server/runtime/turns/turn-follow-up-coordinator.ts#L48), lease and steer; [src/shared/follow-up-steer.ts](../../src/shared/follow-up-steer.ts) | Exact active tuple, serial admitted steering, unknown-delivery classification, persistence of accepted input at turn end. Shared steer allowlist is Codex/Claude/OpenCode. |
| D6 | [src/server/runtime/turns/turn-settlement-coordinator.ts:58](../../src/server/runtime/turns/turn-settlement-coordinator.ts#L58), `settle`; :166 guarded finalize; :219 commit | Flush streams, finalize traces, persist terminal data, retry/check durable outcome and retain authority if persistence fails repeatedly. |
| D7 | [src/server/runtime/turns/turn-run-state-coordinator.ts:141](../../src/server/runtime/turns/turn-run-state-coordinator.ts#L141), settlement request; :301 `stopOwnedProviderAndRelease` | Exact stop joins settlement. Only settled cleanup clears durable ownership; failure/expiry retains unconfirmed state while bounded visible settlement can continue. |
| D8 | [src/server/provider/run-coordinator.ts:198](../../src/server/provider/run-coordinator.ts#L198), `ProviderRunCoordinator`; :238 run; :996 `stopOwned`; :1025 stop ladder | Provider owner, cleanup-receipt/refusal ledgers, exact stop and bounded escalation. A provider result is not itself the complete stop proof. |
| D9 | [src/server/runtime/turns/turn-settled-orchestration.ts:6](../../src/server/runtime/turns/turn-settled-orchestration.ts#L6), `dispatchSettledTurnOwners` | Independent owner callbacks use all-settled; deliberately no blanket retry against potentially newer conversation state. |
| D10 | [src/server/runtime/commands/turn-interaction-commands.ts:171](../../src/server/runtime/commands/turn-interaction-commands.ts#L171), `message.send`; delivery classifier :53; transition reservation :690; release :896 | Accepted/ambiguous delivery stages, active follow-up path, special context replay, preparation rechecks and temporary provider transition reservation. |

## Q. Durable queued input

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| Q1 | [src/server/runtime/queued-message-runtime.ts:35](../../src/server/runtime/queued-message-runtime.ts#L35), `createQueuedMessageRuntime`; dispatch :73; enqueue :151; undelivered :216; stop-and-send :270 | Route-bound queue claims, cleanup waits, replay identity/digest, attachment handling, ambiguous held input, exact-turn stop-and-send. Release predicate is :19. |

## H. Continuation, context and provenance

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| H1 | [src/shared/continuation-policy.ts:64](../../src/shared/continuation-policy.ts#L64), continuation actions; identity changes :124; provider switch :257 | Native resume versus fresh session, route-specific compatibility, model/installation exceptions, no universal fork/rollback action. |
| H2 | [src/server/runtime/turns/turn-fresh-session-fallback.ts:49](../../src/server/runtime/turns/turn-fresh-session-fallback.ts#L49), `applyFreshSessionFallback` | No output/reasoning/interaction/activity/terminal/imported-session fallback; durable restart updates prepared context and removes stale session identity. |
| H3 | [src/server/provider/fresh-session-fallback.ts:17](../../src/server/provider/fresh-session-fallback.ts#L17), `startHarnessWithFreshSessionFallback` | Session-unavailable and cleanup-confirmed prerequisites, excluded operations/goals, cancellation and one replacement start. |
| H4 | [src/server/persistence/continuation-history.ts:105](../../src/server/persistence/continuation-history.ts#L105), history assembly; [provider-handoff-files.ts:9](../../src/server/persistence/provider-handoff-files.ts#L9) | Route-filtered visible history, sent references, attribution/omission, supplemental bounded file evidence. File supplement limits: 200 files, 8 KiB, 100 artifacts. |
| H5 | [src/server/runtime/turns/request-context.ts:32](../../src/server/runtime/turns/request-context.ts#L32), bounds; :645 `assembleTurnRequest`; restoration :811; manifest :880 | 32 refs, 48 segments, 240-KiB assembly, 64-KiB blobs/visible text, 16/32-KiB instruction bounds, staged materialization and manifest. |
| H6 | [src/shared/conversation-context.ts:1](../../src/shared/conversation-context.ts#L1), packet limits; [conversation-context-service.ts:72](../../src/server/runtime/conversation-context-service.ts#L72), `ConversationContextService`; authorized creation :38 | User/agent-authorized packet creation, materialization, sendability and replay acceptance. Separate source/excerpt/serialized limits. |
| H7 | [src/server/runtime/agent-context-tool.ts:42](../../src/server/runtime/agent-context-tool.ts#L42), tool name/schema; access :138; watched reads :178; read :221 | Own/reference/chooser access, route withholding, audited reads, image support and watcher read budget. |
| H8 | [src/server/runtime/agent-context-pages.ts:20](../../src/server/runtime/agent-context-pages.ts#L20), page/list/message limits; list :96 | 30-KiB pages, 1-MiB message bound, 20 default / 50 maximum turns, paginated untrusted evidence and withheld-route count. |
| H9 | [src/server/runtime/conversation-context-request-coordinator.ts:77](../../src/server/runtime/conversation-context-request-coordinator.ts#L77), `ConversationContextRequestCoordinator` | Separate request/chooser lifecycle; do not turn a chat-list response into transcript authorization. |
| H10 | [src/server/runtime/commands/conversation-compaction-commands.ts:188](../../src/server/runtime/commands/conversation-compaction-commands.ts#L188), preparation; :309 compact under lock; :465 return eligibility | Compatible native session, exact correlation IDs without a durable AgentTurn, configuration recheck, cleanup join, instruction cache invalidation and retained lock on uncertainty. |

## P. Provider contracts and routing

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| P1 | [src/server/provider/agent-harness-registry.ts:33](../../src/server/provider/agent-harness-registry.ts#L33), registry validation; resolve :51; production :137 | Unique harness/provider registrations, supported protocol/profile checks, six production harnesses and custom-backend probe gates. |
| P2 | [src/server/provider/capability-manifest.ts:263](../../src/server/provider/capability-manifest.ts#L263), production definitions; attestation :781; capability lookup :950 | Declared native/negotiated/host/unavailable support with implementation/protocol versions; declaration differs from installed/attested readiness. |
| P3 | [src/server/provider/runtime-capability-attestation.ts:45](../../src/server/provider/runtime-capability-attestation.ts#L45), baseline/probe mapping; identity :107; public state :177 | Custom verified capabilities, exclusions from baseline, trusted installation/manifest/configuration evidence. |
| P4 | [src/shared/model-routing.ts:5](../../src/shared/model-routing.ts#L5), historical/current harness IDs; protocol :26; model capability :46; profile :93 | Provider/harness/backend/model/account-related identities are distinct; safe profile snapshots use opaque endpoint identity and revision. |
| P5 | [src/server/provider/contracts.ts:84](../../src/server/provider/contracts.ts#L84), `ProviderRunRequest`; goal :115; USD limit :127; event identity :217 | Canonical run request and exact event tuple; native-goal and route-restricted Claude spend control are not universal budgets. |
| P6 | [src/server/provider/codex-app-server-harness.ts:102](../../src/server/provider/codex-app-server-harness.ts#L102), factory; [claude-agent-sdk-harness.ts:170](../../src/server/provider/claude-agent-sdk-harness.ts#L170), factory | Codex RPC/thread lifecycle and Claude SDK message/task lifecycle. Their native semantics are deliberately adapter-owned. |
| P7 | [src/server/provider/cursor-acp-harness.ts:169](../../src/server/provider/cursor-acp-harness.ts#L169), factory; resume :566; [kimi-acp-harness.ts:170](../../src/server/provider/kimi-acp-harness.ts#L170), factory; resume :472 | Shell-free ACP process paths, capability negotiation and exact native session handling. |
| P8 | [src/server/provider/opencode-sdk-harness.ts:181](../../src/server/provider/opencode-sdk-harness.ts#L181), factory; resume :523; [antigravity-cli-harness.ts:87](../../src/server/provider/antigravity-cli-harness.ts#L87), factory; spawn :309 | Owned OpenCode server/session versus native Antigravity stream-JSON process. No blanket assumption of shared features. |

## V. Backend profiles and credentials

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| V1 | [src/server/runtime/backends/backend-profile-runtime.ts:69](../../src/server/runtime/backends/backend-profile-runtime.ts#L69), `backendKeyVerified`; runtime :90; resolvers :128 | Verification bound to credential generation; backend route resolvers receive a privileged secret broker and controlled network policy. |
| V2 | [src/main/credential-vault.ts:135](../../src/main/credential-vault.ts#L135), `ElectronSafeStorageBackend`; persistence :187 | OS encryption, Linux plaintext/unknown backend refusal, no-follow file validation and bounded persistence. |
| V3 | [src/main/credential-vault.ts:638](../../src/main/credential-vault.ts#L638), `CredentialVault`; public state :657; resolve :699; clear :774 | Masked presence and generation to callers; privileged secret resolution; serial mutation; encrypted values and clear tombstones. |
| V4 | [src/server/provider/auth.ts:15](../../src/server/provider/auth.ts#L15), command map; [auth-launch.ts:15](../../src/server/provider/auth-launch.ts#L15), user-requested sign-in preparation | Provider-specific account/status commands; Antigravity has no bounded status command. Installation lease spans native auth negotiation and terminal handoff. |
| V5 | [src/server/runtime/backends/backend-profile-controller.ts:107](../../src/server/runtime/backends/backend-profile-controller.ts#L107), probe admission; :575 latest-probe check; :621 sequence check; :1006 installation check | Probe evidence is ordered per profile/revision/model and bound to current installation/configuration/credential authority. |

## M. Managed chats

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| M1 | [src/server/runtime/agent-thread-manager.ts:130](../../src/server/runtime/agent-thread-manager.ts#L130), tool definitions; manager constants :68 | Visible top-level chat tool set; list, inspect, context request, create/send/status/latest/stop/archive; active child cap three. |
| M2 | [src/server/runtime/agent-thread-manager.ts:589](../../src/server/runtime/agent-thread-manager.ts#L589), `mutate`; approval :636; queue :676; preflight :718 | Durable intent before approval, explicit approval in every access mode, serial/revalidated mutation, child depth/access/concurrency constraints. |
| M3 | [src/server/runtime/agent-thread-manager.ts:839](../../src/server/runtime/agent-thread-manager.ts#L839), selection; create :883; send :992 | Route/model/effort inheritance, centralized creation, same-project workspace policy, durable lineage and exact target dispatch, accepted steering only. |
| M4 | [src/server/persistence/agent-thread-management-repository.ts:5](../../src/server/persistence/agent-thread-management-repository.ts#L5), bounds; lineage :26; recovery :127; dispatched runs :181; reserve :207 | Depth 2; creates 4, mutations 8, input characters 65,536 per source turn; exact source/target records, replay/conflict fingerprint and interrupted-operation recovery. |
| M5 | [src/server/runtime/agent-thread-manager.ts:378](../../src/server/runtime/agent-thread-manager.ts#L378), `onSourceTurnSettled`; ownership :499; latest :546; stop :1073 | Successful parent leaves children; non-success cancels only exact dispatched runs. Direct ownership checks and no stale latest-result success while newer work runs. |
| M6 | [src/server/persistence/migrations/agent-thread-target-ownership.ts](../../src/server/persistence/migrations/agent-thread-target-ownership.ts) | Explicit target turn/run ownership migration; historical operations cannot infer rights over a later target run. |

## N. Native subagents

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| N1 | [src/server/codex/app-server-subagent-continuation.ts:6](../../src/server/codex/app-server-subagent-continuation.ts#L6), continuation gate | Root terminal candidate deferred while exact live delegates remain; bounded parent-continuation grace. |
| N2 | [src/server/provider/claude-delegate-lifecycle.ts:25](../../src/server/provider/claude-delegate-lifecycle.ts#L25), lifecycle; notification :72; live tasks :118; final completion :149 | Background notifications are not parent answers; level-triggered live tasks, prompt ownership and missing-parent/delegate failure distinctions. |
| N3 | [src/server/runtime/turns/turn-subagent-stop.ts:18](../../src/server/runtime/turns/turn-subagent-stop.ts#L18), stop command; [claude-subagent-trace.ts:512](../../src/server/provider/claude-subagent-trace.ts#L512), trace emit | Shared individual-stop path requires Claude/exact live task ID; telemetry retains provenance and does not invent fork model identity. |

## X. Host capability packs and MCP

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| X1 | [src/server/runtime/harness-capabilities.ts:58](../../src/server/runtime/harness-capabilities.ts#L58), pack contract; registry :227; [inertia-harness-capabilities.ts:42](../../src/server/runtime/inertia-harness-capabilities.ts#L42), production pack construction | Reviewed compiled tools, validation/digest, orchestration/frontend/visual-reply packs; no repository code loading. |
| X2 | [src/server/provider/host-tool-runtime.ts:23](../../src/server/provider/host-tool-runtime.ts#L23), limits; invoke :134; settlement :243; approval :263 | 128 calls/eight pending/five-minute approval; exact provider owner, duplicate-call refusal, abort and revocation. |
| X3 | [src/server/provider/host-tool-mcp-http.ts:168](../../src/server/provider/host-tool-mcp-http.ts#L168), `createProviderHostToolMcpSession`; body limits :19; authentication :96 | Per-run loopback bearer MCP; Host/Origin validation, timing-safe token check, bounded body/deadline/concurrency and run-owned close. |
| X4 | [docs/HARNESS_CAPABILITIES.md](../HARNESS_CAPABILITIES.md) | Supporting design narrative for instruction delivery and new-thread Codex tool registration. Implementation and registration tests remain the authority; this document is not live provider evidence. |

## S. Workflows and schedulers

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| S1 | [src/server/runtime/agent-workflow-controller.ts:141](../../src/server/runtime/agent-workflow-controller.ts#L141), controller; native/local state :194; local goal :369; native control :404 | Native Codex goals versus local objective metadata; supported skill routing and admission are separate. |
| S2 | [src/server/runtime/restart-continuation-scheduler.ts:26](../../src/server/runtime/restart-continuation-scheduler.ts#L26), scheduler; plan eligibility :79; readiness :93; dispatch :124; [restart-continuation-runtime.ts:17](../../src/server/runtime/restart-continuation-runtime.ts#L17) | Planned-update continuation, exact latest-turn/route guards, no conflicting work, five-second polling and max three attempts. |
| S3 | [src/server/usage/limit-reset-scheduler.ts:48](../../src/server/usage/limit-reset-scheduler.ts#L48), scheduler; offer :86; schedule :178; tick :274; attempt :335 | Saved failed-turn/route/account plan, fresh quota checks, busy/backoff/missed handling and guarded dispatch. |
| S4 | [src/server/runtime/watcher/watcher-wake-runner.ts:187](../../src/server/runtime/watcher/watcher-wake-runner.ts#L187), `run`; [watcher-wake-scheduler.ts:147](../../src/server/runtime/watcher/watcher-wake-scheduler.ts#L147), `observe` | Meaningful-event/quiet-window scheduling, durable link claim, digest/wake/turn attribution, budget/final pass and retry ownership. |
| S5 | [src/server/runtime/watcher/watcher-turn-policy.ts:35](../../src/server/runtime/watcher/watcher-turn-policy.ts#L35), policy; [watcher-checkout-guard.ts:185](../../src/server/runtime/watcher/watcher-checkout-guard.ts#L185), checkout checks; [src/shared/watcher.ts:366](../../src/shared/watcher.ts#L366) | Narrow context-only bridge, per-turn read budget, read-only versus editable policy and inconclusive checkout observations. |
| S6 | [src/server/runtime/duo/duo-launch-coordinator.ts:120](../../src/server/runtime/duo/duo-launch-coordinator.ts#L120), coordinator; dispatch :185; settle :395; [duo-comparison.ts:64](../../src/server/runtime/duo/duo-comparison.ts#L64), evidence limits | Paired preparation/claim/start, optional comparison, exact source evidence and worktree compensation/recovery; not a general DAG. |

## W. Workspace mutation and reversal

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| W1 | [src/server/runtime/conversation-creation-service.ts:105](../../src/server/runtime/conversation-creation-service.ts#L105), create | Shared UI/host creation service; scratch isolation, same-project attached-worktree reuse, source pinning and durable creation receipt. |
| W2 | [src/server/runtime/conversation-work-authority.ts:21](../../src/server/runtime/conversation-work-authority.ts#L21), canonical identity; reserve :216; [worktree-source-identity.ts:12](../../src/server/runtime/worktree-source-identity.ts#L12) | Canonical checkout reservations and pinned filesystem/Git source identity. Exclusive operations cover nested overlap; ordinary sends release their transition reservation. |
| W3 | [src/server/git/worktrees.ts:719](../../src/server/git/worktrees.ts#L719), creation receipt; inspect :937; owned removal :1143 | Expected branch/head, metadata/token and filesystem checks; residual non-atomic Git removal race acknowledged at :1186. |
| W4 | [src/server/runtime/checkpoint-restoration.ts:11](../../src/server/runtime/checkpoint-restoration.ts#L11), guarded restoration; [src/server/checkpoints.ts:30](../../src/server/checkpoints.ts#L30) | Recovery checkpoint persisted before restore; caller-held checkout reservation; isolated Git metadata/config and bounded capture. |
| W5 | [src/server/git/reversal.ts:119](../../src/server/git/reversal.ts#L119), capture; apply validation :595; undo :755 | Complete bounded diff fingerprints, selected/staged/worktree validation, repeat checks, registry backups, and refusal when post-state changed. |
| W6 | [src/server/reversal-registry.ts:80](../../src/server/reversal-registry.ts#L80), registry controller; [src/server/turn-git-artifacts.ts:135](../../src/server/turn-git-artifacts.ts#L135), artifact controller | Persistent recovery/CAS interface and turn-attributed before/after Git evidence. These are filesystem evidence, not provider session rewind. |

## I. CLI import

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| I1 | [src/server/runtime/commands/cli-conversation-commands.ts:10](../../src/server/runtime/commands/cli-conversation-commands.ts#L10), handlers | Scan/preview/import ownership, scratch refusal, workspace guard, preview revision and native route checks. |
| I2 | [src/server/cli-import/discovery.ts:36](../../src/server/cli-import/discovery.ts#L36), roots; :53 `openTranscript`; :87 streaming; :256 read | Codex/Claude source families, archived context-only sources, expiring scoped candidate grants, containment and handle identity checks, bounded stream/revision validation. |
| I3 | [src/server/persistence/cli-conversation-import.ts:25](../../src/server/persistence/cli-conversation-import.ts#L25), dedup; :62 turn reconstruction; :105 import transaction; [resume-cwd.ts:8](../../src/server/cli-import/resume-cwd.ts#L8) | Provider/session and historical-turn deduplication, imported origin and receipt, eligible native continuation and imported-tool disclosure. |

## U. Desktop UI and performance seams

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| U1 | [src/renderer/src/hooks/useInertiaConnection.ts:58](../../src/renderer/src/hooks/useInertiaConnection.ts#L58), hook; replay :142; frames :219; late result :284; send :385 | Exact connection cursor, synchronization readiness, pending request lifetime and ambiguity without automatic mutation replay. |
| U2 | [src/renderer/src/utils/runtimeSequencing.ts:52](../../src/renderer/src/utils/runtimeSequencing.ts#L52), `RuntimeProjectionSequence` | Duplicate suppression, gap/generation rejection and exact completed cursor. |
| U3 | [src/renderer/src/utils/runtimeCommandPolicy.ts:79](../../src/renderer/src/utils/runtimeCommandPolicy.ts#L79), total policy map | Every command chooses deadline/delivery semantics; read timeout and mutation uncertainty are not conflated. |
| U4 | [src/renderer/src/hooks/useStreamingAgentState.ts:33](../../src/renderer/src/hooks/useStreamingAgentState.ts#L33), streaming store; selector :59 | Separately subscribable streaming state and equality-based selected updates. |
| U5 | [src/renderer/src/utils/response-timeline/virtualization.ts:27](../../src/renderer/src/utils/response-timeline/virtualization.ts#L27), thresholds; :132 selection; :767 keyboard; [useViewportSyncedVirtualizer.ts:23](../../src/renderer/src/components/response-timeline/useViewportSyncedVirtualizer.ts#L23) | Weighted virtualization, estimates, keyboard/scroll anchors and viewport synchronization. No benchmark result is inferred. |

## R. Private Connect

| ID | Source and symbol | What it establishes |
| --- | --- | --- |
| R1 | [src/shared/private-connect/scopes.ts:3](../../src/shared/private-connect/scopes.ts#L3), scopes/presets | Monitor read versus collaborate read/prompt/input/stop; not arbitrary desktop command access. |
| R2 | [src/main/private-connect/service.ts:266](../../src/main/private-connect/service.ts#L266), invitation; pairing :280; approval :358; [gateway-server.ts:252](../../src/main/private-connect/gateway-server.ts#L252), request routing | Separate gateway/session/pairing and scoped grants with bounded transport; not reuse of desktop renderer token. |
| R3 | [src/server/private-connect/prompt-admission.ts:28](../../src/server/private-connect/prompt-admission.ts#L28), `queuePrivateConnectPrompt` | Valid device origin, update/terminal/compaction/busy checks, ordinary queue/start and failure repair. |

## T. Tests and what was actually examined

The first three rows were executed in this research track. “Assertion reviewed” means relevant bodies and expectations were read, not that their whole suite was executed. Other rows identify precise existing coverage to reuse and are clearly marked as inventory where only case names or entry points were inspected.

| ID | Test evidence | Review / execution status and scope |
| --- | --- | --- |
| T1 | [tests/server/authoritative-run-state.test.ts:43](../../tests/server/authoritative-run-state.test.ts#L43); [authoritative-run-state-interleavings.test.ts:63](../../tests/server/authoritative-run-state-interleavings.test.ts#L63), generated sequences :149 | **Executed, passed; assertions reviewed.** Interactions, descendants, cancellation, first terminal outcome, monotonic revisions, no reopen; 12,005 sequences over seven actions of length four and five provider labels. Does not enumerate real transport schedules or Antigravity. |
| T2 | [tests/continuation-policy.test.ts](../../tests/continuation-policy.test.ts) | **Executed, passed; policy source reviewed.** Compatibility decision regression suite; not proof of live provider resume. |
| T3 | [tests/server/provider-capability-manifest.test.ts](../../tests/server/provider-capability-manifest.test.ts); [harness-capabilities.test.ts](../../tests/server/harness-capabilities.test.ts) | **Executed, passed; implementation/test contracts inspected.** Capability/registry consistency and host pack constraints. Five executed files collectively: **85 tests**. |
| T4 | [tests/server/agent-thread-manager.test.ts:243](../../tests/server/agent-thread-manager.test.ts#L243), delayed stop; :272 parent failure; :836 denial; :860 lineage; :990 concurrent creates | **Assertion reviewed, not run here.** Replacement survives old authority, denial causes no dispatch, approved child records source tuple/depth, parallel creates respect three-active cap. Additional cases cover scratch/route/context and untrusted results. |
| T5 | [tests/server/turn-controller-cleanup-proof.test.ts:14](../../tests/server/turn-controller-cleanup-proof.test.ts#L14); refusal cases :65; mismatch :187 | **Assertion reviewed, not run here.** Provider result alone waits for exact deferred cleanup receipt; missing/mismatched proof retains ownership. Distinguish this normal wait case from bounded forced/unconfirmed settlement. |
| T6 | [tests/server/provider-handoff-continuation.test.ts:192](../../tests/server/provider-handoff-continuation.test.ts#L192), handoff; :224 pre-session failure; :240 endpoint withholding | **Assertion reviewed, not run here.** Fresh target history/provenance, retry-visible history before session establishment, withholding text/files from a different endpoint. Additional inventoried cases cover restoration-none, goal guards, reused sessions and byte bounds. |
| T7 | [tests/server/queued-message-runtime.test.ts:101](../../tests/server/queued-message-runtime.test.ts#L101), stop/send; :293 accepted persistence failure; :357 lost enqueue acknowledgment; :449 route change | **Case inventory, not run here.** Also includes ambiguity, restart attachment ownership, cleanup waits, lost wake, update hold and final-answer ordering. Consult bodies before treating a new case as already covered. |
| T8 | [tests/server/restart-continuation-scheduler.test.ts:97](../../tests/server/restart-continuation-scheduler.test.ts#L97), eligibility; :226 retry cap; :252 restart reconciliation | **Case inventory, not run here.** Eligible update work, watcher exclusion, one dispatch, busy/hold, changed route/latest turn and bounded retries. |
| T9 | [tests/server/agent-thread-target-ownership.test.ts:47](../../tests/server/agent-thread-target-ownership.test.ts#L47) | **Assertion context reviewed, not run here.** Schema-81 upgrade must not invent authority to cancel historical target work. |
| T10 | [tests/server/runtime-sequencing.test.ts:79](../../tests/server/runtime-sequencing.test.ts#L79); [tests/renderer/runtime-sequencing.test.ts:56](../../tests/renderer/runtime-sequencing.test.ts#L56) | **Case inventory plus implementation review, not run here.** Monotonic publication, snapshot boundaries, sparse pane ownership, eviction, duplicate/gap/generation behavior. |
| T11 | [tests/server/agent-context-tool.test.ts](../../tests/server/agent-context-tool.test.ts), [conversation-context-request-coordinator.test.ts](../../tests/server/conversation-context-request-coordinator.test.ts), [conversation-context-v3.test.ts](../../tests/server/conversation-context-v3.test.ts), [conversation-context-turn-reads.test.ts](../../tests/server/conversation-context-turn-reads.test.ts) | **File inventory, not run here.** Retrieval/grants/transport coverage candidates. New cross-route wake context requires its own assertion review. |
| T12 | [tests/server/codex-app-server.test.ts](../../tests/server/codex-app-server.test.ts), [claude-agent-sdk-harness.test.ts](../../tests/server/claude-agent-sdk-harness.test.ts), [cursor-acp-harness.test.ts](../../tests/server/cursor-acp-harness.test.ts), [kimi-acp-harness.test.ts](../../tests/server/kimi-acp-harness.test.ts), [opencode-sdk-harness.test.ts](../../tests/server/opencode-sdk-harness.test.ts), [antigravity-cli-harness.test.ts](../../tests/server/antigravity-cli-harness.test.ts) | **Contract-file inventory from manifest, not run here.** Deterministic provider adapter suites. Manifest referencing a file does not prove every feature/failure combination is covered. |
| T13 | [tests/server/provider-host-tool-mcp.test.ts](../../tests/server/provider-host-tool-mcp.test.ts), [codex-host-tool-registration.test.ts](../../tests/server/codex-host-tool-registration.test.ts), [claude-host-tools-cancellation.test.ts](../../tests/server/claude-host-tools-cancellation.test.ts) | **File inventory, not run here.** Bridge transport, registration and cancellation candidates for capability-epoch work. |
| T14 | [tests/server/database-migrations.test.ts](../../tests/server/database-migrations.test.ts), [database-migration-lineage.test.ts](../../tests/server/database-migration-lineage.test.ts), [turn-scoped-indexes-migration.test.ts](../../tests/server/turn-scoped-indexes-migration.test.ts) | **File inventory, not run here.** Upgrade and lineage protection. New durable dispatch/edge tables need append-only migration fixtures. |
| T15 | [tests/server/turn-fresh-session-fallback.test.ts:58](../../tests/server/turn-fresh-session-fallback.test.ts#L58); guards :191, accepted follow-up :213 | **Case inventory plus guard source review, not run here.** Installation change, rejected native session, output/settled/follow-up exclusions. |
| T16 | [tests/server/diff-reversal-workspace-scope.test.ts:81](../../tests/server/diff-reversal-workspace-scope.test.ts#L81); changed context :169; recovery :210; [git-worktree-cleanup.test.ts](../../tests/server/git-worktree-cleanup.test.ts), [git-reversal-byte-roundtrip.test.ts](../../tests/server/git-reversal-byte-roundtrip.test.ts) | **Selected expectations inspected / broader file inventory, not run here.** Parent-file scope refusal, sibling context, retained backups, owned cleanup and byte preservation. Additional BOM/autocrlf tests exist. |
| T17 | [tests/server/cli-conversation-continuation.test.ts:46](../../tests/server/cli-conversation-continuation.test.ts#L46); native/context receipt :64; imported tools :101; archive :128 | **Case inventory, not run here.** Native versus context-only source and imported-session disclosures. |
| T18 | [tests/main/credential-vault.test.ts:84](../../tests/main/credential-vault.test.ts#L84); unavailable :117; rotation :149; concurrent creation :246; Linux :331 | **Case inventory plus vault source review, not run here.** Encryption/public mask, persistence rollback, generation/rotation, concurrent creation and plaintext fallback refusal. |
| T19 | [tests/server/private-connect/prompt-admission.test.ts:57](../../tests/server/private-connect/prompt-admission.test.ts#L57); [tests/main/private-connect/grants.test.ts](../../tests/main/private-connect/grants.test.ts) | **Prompt case inventory / grants file inventory, not run here.** Compaction/update/terminal gates, origin/queued admission and scoped grant candidates. |
| T20 | [tests/server/watcher-wake-runner.test.ts](../../tests/server/watcher-wake-runner.test.ts), [watcher-checkout-guard.test.ts](../../tests/server/watcher-checkout-guard.test.ts), [watcher-read-only-harnesses.test.ts](../../tests/server/watcher-read-only-harnesses.test.ts), [duo-launch.test.ts](../../tests/server/duo-launch.test.ts), [duo-inactive-recovery.test.ts](../../tests/server/duo-inactive-recovery.test.ts) | **File inventory, not run here.** Specialized workflow and recovery suites, not evidence of a generic scheduler. |
| T21 | [tests/renderer/inertia-connection.dom.test.tsx](../../tests/renderer/inertia-connection.dom.test.tsx), [composer-queued-prompts.dom.test.tsx](../../tests/renderer/composer-queued-prompts.dom.test.tsx), [subagent-timeline-focus.dom.test.tsx](../../tests/renderer/subagent-timeline-focus.dom.test.tsx), [response-timeline-render-stability.dom.test.tsx](../../tests/renderer/response-timeline-render-stability.dom.test.tsx) | **File inventory, not run here.** Appropriate DOM layer for connection, composer, focus and render-state changes; not geometry proof. |
| T22 | [tests/e2e/authoritative-run-state.spec.ts](../../tests/e2e/authoritative-run-state.spec.ts), [runtime-live-recovery.spec.ts](../../tests/e2e/runtime-live-recovery.spec.ts), [runtime-restart.spec.ts](../../tests/e2e/runtime-restart.spec.ts), [provider-handoff.spec.ts](../../tests/e2e/provider-handoff.spec.ts), [conversation-context.spec.ts](../../tests/e2e/conversation-context.spec.ts), [private-connect.spec.ts](../../tests/e2e/private-connect.spec.ts) | **File inventory, not run here.** Real Electron wiring and lifecycle/interaction scenarios. |
| T23 | [tests/performance/startup-profile.spec.ts](../../tests/performance/startup-profile.spec.ts), [scroll-profile.spec.ts](../../tests/performance/scroll-profile.spec.ts), [provider-refresh.benchmark.test.ts](../../tests/performance/provider-refresh.benchmark.test.ts), [checkpoint.benchmark.test.ts](../../tests/performance/checkpoint.benchmark.test.ts) | **File inventory, not run here.** Existing profiling/benchmark surfaces; no performance result claimed. |
| T24 | [tests/server/backend-profile-probe-monotonicity.test.ts:175](../../tests/server/backend-profile-probe-monotonicity.test.ts#L175); restart :225; per-model ordering :265 | **Case inventory plus admission source review, not run here.** Newer evidence survives out-of-order completion and persists across restart; model probes have separate ordering. |

The separate upstream drift workflow is [provider-contract-drift.yml:17](../../.github/workflows/provider-contract-drift.yml#L17): locked portable checks and latest SDK/CLI probes run in the compatibility canary. This audit did not execute that workflow or authenticate providers.

## Search scope and negative findings

| Question | Inspected search surface | Bounded conclusion |
| --- | --- | --- |
| Is there a durable global runtime event store? | Runtime composition, command router, sequencer, sync hub and turn repositories. | Sequencer explicitly disclaims event-store semantics; durable state is repository-ledger/projection based in these paths. |
| Are all commands serial and request IDs universally exactly-once? | WebSocket dispatch, router, send handler, queue, context replay and renderer timeout policy. | Concurrent admission and domain-specific idempotency; no universal durable request inbox found. |
| Can native sessions fork/rollback through a common command? | Shared continuation actions, provider/host contracts and command/tool definitions; `fork`/`rollback` search across server/contracts. | No general user-facing orchestration API found. Transcript parser records, SQL rollback and native delegate labels are not such an API. |
| Can managed children wake a parent via durable mailbox/wait-all? | AgentThreadManager tool definitions, mutation/settlement paths and management repository. | Status/latest-result polling and exact cancellation exist; a generic parent inbox/dependency scheduler was not found. Native continuation gates and watchers are separate. |
| Is there a general cron/recurrence scheduler? | Command handlers/migrations searched for schedule/cron/recurrence; restart, usage-reset, watcher and Duo controllers inspected. | Specialized continuation/wake owners found; no general scheduled-task engine in audited surface. |
| Does a local goal imply automatic background execution? | AgentWorkflowController local/native branches and normal turn admission. | Local metadata is not a generic agent loop. Native Codex goal control is separate. |
| Do all runs hold an exclusive checkout lock throughout? | Turn queue/start and send reservation release, ConversationWorkAuthority and reservation callers. | No universal lifetime lock established; ordinary send releases its transition reservation after start. |
| Does import cover every provider? | CLI command/discovery/parser/persistence implementation. | Codex and Claude source families found; production adapter count does not imply corresponding importer support. |
| Are host packs arbitrary third-party plugins? | HarnessCapabilityRegistry, production packs, host runtime/MCP. | Compiled reviewed pack construction; no arbitrary repository-code loading in these entry points. |

## Verification record and handoff boundaries

Executed under Node **v22.23.2**, Darwin arm64, using the existing installed graph:

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH /opt/homebrew/opt/node@22/bin/node node_modules/vitest/vitest.mjs run tests/continuation-policy.test.ts tests/server/authoritative-run-state.test.ts tests/server/authoritative-run-state-interleavings.test.ts tests/server/provider-capability-manifest.test.ts tests/server/harness-capabilities.test.ts --maxWorkers=1
```

Result: **5 files / 85 tests passed**, Vitest v5.0.5, reported duration 628 ms. No installation/build/native rebuild or live provider call was performed by this research track.

[package.json](../../package.json) defines `check` as quality checks, ordinary tests and bundled build. The coordinating track reports the full gate passed with exit 0 on Node v22.23.2: **1,404 files / 17,600 tests passed; 13 files / 149 tests skipped**, followed by successful builds and bundle gates. This research track checked the counts and successful build/budget tail in `.cache/orchestrator-v2/npm-check.log`; process exit 0 is the coordinator's report. It did not rerun the full check. This does not claim separate portable, Windows Codex, Linux package, E2E, packaging/fuses/provenance, real-account or benchmark execution by this track.

Owned deliverables: `inertia-current-state.md`, `inertia-source-map.md`, and the coordination-only `inertia-research-progress.md`. No application code or migration changed. Model/effort is not observable; effective permissions were unrestricted filesystem/network with approval policy never. No inference about model identity is used as evidence.
