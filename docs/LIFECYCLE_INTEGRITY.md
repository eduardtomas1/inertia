# Lifecycle integrity

This document is the review map for Inertia's asynchronous ownership model. It
is intentionally an engineering contract rather than a claim that every
resource has identical mechanics. Native Windows containment, Linux process
identity and guardian evidence, and conservative Darwin recovery remain
different implementations of the same fail-closed law.

Work began from `origin/main` at
`7f770c918bfd92fcc761e7eae73e7d47b4c66f69`. The previously audited baseline
was `56ce34f75ce11843584a04e495d4a3cf6ef87cc8`. Before final validation the
branch integrated `origin/main` at
`7c923afc724b9d18fd801f7e3cbb379455358caf`, preserving the intervening Linux
guardian, utility-worker acknowledgement, and native Gemini provider work.

## Common law

The engineering rule is that every asynchronous operation must have one
admitted owner, an immutable identity, a monotonic lifecycle, one terminal
authority, and explicit cleanup evidence. This change applies that rule at the
provider-run, root-turn, provider-maintenance, and application-update seams; the
inventory below also records where an older subsystem distributes evidence
across several records rather than one common receipt. A timeout, rejected
promise, missing map entry, closed stream, absent PID, or caught exception is
never cleanup proof. Replacement stays closed until cleanup is confirmed; a
quarantine preserves evidence but does not itself authorize replacement.

The canonical identity chain is:

`runtimeGenerationId` -> `systemBootId` -> `conversationId` -> `runId` ->
`turnId` -> `providerId` -> `harnessId` -> backend/configuration identity ->
provider-native session/thread/task/call identity.

Update, maintenance, recovery, attachment, and other non-turn work adds an
operation ID. `runtimeGenerationId` remains the generation vocabulary; there
is no parallel epoch identifier.

## Monotonic lifecycle

These are review states, not a new universal state enum. Existing owners use
their more precise local types:

1. `queued` -> `admitting` -> `active`
2. `active` may temporarily own `awaiting-approval`, `awaiting-input`, or one
   serialized `follow-up-in-flight` interaction.
3. `active` -> `cancelling` or directly to `terminal-outcome-selected`.
4. `terminal-outcome-selected` -> `cleanup-pending` -> `cleanup-confirmed`.
5. Any unprovable identity or cleanup edge moves to
   `quarantined/recovery-required`; it never moves back to `active`.

The run-state engine and turn controller own the durable root outcome.
Provider terminal messages are evidence only. Provider output is
non-authoritative after cancellation intent, terminal persistence, owner
replacement, or any identity mismatch.

## Ownership inventory

"Active / durable" names the live state first and crash-surviving evidence
second. `none` means that the operation must finish under its owning parent
lease; it does not mean an in-memory absence proves cleanup.

| Resource | Admission owner and immutable identity | Active / durable state | Terminal authority | Cleanup proof, quarantine, recovery, and replacement gate |
| --- | --- | --- | --- | --- |
| Runtime generation | Electron `RuntimeSupervisor`; `runtimeGenerationId` + `systemBootId` | `RuntimeProcessRecord` / runtime lease, owned-process journal, cleanup receipts | Supervisor accepting the exact worker event for its current record | Windows Job Object or exact POSIX guardian/process evidence plus generation receipt. Unconfirmed cleanup blocks bootstrap and all replacement generations. |
| Runtime worker | Supervisor; generation identity + native process creation identity | `RuntimeProcessRecord.child` / containment and owned-process records | Supervisor after exact `runtime.stopped`, child close, and generation cleanup | Supervisor joins one bounded shutdown/force path. Late worker messages are ignored. Startup recovery reconciles the prior record before spawn. |
| Runtime HTTP/WebSocket server | Worker runtime; runtime generation + loopback server instance | Runtime server/socket registries / covered by runtime lease | Runtime shutdown coordinator | Listener close and all socket/operation drains must finish before the worker can report stopped. The supervisor remains the outer cleanup authority. |
| Provider run | Turn controller and `ProviderManager`; exact provider, conversation, run, turn, harness, and backend tuple | controller/manager active maps / `provider_run_ownership` row | Server run-state engine selects the root outcome | The manager first validates the exact terminal-result tuple and `cleanupConfirmed: true`; the turn owner clears durable ownership and releases attachments only after exact `stopOwned(...) === "settled"` proof. Missing, mismatched, detached, thrown, or false cleanup evidence retains ownership, quarantines admission, and leaves startup recovery to reconcile the durable row. |
| Provider session/thread | Exact provider adapter; native ID bound to continuation identity | adapter session / conversation and turn session snapshots | Server decides whether the native ID is eligible for reuse | Adapter closes protocol resources; continuation requires an exact compatibility token. Unknown or changed compatibility preserves history but starts a fresh provider session. |
| Provider-owned server | OpenCode SDK harness; provider run tuple + server process identity | harness-owned server/client / owned-process evidence under the runtime generation | Harness only after protocol terminal and server cleanup | SSE/client settlement alone is insufficient. Process-tree/server shutdown failure poisons cleanup and keeps replacement admission closed. |
| Provider metadata/model/auth probe | Provider manager metadata scope; provider + installation/configuration + exact model identity + probe operation | discovery/metadata operations / a bounded versioned per-model evidence envelope | Probe owner | Exact child-tree cleanup and bounded parser completion. An immediate database transaction rejects older same-model completions and configuration drift while preserving independent models. Maintenance and shutdown wait for probes; installation/capability changes invalidate cached evidence. |
| Provider maintenance/update | Runtime preparation gate and maintenance controller; operation ID + installation identity | reservations/active operation / integrity-checked maintenance journal while replacement may survive a crash | Maintenance controller after post-action re-resolution and verification | Admission requires an active, exact-installation capability attestation. Owned action cleanup is followed by provider detect/auth/metadata/capability verification, version re-read, and cache invalidation. Active runs, probes, recovery, shutdown, or another lease block admission. This does not claim a real production turn is run as a post-update probe. |
| Terminal/PTY | `TerminalManager`; runtime generation + terminal ID + project/conversation authority | terminal registry / terminal ownership and runtime process journal | Terminal manager | Direct PTY close plus descendant/guardian proof. Concurrent closes join; uncertainty poisons runtime shutdown and blocks replacement ownership. |
| Git subprocess | Git operation owner; scoped project/repository + operation + child identity | tracked Git operation / checkpoint or repository receipt where applicable | Calling Git workflow | Original bounded deadline and exact process-tree proof. Cleanup failure is an operation failure, never converted back to timeout/success; the working tree is not discarded. |
| Agent child turn | `AgentThreadManager`; parent provider/conversation/run/turn + child conversation + handoff ID | active child registry / durable conversation provenance | Child's own turn controller; parent cannot synthesize its result | Stop targets the exact active child and waits for provider cleanup. Depth, active-child, access-ceiling, and source-turn checks are revalidated before every mutation. |
| Approval request | Turn interaction coordinator; provider/conversation/run/turn + request/call ID | one open interaction / durable projected interaction state | Current exact turn interaction state | A response atomically consumes the open request. Duplicate, replayed, late, cancelled, cross-provider, cross-run, and cross-turn responses are rejected. |
| Structured user-input request | Turn interaction coordinator; same tuple plus input request ID | one open interaction / durable projected interaction state | Current exact turn interaction state | Schema validation and exact-owner dispatch are required. Timeout and response race through one terminal interaction transition; root terminal cleanup retires it. |
| Follow-up/steer request | Turn controller; exact active tuple + serialized follow-up ID | process-local per-turn tail/queue; provider acknowledgement is persisted after dispatch | Current root turn | Attachment resolution and owner identity are revalidated immediately before dispatch. Cancel, terminal, continuation change, or replacement rejects queued/late work. A pre-ack in-flight follow-up has no separate durable queue record and is resolved through turn recovery after a crash. |
| Host-tool request | Process-local host-tool bridge; Inertia tuple + native provider thread/turn/tool-call ID | exact-turn bridge/call registry / no provider payload persisted | Host bridge policy and exact root turn | Cancellation/terminal revokes authority and settles pending calls. Approval cannot be supplied by the provider. Late/replayed native calls are deterministic failures. |
| Attachment work | Main attachment broker/store runner; handoff/request ID + conversation/attachment identity + owning runtime record | request and claim registries / attachment metadata and one-shot worker protocol | Main-process broker for filesystem result; turn controller for transcript use | One-shot result acknowledgement, worker close, claim release, and exact runtime ownership. Partial/corrupt work preserves user content and is reconciled without exposing paths. |
| Artifact generation | Turn artifact owner; conversation/run/turn + artifact operation ID | pending artifact/turn state / generated attachment and turn records | Root turn's authoritative settlement controls publication | Generation is cancelled/rejected after terminal; durable artifacts remain downstream of settlement and are never used to revive a turn. Recovery preserves content under uncertainty. |
| Updater download | `AppUpdateService`; one update operation ID + channel/version | one coalesced download operation / provider-native cache plus handoff evidence once installation is prepared | App update service | Late progress/cancel events are scoped to the exact operation. Download success is not install or handoff success; a new download cannot replace active install ownership. |
| Updater installation | `AppUpdateInstallCoordinator`; update operation + old/new versions + old runtime generation + profile/data and candidate identities | install coordinator / integrity-checked handoff journal | Monotonic handoff state, not an updater callback | Runtime, provider, terminal, maintenance, Private Connect, and descendant cleanup must be confirmed. Corrupt, stale, expired, or wrong-identity handoff evidence blocks admission and retains rollback authority. |
| Linux AppImage candidate | Old app update owner; handoff operation + exact candidate dev/inode/content/version identity | staged candidate / AppImage transaction and handoff journals | Exact candidate bootstrap acknowledgement followed by ownership-transfer commit | Spawn is not readiness. Candidate bootstrap mode cannot admit providers or mutations. Failure keeps backup/journals; a validated candidate that cannot acquire ownership cannot start a second runtime. |
| Private Connect process | Main Private Connect service; runtime/profile + owned child/request identity | service/preparation gate / runtime-owned process evidence | Main service coordinator | Update/quit closes admission, drains requests, and proves child-tree cleanup. Unconfirmed cleanup blocks privileged app handoff. |
| Guardian/helper process | Runtime/process owner; generation + boot + record ID + PID creation/start/session evidence | native/helper registry / owned-process journal, guardian handoff, integrity manifest | Platform containment/recovery implementation | Windows Job Object is primary; Linux uses `/proc` start time, group/session, and guardian evidence; Darwin remains conservative and quarantines fork-tainted uncertainty. Helper integrity is pinned. |

## Runtime and process ownership definition

Windows containment is admitted before `runtime.start`. The native process
creation identity and named Job Object remain authoritative; `taskkill` is a
fallback and never proof that descendants were captured. Linux recovery uses
`/proc` start-time, boot, process-group/session, generation, journal, and
guardian evidence. Darwin deliberately does not claim Linux-equivalent
descendant proof and may require manual recovery. Direct-child,
descendant/containment, guardian/helper, and durable-clear evidence is retained
by the owning process records and platform coordinator; the compact durable
runtime cleanup receipt records the exact generation and final confirmation,
not every intermediate proof field in one object.

Every concurrent cleanup caller joins one owner promise. Graceful cleanup may
monotonically upgrade to force, but neither a timeout nor escalation erases
unconfirmed durable ownership.

Startup recovery is also an admission boundary. An unresolved prior-runtime
safety lock rejects runtime initialization before attachment initialization or
`RuntimeStore` construction, so it cannot migrate or reconcile the database.
For an admitted startup, the provider maintenance journal is recovered before
credential/profile initialization receives mutation authority. Ambiguous
maintenance evidence remains quarantined and provider admission stays closed.

## Provider capability matrix

`native` means the exact production transport exposes the operation;
`negotiated` means availability must be learned for the installed protocol;
`host` means Inertia supplies a separately labelled exact-turn host feature;
`application-context` means visible conversation history is reconstructed into
a fresh provider session rather than claiming native resume; `none` is a
deterministic unsupported result, not silent emulation.

| Capability | Codex App Server | Claude Agent SDK | Cursor ACP | Gemini ACP | Kimi ACP | OpenCode SDK |
| --- | --- | --- | --- | --- | --- | --- |
| Streaming text | native | native | native | native | native | native |
| Reasoning/thinking | native summary | native streaming | native | native output; no effort selector | native | native |
| Tool/file activity | native | native | native | native | native | native |
| Images/attachments | native local input | native structured input | negotiated ACP | negotiated at initialize | negotiated ACP | native file input |
| Plans | native | native | native | negotiated session mode | native | native |
| Approvals | native | native | native | native ACP request; exact-turn Inertia/user decision | native | native |
| Structured input | native | native | Cursor extension | none | native-over-permission | native |
| Follow-up/steer | native parent steer | native persistent stream | none unless attested | none | none unless attested | native prompt input |
| Session resume | native thread | native session | native session | application-context | native session | native session |
| Usage/rate limits | native | native result usage | optional ACP / negotiated | negotiated usage / no rate limits | optional ACP / negotiated | native token usage |
| Structured subagent create/stop | events / no exact stop | native task IDs / stop | none unless attested | none | protocol-specific | none unless attested |
| Host-tool bridge | host, exact-turn | host, exact-turn | host, exact-turn | host, exact-turn on built-in route | host, exact-turn | host, exact-turn |
| Model/auth discovery | App Server / CLI | SDK / CLI | ACP/config | session catalog / no separate auth-state probe | ACP/config | owned server/config |
| Cancellation and cleanup | protocol interrupt + process containment | SDK abort/close + containment | ACP cancel + containment | ACP cancel + session/process cleanup | ACP cancel + containment | prompt abort + owned-server cleanup |
| Provider-owned server | none | none | none | none | none | native, run-owned |
| Custom backend / endpoint / performance mode | attested route / endpoint / native mode | attested route / endpoint / native mode | none | none | none | none |
| In-app maintenance | installation-dependent | installation-dependent | installation-dependent | npm/Homebrew installation-dependent | manual only; non-interactive update unavailable | installation-dependent |

The machine-readable manifest and runtime attestation are versioned and bound
to one harness, provider installation/configuration identity (including
device/inode/size and nanosecond file-time evidence when a direct executable is
available),
protocol/harness revision, and manifest digest. Manifest entries distinguish
declared/native support, version compatibility, required configuration, and
deterministic unavailable behavior. Runtime evidence can narrow availability,
including explicitly negotiated custom backend/endpoint features; it may never
widen the manifest. A custom HTTP backend receives only lifecycle-safe harness
capabilities plus features positively exercised by its exact stored probe. The
bounded HTTP check first attests streaming text and, when present, usage. A
Responses backend then receives a separate bounded request containing one
randomized inert function. Authority is granted only after the exact call is
observed and the backend accepts a second response containing the matching
function result; the result nonce exists only in that authoritative tool
output. An unsupported or inexact continuation preserves the text result
without granting tool authority. Model hints cannot authorize images,
reasoning, goals, plans,
approvals, compaction, session resume, or host tools. Plan-mode admission
therefore requires a positive `plans` attestation. A text-only custom Claude
route starts the SDK with an empty built-in tool set and a deny-before-execution
permission fallback. Codex App Server exposes no audited per-thread switch that
removes all provider-native tools, so a custom Codex route is rejected before
harness start unless its exact model probe positively attests tools. Probe
evidence is durable and monotonic independently per profile/model, bounded to
128 configured models, and every retained model result is hydrated after
restart. Custom host-tool injection remains disabled until a dedicated bridge
probe exists, even when the provider's native summary advertises that bridge;
the immutable built-in Kimi-through-Claude profile retains Claude's trusted
exact-turn host bridge. Gemini's host bridge is likewise admitted only for the
exact built-in `gemini` / `gemini-acp` / `builtin:gemini` route and only when
the ACP HTTP MCP channel is available; foreign or custom profiles cannot
inherit that authority. Gemini also requires provider-native tools before
spawn because persisted allowlists can bypass a permission callback. Each
Gemini turn creates a fresh ACP process and session, never calls
`session/load`, never exposes its internal session ID, and reconstructs only
bounded visible user/assistant history. Explicit model selection is accepted
only after the new session advertises that exact model and `session/set_model`
succeeds. Custom runs also bind the persisted selection,
deprecated model projection, privileged launch spelling, and exact probe to one
model identity. A changed executable or backend probe withdraws its prior
attestation, and maintenance is available only when the exact verified installation
negotiates that operation. Conformance registration proves each
production harness as a whole. It does not yet claim independent
observed/exercised telemetry for every feature, and the UI currently summarizes
capability counts rather than showing a per-feature evidence ledger.

The former direct CLI harness is retained only as the explicitly named
`createLegacyCliAgentHarnessForTests` fixture for lifecycle tests and
benchmarks. The production registry and capability manifests exclude every
legacy CLI route, and a sunset test pins that boundary.

## Session-continuation compatibility

A reusable native session is identified by the existing route identity plus a
checked compatibility token covering:

- canonical provider executable path/package and exact executable or SDK
  version;
- protocol and harness implementation revisions;
- capability-manifest digest;
- the currently observed custom-backend capability boundary;
- backend configuration revision and opaque endpoint identity;
- model identity where the transport cannot switch safely; and
- relevant performance mode.

Historical identities without the token are incompatible by construction.
Custom routes without positive session-continuation evidence do not receive a
compatibility token, even when their text probe succeeds. They therefore start
a fresh provider session instead of attempting a resume that would fail later.
The safe migration is to retain the conversation, transcript, attachments,
and native ID for audit, record a bounded reason code, clear it from admission
authority, and start a fresh provider session. Missing compatibility must not
break startup and must never silently force continuation.

## Cross-version application handoff

The handoff journal is a strict-key, bounded, versioned, atomically published,
integrity-checked record. It binds an update operation to old/new app versions,
the old runtime generation and system boot, expected candidate artifact,
profile/data identity digests, creation/deadline, and one monotonic phase.

The phases retain distinct safety commit points: prepared, candidate launched,
candidate bootstrap validated, old-generation cleanup confirmed, transfer
committed, candidate admitted, completed, or rollback required. The exact
enumeration lives with the journal schema. A callback or child spawn cannot
skip a phase.

On Windows, native electron-updater/NSIS remains the installer. The old app
must publish preparation and exact privileged-cleanup evidence before updater
quit. The new app consumes compatible authority before it admits provider or
mutation work. The release build hashes the final resource-edited and signed
application executable, places that digest in the subsequently signed NSIS
metadata, and verifies the marker in the completed artifact. Preparation pins
and hashes that installer; candidate startup pins and hashes the actual launched
executable, so a same-path replacement cannot inherit the handoff authority.
The native supervisor waits only until the handoff deadline. If its exact
installer handle has not signalled, it does not kill NSIS, inspect a namespace
that NSIS may still be mutating, or relaunch either generation. Instead it
atomically publishes an authenticated `quarantined` receipt with no claimed
installer exit or executable digest and exits. Startup authenticates that
receipt after a reboot, preserves the journal, token, helper, and receipt as
recovery evidence, reports the safety lock, and refuses normal bootstrap.

The staged Windows supervisor is not executed by its pathname. The already
integrity-locked native broker opens and hashes the staged leaf, passes those
exact bounded bytes to a fresh trusted system PowerShell host, and that host
loads the verified assembly bytes in memory while retaining the staged leaf.
Direct `update-supervisor` executable entry is fail-closed. Before `READY`, the
loaded supervisor creates and flushes one HMAC-authenticated operation/launch
claim with an exclusive native handle. A competing launch therefore cannot
start NSIS or publish a second terminal result. The terminal receipt replaces
that same owned handle and is renamed by handle; an interrupted claim remains
a startup blocker and is never interpreted as cleanup. Parent wait, exact
installer wait, terminal classification, and relaunch consume one Stopwatch
budget derived once from the claim-authenticated handoff deadline, so wall-clock
changes cannot refresh native authority.

The JavaScript launch boundary canonicalizes data, installer, and executable
paths once before hashing and serializing them, so retargeting a caller-supplied
parent junction cannot redirect the admitted helper request. A live Windows
test repeats that namespace substitution. Holding every canonical ancestor by
native directory handle against a concurrent rename is not currently an
available primitive in this helper; the affected Windows lifecycle/package
lane remains the explicit validation boundary for that narrower race, and no
local Linux result is reported as proof of it.

On Linux, existing direct-file, ownership, no-symlink, dev/inode, fsync,
hard-link backup, no-clobber, and rollback protections remain. A staged
candidate runs in a restricted bootstrap-validation mode and acknowledges the
exact handoff; it cannot start providers, terminals, maintenance, background
mutations, or normal command handling. The old app commits replacement and
cleanup only after that acknowledgement. Rollback authority is retired only
after the candidate observes ownership transfer and publishes admitted state.

Candidate viability opens the live database read-only, migrates only a bounded
in-memory clone, and semantically validates each recognized runtime and provider
maintenance journal. Unsupported schemas, extra keys, filename/body identity
mismatches, damaged integrity digests, foreign entries, redirects, and partial
publications block the candidate. This inspection never repairs, consumes, or
deletes durable recovery evidence; ordinary startup or the old owner retains
that authority.

## CI evidence tiers

The path classifier is conservative and fail-open. Unknown paths, shared
lifecycle code, workflow/test infrastructure, manifests, lockfiles, build
tools, and the classifier itself select broad evidence.

- Pull requests run quality, the complete platform-neutral coverage suite,
  every generated portable production-provider contract, and dedicated
  Linux/Windows/macOS lifecycle jobs. The Linux job includes a compact
  synthetic-provider Electron/core bridge and a packaged AppImage/container
  smoke.
- The classifier emits invariant domains and fails open. In this workflow those
  domains choose between the critical tier and the full six-target tier; they
  do not yet create a separate targeted job for each individual domain.
- Pushes to main, merge-queue groups, schedules, and full-certification changes
  retain the six OS/architecture matrix, destructive recovery, package and
  installer/container evidence, dependency audit, and conditional benchmarks.
  Scheduled runs attempt selected lifecycle invariants up to three times per
  target, stopping early only when cleanup is unconfirmed, retain every attempted
  run, fail on mixed results, and update a bounded tracked issue
  on certification failure. Stable Windows x64 installs a checksummed published
  N-1 artifact, smokes it, installs N over the same directory, reopens the same
  profile/database state, verifies N against the unpacked candidate, and
  uninstalls it.
- The independent release workflow builds the application bundle once per
  target, packages and smokes that same bundle, then checksums, stages,
  re-verifies, and publishes the exact certified bytes plus a CycloneDX
  dependency SBOM covering the cross-platform production lockfile union and
  bound to the frozen source SHA, tag, lockfile, and exact staged asset digests.
  Each target retains release-candidate platform, desktop, and package-smoke
  performance evidence. Cross-job fan-out is not claimed; each native target
  remains one ownership boundary.

The packaged Windows transition proves successful NSIS replacement and
same-profile startup. It does not claim a packaged native-`electron-updater`
initiation or deterministic privileged-installer interruption/rollback; those
remain explicit release-evidence boundaries.

Portable-provider discovery is generated or convention/project based and an
architecture test compares it with the default production harness registry.
Windows sharding uses a bounded successful-run duration manifest and
deterministic longest-processing-time assignment. Unknown entries receive a
non-zero p90-derived weight so they cannot disappear from a shard; they do not
by themselves broaden the evidence tier.

### Timing evidence

Pre-change successful GitHub run and job URLs are recorded in the CI evidence
report. The final PR description will add final-SHA hosted results after they
exist. Until then the Windows rebalance is explicitly a projection, not an
observed after measurement.

## Persisted-format migration notes

- Handoff and maintenance journals carry explicit positive schema versions,
  strict bounded keys, canonical integrity digests, and atomic publication.
  Capability manifests are versioned code constants; the bounded continuation
  reason is a checked nullable database column appended at schema 68.
- Released schema 67 retains the native Gemini provider rebuild unchanged.
  Schema 68 adds continuation evidence after that rebuild, preserving upgrades
  from both pre-Gemini databases and existing schema-67 installations.
- Existing provider continuation records without the full compatibility token
  are readable but cannot authorize resume. They fall back to a fresh session
  without deleting conversation data.
- Existing single-result backend probe JSON remains readable. The next
  successful probe writes a versioned, bounded collection with at most one
  monotonic result per configured model; incompatible profile revisions still
  invalidate the entire collection.
- Existing runtime lease, owned-process, cleanup-receipt, AppImage transaction,
  and recovery journals are not rewritten or optimistically cleared.
- Unsupported, partial, duplicate, stale-generation, wrong-boot,
  wrong-installation, wrong-checksum, symlink-substituted, or expired records
  fail closed with a safe reason code.

## Operational diagnostic contract

Runtime diagnostics expose the app version, a short hash of runtime and boot
relationship, phase and bounded durations, safe blocker/quarantine reason
codes, cleanup proof method, resource counts, provider/harness/version and
capability digest, maintenance state, and unresolved turn or interaction
counts. GitHub Actions builds also embed the strictly validated checked-out
source revision, numeric run ID/attempt, and an exact release tag on tag events;
branch names, workflow text, repository URLs, and arbitrary environment values
are not embedded. Local/unbundled development reports this metadata as
unavailable. The main-process copied support report additionally merges the
current update-preparation blocker and update-handoff phase. The live runtime
snapshot does not yet receive the main-owned handoff phase. A malformed runtime
start timestamp projects as unavailable with zero derived uptime rather than
escaping the strict diagnostic schema. Provider cleanup compares the exact
durable and live conversation-owner sets rather than their counts alone. The
maintenance-controller projection is bounded to the six known provider IDs
and a fixed state; it can expose that a provider is quarantined without
exposing installation identity, reason text, command output, or paths.

They never expose prompts, message/provider payloads, tokens, authorization
headers, command lines, environment values, raw external errors, or full home
paths. Known locks project an actionable state instead of an indefinite
spinner: ready, finishing prior work, waiting for cleanup, cleanup unconfirmed,
installation changed, continuation rejected, capability unavailable, or manual
recovery required. When the privileged updater rejects restart for active agent
work, Settings and the copied report select `update-blocked-by-active-work`
from the fixed main-owned blocker code. Stronger cleanup or recovery locks keep
priority over that update-specific state.

## Review invariants

Characterization and adversarial tests must finish by proving, where
applicable: one runtime/provider owner; one root terminal outcome; no live
descendant, containment, guardian, provider server, interaction, host-tool,
child-agent, maintenance, or handoff authority; exact cleanup receipt identity;
database reopen; and replacement admission only after proof.

Test-only fault injection uses deterministic clocks, controlled promises, and
typed receipts/events. Arbitrary sleeps, global timeout widening, blind retry,
and process-spawn readiness are not accepted fixes.
