# Remaining provider integration seams

Checkpoint: 2026-10-30. Pi and OpenCode 2 provider implementations are in the
shared checkout. Cursor SDK development runtime is wired, its packaged
distribution is blocked, and generic ACP remains unfinished for the requested
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

The development production path is wired: registered `cursor-sdk` harness,
external Node worker, guardian ownership, private bounded IPC, explicit vault
login, canonical custom native store, concrete model discovery and migration 109.
The P2 containment correction limits development execution to Linux; other
platforms fail closed before state creation/worker admission.
Existing `cursor-acp` session identities and default selection are unchanged.
[Provider progress](provider-implementation-progress.md) records source paths,
capability differences and exact checks. **Packaged distribution remains blocked**
by the [exact 1.0.38 license evidence](cursor-sdk-license-evidence.md); no UI or
runtime status may imply packaged readiness. Migration 110 remains core-owned.

| Boundary | Implemented contract and remaining limitation |
| --- | --- |
| Runtime options | Parent passes `cursorSdk:{stateRoot:join(dataDirectory,'providers'),credentials:options.backendCredentials}`. Credential resolve/status/save stay in privileged services. |
| Execution | Verified external Node 22.13+ with existing owned guardian/process-tree lifecycle; enrollment before SDK import or key delivery. Never use Electron process.execPath as Node. Cleanup confirmation is required before release/replacement. Linux actual worker/custom-store/parser probe passes; Windows/macOS store containment is unverified and unavailable. |
| Exact identity | Private start and callback envelopes bind conversation/turn/run/provider-instance/canonical workspace. Installation fingerprints cover worker chunks and SDK/platform assets. SDK evidence never borrows CLI capability evidence. |
| Login | `loginCursorSdk(onUrl:(url:string)=>void,signal:AbortSignal):Promise<{expiresAt:number}>` returns safe milliseconds only after vault save. `store:null` prevents a default SDK credential file. `https://cursor.com` only, no userinfo/control characters at published boundary. |
| Login commands | Parent owns `provider.cursor-sdk.login`, `.login.cancel` with `{loginRequestId}`, immediate acknowledgement and socket-targeted `.login.updated` states. Same-socket replay, overlap exclusion, disconnect/shutdown/deadline abort and held cleanup slots are implemented by parent. |
| Discovery | `.status` publishes only available/hasCredential/sdkVersion. Availability probes owned SDK/native bindings and exact `storeKind:'inertia-journal-v1'`; credential presence is not remote account verification. Packaged asar paths are refused until licensing/provenance is resolved. |
| Models | `.models` fetches authenticated SDK catalog after status. Shared bounded parser returns unique concrete `{id,displayName}` records, max512; strict published schemas prevent extra fields. No ACP catalogue or invented options. Parent serializes/deduplicates status/models, applies 35-second abort and holds the slot until settlement. |
| Selection | `harnessId:'cursor-sdk'`, `backendProfileId:'builtin:cursor'`, exact advertised `modelId`, null alias/reasoning/context overrides, empty options/capability flags. SDK controller requires current installation and model evidence at route resolution/admission. Renderer owns explicit account/model UI, with no default switching. |
| Native sessions | Inertia provider-state namespace plus canonical workspace/provider instance, custom LocalAgentStore on pinned journal fd. Fsync before mutation acknowledgement; native opaque records/checkpoints preserved. Kernel flock excludes simultaneous same-namespace writers and releases on crash. Existing SQLite/sidecar/checkpoint layouts are explicitly refused without deletion or automatic migration. Resume restrictions remain unchanged. |
| Host/native tools | Fresh application callback IDs with exact parent-session authority and replay rejection. ProviderHostToolRuntime owns host approvals. Empty settings, native read/full allowlists, no Task child executor; credentials only private IPC and credential-free shell/tool environments. |
| Capabilities | create/resume/send/stream/wait/cancel and verified steer outcomes wired. Native fork/revert/interactive native approval, images, plans, child observation/control, skills, usage and per-model options remain unavailable. |
| Packaging | Worker entry and lazy chunk/platform/dependency assets preserved in asarUnpack; runAsNode fuse unchanged. Package/lock already pin1.0.38. Notice generator remains strict; missing authoritative platform/vendor artifacts block notices, release packaging and packaged smoke. No fallback licenses or checks waived. |

The source comparison at T3
`32ecd71726fee16f335484c1f95cbce126d461f6` is unchanged under
`packages/provider-cursor` from prior `dd148481531a0a090780a2ade20588566db099a2`.
Both declare native fork/revert/interactive approval unavailable. T3 disables
active steering, loads more ambient settings, enables retries, runs SDK in process
and offers richer event/options surfaces. This route tests pinned Run.steer
outcomes, uses an owned external worker, explicit restricted settings/tools and
honest unavailable capabilities. It adds no global SDK rejection suppression.
The complete comparison and validation attribution are in provider progress.

The [official TypeScript SDK documentation](https://cursor.com/docs/sdk/typescript)
and installed exact declarations are API evidence; neither establishes missing
binary notice provenance. All five platform tarballs omit notices. The only
byte-proved supplemental component is Linux x64 ripgrep; tree-sitter/native
bindings/cursorsandbox/full notices and platform scope remain unresolved.

Store containment details and exact regression commands are recorded in the P2
correction at the top of provider progress. Ancestors are individually pinned
with no-follow traversal; journal writes never reopen a descendant pathname.
The existing ffi-rs dependency provides Linux kernel flock; no PID recovery or
new dependency is introduced. Limits are 128 MiB per append-only journal, 8 MiB per
record, 6 MiB per checkpoint, 1000 rows per page and 64 ancestor components. No
compaction or automatic malformed/truncated-tail recovery is implemented. This
is not an OS sandbox against root or arbitrary same-uid writers. Final source
store/process/session/harness tests pass 40/4; historical SQLite proof does not
certify this replacement. Parent status tests require the custom-store identity.

Remaining integration work belongs to the parent final check/review and upstream
packaging evidence. No further core/shared contract request is outstanding from
this provider checkpoint. Full portable was a mixed snapshot with ten old
conformance-fixture failures; the corrected conformance file passes all95 tests,
not a claim of final integrated clearance. No real account or paid call was made.

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
