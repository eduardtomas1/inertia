# Remaining provider integration seams

Checkpoint: 2026-10-30. Pi and OpenCode 2 provider implementations are in the
shared checkout. Cursor SDK and generic ACP remain required for the requested
T3 Code provider surface. This document records integration work that crosses
the provider partner's ownership boundary; it does not mark V2 complete.

## Pi requirement audit

Pi's provider-owned implementation is registered in production as provider `pi`,
harness `pi-rpc`, backend `builtin:pi`, and protocol `pi-native`. The coordinator's
append-only migration 108 admits those durable identities; its dedicated upgrade
fixture passes. No dependency on Pi was added to the repository: execution uses
an independently installed Pi 1.x binary through bounded JSONL RPC.

| Requirement | Implementation and evidence |
| --- | --- |
| Executable, environment and arguments | `pi-launch.ts`, discovery and the privileged environment allowlist retain literal argv, reject protocol/session/tool/credential overrides, and validate canonical extension/skill resources. Discovery uses isolated credential-free fixtures. |
| Models, thinking and context | Native model and thinking-level RPC metadata, exact selected model checks, image capability checks and nullable native token/context counters are covered by discovery and harness fixtures. |
| Native sessions and controls | Exact contained native session lookup; resume never silently creates a replacement. Native fork verifies the source and retained branch; rollback adopts a separate native fork. Empty histories use an explicit new-session recipe. Source files remain unchanged in fixtures. |
| Steering and lifecycle | Queued/started/handled dispositions are checked; image preparation rechecks active ownership. Unknown acknowledgements fail the run, clear owned queued input, abort and join process cleanup. `agent_settled` governs terminal execution, preserving retries after `agent_end`. |
| Skills, extensions and dialogs | Selected canonical skills and explicit trusted extensions are loaded. Native dialog IDs stay private; fresh app IDs map to exact native replies. Unsupported terminal-only UI is not advertised. Notifications/text widgets become activity. |
| Host and native tools | Ephemeral authenticated host MCP carries exact app turn authority. Managed native approvals enforce access modes; Bash and Windows PowerShell receive sanitized child environments. Platform selection and the actual shipped extension source have deterministic fixtures. |
| Identity and output bounds | Native session/head values are checked before publication. Tool IDs remain private, with a unique public ID per invocation; duplicate/foreign completions are rejected. Reasoning and answer chunks preserve Unicode and have explicit bounds. Transport, images, history and process cleanup have bounded handling. |

`tests/server/pi-{rpc-harness,events,bridge,dialogs,discovery,native-conversation}.test.ts`
currently pass **43 focused tests** on macOS arm64, including oversized protocol
frames and diagnostic-output cleanup. Windows tool selection is
simulated; Windows/Linux execution, real provider accounts, a live installed Pi
and packaged Electron wiring have not been exercised. These fixtures establish
the adapter contract, not upstream end-to-end compatibility certification.

The native tool allowlist follows the reviewed
[Pi 1.0.2 CLI contract](https://github.com/earendil-works/pi/blob/v1.0.2/packages/coding-agent/docs/cli.md).
The activity correlation follows its
[tool execution event lifecycle](https://github.com/earendil-works/pi/blob/v1.0.2/packages/agent/src/agent-loop.ts).
Extension code executes inside the trusted provider process; it is not an OS
sandbox. Native plan documents, terminal resume, arbitrary custom terminal UI and
programmatic composer replacement remain unavailable. Pi owns authentication;
Inertia neither copies native credentials nor reports passive authentication as
verified. Global restart/backing-policy and orchestration test failures remain
coordinator-owned and are recorded in `provider-implementation-progress.md`.

## Cursor SDK

The reviewed package is `@cursor/sdk@1.0.38`, matching the pinned T3 reference.
Its public package was inspected without installation or execution. Repository
dependencies and lockfile are unchanged.

| Boundary | Required integration |
| --- | --- |
| Durable identity | Add harness `cursor-sdk` in a new migration; retain provider `cursor` and protocol `cursor-managed`. Preserve existing `cursor-acp` records as separate native sessions. |
| Dependency and packaging | Pin the reviewed SDK; preserve its lazy runtime chunks and required platform assets. Update notices, production dependency audit and package verification. Its declared platform packages cover macOS/Linux arm64/x64 and Windows x64; Windows arm64 needs a proved compatible path before advertising availability. |
| Execution | Add an owned SDK worker boundary. Electron's `runAsNode` fuse is disabled, so `process.execPath` cannot be used as an ordinary Node worker in a packaged app. A main-process utility worker broker must enroll the worker and descendants before SDK execution, carry exact run/turn/instance/workspace identities, and confirm full tree cleanup before releasing ownership. |
| Credentials | The current runtime credential broker resolves/status-checks/clears secrets but does not save them. Main must own the SDK login result and vault write. Use `Cursor.auth.login` with `store: null`; return only safe login state/expiry to the UI. Pass the resolved key explicitly to SDK calls over a privileged channel, with a credential-free child environment. |
| Session store | Configure a dedicated canonical native store under Inertia's provider state. Do not fall through to the SDK's ambient default directories or inspect the user's existing Cursor stores. Preserve opaque native checkpoints through SDK store APIs. |
| Host tools | SDK `local.customTools` callbacks bypass its native approval path. Bind each callback to the exact Inertia turn and use `ProviderHostToolRuntime` for host approvals, cancellation and size limits. SDK child sessions must not inherit parent host-tool authority without explicit child binding. |

The provider adapter can then use `Agent.create/resume`, `send`, `Run.stream`,
`wait`, `cancel` and `steer`. Run completion requires the SDK's terminal result
and native store evidence, not a text or status notification. Only
`complete_delivered` acknowledges an active steering request;
`revert_to_followup` must remain a follow-up outcome. Local billing uses a usage
UUID, which is not the client `run-<uuid>` identifier.

The reviewed SDK does not expose native fork, rollback or interactive approval
callbacks. The pinned T3 adapter also marks those unavailable. Keep native
control capability honest and use the existing portable-history path where
appropriate. Apply tool restrictions again on resume. Use explicit
`settingSources` and child inheritance; project plugins and subagent executors
must not silently expand host authority. SDK cancellation errors must not be
suppressed with global unhandled-rejection handlers.

Authoritative API references: [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)
and the inspected public package declarations. The optional
[standalone SDK bridge](https://cursor.com/docs/sdk/bridge) is a separate execution
option; selecting it would require its own distribution and lifecycle checks.

## Generic ACP

The existing Cursor/Kimi adapters have provider-specific launch and login
contracts. Registry support needs durable per-agent instances, each binding the
registry ID, selected exact version/distribution, configured executable and
argument array, safe configuration revision, and selected authentication method.
Different instances must not share a native session identity merely because
both use ACP. Add the provider/harness/backend CHECK values and persisted
configuration through new migrations before exposing a selector.

Use the [official stable registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
and validate its bounded JSON against the
[registry format](https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md).
Binary downloads need exact hashes and contained extraction; npm/Python
distributions need exact package versions and an explicit installation operation.
Listing or inspecting registry entries must not execute package managers.
Keep installation receipts scoped to the exact agent and platform, and preserve
the existing installation lease and process-tree termination rules.

Authentication is negotiated from the exact executable's `initialize` response.
Agent-owned methods use `authenticate` with their advertised ID. Terminal methods
require a distinct interactive process, safe argument/environment validation,
confirmed zero exit, then reconnection and initialization. Do not advertise
terminal authentication for launchers that reparse a shell command. Follow the
[current ACP authentication protocol](https://agentclientprotocol.com/protocol/v1/authentication):
terminal arguments append to the configured invocation. The registry's separate
authentication guide still describes replacing arguments, so it is not a safe
source for that launch rule.

Before registration, deterministic fixtures must cover registry bounds and
platform selection, exact invocation/instance binding, agent and terminal login,
unsupported authentication methods, session resume, native notifications,
approval cancellation, malformed output, output limits, clean shutdown and
uncertain cleanup. Real provider accounts remain unexercised.
