# Provider native operations implementation

## Stopped checkpoint — 2026-10-30

The human requested both chats to commit, push and stop. Implementation stopped
immediately; no further test/fix cycle is being run. This is unfinished V2 work.

Pi and OpenCode 2 have the earlier verification recorded below: all provider
fixtures passed, with Pi at 43 focused tests. The last complete shared portable
gate had 3687 passes and four core failures; the last full check had 17660 passes,
130 failures and two unhandled mock-seam errors. Those results predate the latest
Cursor edits and the primary's current core repairs. The separate bundle compiled
but failed renderer size budgets by about 6 KiB. Real accounts, live provider
execution, Windows/Linux and packaged Electron remain unexercised.

The new Cursor work is only a partial foundation: exact `@cursor/sdk@1.0.38` was
added with install scripts disabled (package/lock synchronized; seven packages
installed), and private credential request/result parsing was extracted into
`src/node/runtime-credential-protocol.ts`. An SDK-specific credential save path
was started in the main vault broker/coordinator and runtime broker client. These
latest changes have **not** been typechecked or tested. npm reported two moderate
audit findings; dependency review, generated notices and packaging verification
are unfinished. No SDK worker, production harness, login flow or new migration
was implemented. Generic ACP implementation has not started. The worker text in
the assignment section below describes the intended design, not shipped behavior.

The provider checkpoint commit uses explicit provider, provider-test, dedicated
credential, package and provider-document paths. Shared renderer/contracts,
`providers.ts`, environment/runtime plumbing and all root-owned
orchestration/fork/queue/test-repair files are left for the primary's consolidated
checkpoint. The persistent Cursor/ACP goal will be paused after commit/push.

## Cursor SDK / generic ACP assignment — active, 2026-10-30

The primary chat resumed and explicitly assigned the previously deferred worker,
vault/login, dependency/packaging and append-only migration seams to this partner.
A new persistent goal covers the complete Cursor SDK integration followed by
generic ACP registry/provider instances. This is implementation work, not a
research checkpoint. Root retains orchestration/fork/delegation/queue/client
integration and core test repairs. No commits, pushes, merges, additional agents,
or chats; focused tests only while the primary runs its full gate.

Current worker decision: reuse the existing verified external-Node discovery and
owned native guardian/process-tree lifecycle for a dedicated SDK worker. A real
Node 22+ executable is required; Electron's `process.execPath` is never treated as
Node. The app bundles the pinned SDK and worker assets. The worker receives keys
only through private IPC after ownership admission and gives native tools a
credential-free environment. This is the alternative verified executable boundary
allowed by the original seam; it avoids an unowned utility process or disabled
Electron fuse. Login returns the minted key only to the main-owned credential
save broker; no default SDK credential file is used.

Dependency work will add exact `@cursor/sdk@1.0.38` with install scripts disabled,
review its platform assets and regenerate notices. No `npm ci` or full check is
currently running in this partner. Planned next migration reservations: 109 for
the distinct `cursor-sdk` harness, followed by 110 for generic ACP identities and
instance configuration; existing `cursor-acp` histories remain separate.

## Pi goal completion audit — 2026-10-30

The specified Pi goal is complete. The final audit inspected production registry
and model routing, migration admission, configuration validation, model/thinking
and usage projection, native controls, active steering, skills, the shipped
extension/host bridge, dialogs, output bounds, cleanup and credential handling.
It also followed the runtime call sites: skill commands reach `piSkills`, native
boundaries reach durable projection, and native fork controls reach the registered
provider operation with the exact instance and workspace identities.

All 18 Pi source/test files are unchanged since the completed full check. The
authoritative results remain 43 focused Pi tests passing; portable 3687 passing
with four unrelated core failures; and full quality checks passing with the 130
existing core/renderer test failures and two mock-seam errors described below.
The separate bundle compilation succeeded and its shared renderer-size gate
failed. Those are explicit repository integration limitations, not green gates.
The original boundaries remain intact: no protected core edits, Git mutations,
dependency changes or real-account access were needed for this completion audit.

This closes the Pi objective only. The larger V2 request, Cursor SDK/generic ACP
integration, and shared repository gate repairs remain incomplete and are
documented in `provider-integration-seams.md`. Live Pi, Windows/Linux and packaged
Electron behavior remain unexercised, as specified in that audit.

## Pi completion audit — 2026-10-30 00:42 UTC

The current goal audit found and fixed additional provider-owned gaps. Pi
extension dialogs now retain native IDs privately and expose fresh application
request IDs, including when provider-authored IDs contain a credential value.
Unrelated answer keys do not consume a dialog. Session IDs are checked before
publication; secret-bearing native heads are withheld, and native fork results
cannot publish unsafe session/head IDs even in an uncertain mutation result.

Steering now rejects images when the selected model supports only text and
rechecks live-turn ownership after asynchronous image preparation. An unknown
steering disposition fails the run, attempts `clear_queue` before `abort`, and
joins owned-process cleanup rather than leaving the turn active until its global
deadline. No success claim is made about queue cancellation when native cleanup
cannot be confirmed.

Five focused Pi files / **32 tests pass**
(`/tmp/inertia-pi-audit-focused-final.log`). Unit typecheck, focused lint and
`git diff --check` pass. The full portable run is in
`/tmp/inertia-pi-audit-portable.log`; a full check will follow sequentially.

Changed files in this audit: `pi-dialogs.ts`, `pi-rpc-harness.ts`,
`pi-native-conversation.ts`, their three corresponding test files (new
`tests/server/pi-dialogs.test.ts`), `docs/PI.md`, and this progress document.
Protected core files, dependencies, Git state and real provider accounts remain
untouched. The coordinating chat is still terminal with its model-capacity error;
the pending cross-chat messaging question has not received authorization.

Follow-up audit, 00:49 UTC: the Windows native allowlist now includes PowerShell,
which the existing managed bridge already wraps with a credential-free spawn
environment. A shipped-source fixture verifies Windows approval and environment
handling. Native tool activities now retain exact IDs privately and allocate a
fresh public ID per invocation, preserving later ID reuse and avoiding redaction
collisions. Unknown, duplicate and renamed completions fail closed. Reasoning
chunks are Unicode-safe and bounded, including final-only native reasoning.

The resulting **6 focused files / 43 tests pass**, including explicit oversized
protocol-frame and diagnostic-output cleanup regressions
(`/tmp/inertia-pi-completion-focused.log`); unit typecheck, focused lint and
`git diff --check` pass. The first audit portable gate completed with **212 files /
3677 tests passed, 3 files / 4 tests failed, 1 file / 9 skipped**. The same four
coordinator-owned restart/admission failures remain. That run began before the
last Windows/projection changes; `/tmp/inertia-pi-completion-portable.log` is the
fresh full portable gate for the final sources. A sequential full check follows.

Additional changed files: `src/server/provider/pi-launch.ts`, `pi-events.ts`,
`tests/server/pi-bridge.test.ts`, new `tests/server/pi-events.test.ts`, and
`provider-integration-seams.md`. The latter now contains a Pi requirement-by-
requirement audit and the exact unexercised platform/provider boundaries.

Audit file manifest (all paths relative to the repository root):

- `src/server/provider/pi-dialogs.ts`
- `src/server/provider/pi-events.ts`
- `src/server/provider/pi-launch.ts`
- `src/server/provider/pi-native-conversation.ts`
- `src/server/provider/pi-rpc-harness.ts`
- `tests/server/pi-bridge.test.ts`
- `tests/server/pi-dialogs.test.ts` (new)
- `tests/server/pi-events.test.ts` (new)
- `tests/server/pi-native-conversation.test.ts`
- `tests/server/pi-rpc-harness.test.ts`
- `docs/PI.md`
- `docs/orchestrator-v2/provider-implementation-progress.md`
- `docs/orchestrator-v2/provider-integration-seams.md`

The final portable run completed at 00:53 UTC: **213 files / 3687 tests passed,
3 files / 4 tests failed, 1 file / 9 tests skipped**
(`/tmp/inertia-pi-completion-portable.log`). This includes all 43 focused Pi cases.
Remaining failures are unchanged: the two missing-admission-seam fake stores and
Codex/Claude unclean-close native backing policy. The full gate is now running
sequentially in `/tmp/inertia-pi-completion-check.log`.

Final verification, 00:57 UTC:

- `npm run check` passed workflow concurrency, all 108 migration-lineage checks,
  architecture, color themes, standard/type-aware lint and all TypeScript
  configurations. Its test phase reported **1412 files / 17660 tests passed,
  15 files / 130 failed, 13 files / 149 skipped, 2 unhandled errors**. The failure
  files match the previous full check; both unhandled errors are the missing
  `store.orchestration.acceptedRequest` seam in compaction test doubles. All
  provider fixtures passed. The test failures prevented the bundled-build step.
- A separate `npm run build:bundle` compiled main, preload, renderer and Private
  Connect successfully, then **failed the renderer bundle budgets**. Main
  workbench first load is 953157 bytes versus 947062; detached chat first load is
  847140 versus 841026; core JavaScript is 2455150 versus 2448860. This is an
  additional shared V2 build finding, not a successful build gate. No budget was
  raised. Log: `/tmp/inertia-pi-completion-build.log`.
- `git diff --check` passes. Package/dependency files remain unchanged by this
  partner. Real accounts, live installed Pi, Windows/Linux execution and packaged
  Electron remain unexercised; Windows selection/bridge behavior uses fixtures.

The current provider-owned Pi audit is finished. The larger V2 request remains
incomplete: Cursor SDK and generic ACP need the coordinator-owned boundaries in
`provider-integration-seams.md`, and core tests/shared bundle budgets need
integration fixes. The coordinator's compact status remains `systemError`
(model capacity). The existing question about resuming that chat or transferring
ownership is still unanswered. No cross-chat message, dependency edit, protected
core edit, commit, push or merge was performed in this audit.

## Next coordinator seam: Cursor SDK dependency and harness identity

OpenCode 2 is now running its full gates. The next required package is the
actual Cursor TypeScript SDK, not another Cursor ACP wrapper. The audited T3
pin is `@cursor/sdk@1.0.38`, loaded from disk with `createRequire` because its
runtime contains lazy chunks; `@cursor/sdk/sqlite` supplies its native session
store. This dependency is not installed in the shared checkout. This partner
will continue read-only package-contract inspection and original adapter work;
the coordinator owns any dependency addition, lockfile/notices and packaging
review. Proposed explicit harness identity: **`cursor-sdk`**, retaining provider
`cursor`, native backend `builtin:cursor`, and protocol `cursor-managed`.
The coordinator must append this harness CHECK value in a new migration before
it can be offered as a durable selection. Existing `cursor-acp` identities and
sessions must remain available and must not be relabeled as SDK sessions.
The SDK's in-process local execution also needs an owned execution boundary;
implementation will not swallow SDK unhandled rejections or claim that merely
returning from cancellation proves all native child processes stopped.

The reviewed SDK exposes local `Agent.create/resume`, exact run IDs,
`Run.steer()` acknowledgement (`complete_delivered` or `revert_to_followup`),
`Run.cancel/wait/stream`, and a pluggable native session store. It does **not**
expose interactive native approval callbacks or native conversation fork/rollback
in this version; the pinned T3 adapter also reports those as unsupported. Native
fork must therefore remain unavailable rather than editing opaque checkpoint
blobs. A local usage UUID is distinct from the client-side `run-<uuid>` label.

Login can use `Cursor.auth.login({ store: null, openBrowser: false, onLoginUrl,
signal })`; the returned expiring API key must be saved only through the existing
privileged vault and supplied explicitly to SDK calls. It must never reach the
SDK's default `~/.cursor/sdk/auth.json` file. The packaged app disables Electron's
`runAsNode` fuse, so spawning `process.execPath` as Node is not a valid packaged
worker design. The coordinator must provide an owned utility-process broker or
another verified executable boundary before this adapter can be registered.

## OpenCode 2 package — active implementation

Update, 2026-10-30 00:00 UTC: production routing is now version-selective under
the existing `opencode` / `opencode-sdk` identity. V1 retains the installed SDK
path; verified V2 uses the original bounded HTTP/SSE implementation. The new
run adapter subscribes before prompt admission, correlates every native input,
requires native execution settlement plus the exact persisted idle/history
head, installs a credential-free per-session shell environment, supports
steering, native approval/forms, compaction, model variants/images, and attaches
ephemeral host MCP tools under the exact app turn. Host credentials are never
written to native configuration or Inertia persistence. Process cancellation
first clears only owned inbox IDs, then interrupts and joins the complete owned
server tree. A busy session rejected at preflight is never interrupted.

Discovery now extends the cached semantic isolation proof for V2: an isolated,
credential-free positive control must execute both project and global plugin
sentinels; the production project-disable/policy configuration must suppress
both. V2 avoids the passive `auth list` command because it may start a shared
background service; explicit sign-in uses `--standalone auth login`. Metadata
reads use the correlated installation version. Native fork/revert receives the
version through `NativeConversationLaunch` and rejects V1. Maintenance recognizes
`@opencode/cli@2`, preserving major-2 pins for npm/native/Homebrew updates rather
than accidentally selecting the legacy `opencode-ai@1` graph. No dependencies
were added or installed in the repository.

Focused checkpoint: 79 tests across V2 turn/discovery and the existing V1 harness
pass (`/tmp/inertia-opencode2-host.log`); 105 plumbing tests passed before the
new capability test exposed an invalid observed-capability list. That list is
fixed and the five projection tests now pass. Node/unit typechecks and the
architecture gate (1793 source files) pass. Full portable/check gates are next.

Full-gate update: `/tmp/inertia-opencode2-check.log` completed quality gates
(migrations, architecture, standard/type-aware lint, all typechecks) then the
test phase ended at **1404 files / 17623 tests passed, 21 files / 137 tests
failed, 13 files / 149 skipped**. Build was not reached. Several failures were
stale six-provider expectations after Pi; this partner has corrected those in
accounts/settings, runtime core/status, refresh, argument-error and update-timeout
tests and is rerunning them. Coordinator-owned remaining groups include
`compact-and-send-command` (9), `conversation-context-v3` (5),
`database-recovery-schema-columns` (87), `session-continuity` (9),
`turn-provider-event-projector` (9), migration/current-schema assertions,
`duo-inactive-recovery`, and the same four portable restart/reset admission
failures previously reported. `locale-collation` points at
`orchestration-v2/portable-history-source.ts:61`; `source-usage` now sees
`orchestration-v2/command-lanes.ts` as test-only. `agent-surface-budget` needs the
coordinator's deliberate fork-history baseline (+5 bytes also comes from Pi in
the create-conversation provider enum). Renderer streaming-layer expectations
also differ. This partner has not changed those core/renderer semantics.

The final portable run completed at 00:11 UTC: **211 files / 3662 tests passed,
3 files / 4 tests failed, 1 file / 9 tests skipped**
(`/tmp/inertia-opencode2-portable-final.log`). All provider adapter fixtures
passed. Remaining failures are two restart/reset active-turn admission checks
(their fake stores lack the new `orchestration.acceptedRequest` seam; the
production busy guard remains present), and Codex/Claude unclean-close restart policy retaining
a native session where the tests expect a detached continuation. An earlier
grouped OpenCode fixture exceeded the suite's per-test deadline; its six
independent failure scenarios now have separate tests. The Pi expectation fixes
and OpenCode cases pass together: **7 files / 111 tests**
(`/tmp/inertia-provider-gate-fixes.log`).

Coordination update, 00:13 UTC: the coordinating chat is stopped with a system
error and its newest turn is failed. Provider work in this chat remains active.
The user has been asked whether to resume that chat or transfer the remaining
V2 work here; no cross-chat message has been sent without that authorization.
The compact status snapshot identifies the error as: "Selected model is at
capacity. Please try a different model."

Post-gate review, 00:18 UTC: tool activities now bind native call IDs to their
assistant-message ID and expose only a hashed tuple. This permits native ID reuse
across messages and prevents arbitrary IDs from leaking credentials. Duplicate or
foreign durable tool completions fail closed; malformed native tool input may
fail before execution. Final reasoning blocks use the same bounded, Unicode-safe
chunks as answer text. Metadata probes now check the exact attested installation
version, as turns/native controls already did. **46 focused tests pass** across
projection, production harness and provider metadata
(`/tmp/inertia-opencode2-review-final.log`); standard lint and unit typecheck pass.

The reviewed portable gate completed with **211 files / 3666 tests passed,
3 files / 4 tests failed, 1 file / 9 skipped**
(`/tmp/inertia-opencode2-reviewed-portable.log`). The concurrent full check
passed quality gates but had **1409 files / 17638 tests passed, 16 files / 131
failed, 13 files / 149 skipped, 2 unhandled errors**. One provider fixture timed
out during cleanup. Review found that the harness awaited stream shutdown before
terminating its owned server. Stream cancellation now starts concurrently with
server termination so a reader waiting for the peer cannot prevent that stop.
A regression fixture demonstrates this dependency and confirms the port closes;
**23 focused tests pass** with unit typecheck and lint. No test deadline was
increased. The subsequent sequential check passed all provider fixtures and had
**1410 files / 17639 tests passed, 15 files / 130 failed, 13 files / 149 skipped,
2 unhandled errors** (`/tmp/inertia-opencode2-sequential-check.log`). Those two
errors are the same missing `orchestration.acceptedRequest` fake-store seam in
the compaction tests. The final full check including the new cleanup-order
fixture completed at 00:31 UTC: **1410 files / 17640 tests passed, 15 files / 130
failed, 13 files / 149 skipped, 2 unhandled errors**
(`/tmp/inertia-opencode2-final-check.log`). All provider fixtures pass. Workflow,
migration-lineage, architecture, color-theme, standard/type-aware lint and all
TypeScript checks pass. The remaining failures/errors are the coordinator-owned
groups listed above; the build phase was not reached. `git diff --check` passes.

Files changed in this review checkpoint:

- `src/server/provider/opencode2-events.ts`: bounded reasoning chunks and exact,
  opaque tool activity identity.
- `src/server/provider/opencode2-harness.ts`: stream/server shutdown ordering.
- `src/server/provider/opencode2-metadata.ts` and `metadata.ts`: attested version
  validation during model discovery.
- `tests/server/opencode2-projection.test.ts` and `opencode2-harness.test.ts`:
  identity, redaction, Unicode, version drift and cleanup regressions.
- This progress file and `provider-integration-seams.md`: verified checkpoint,
  core failure diagnosis, and outstanding Cursor/ACP integration boundaries.

Repository dependency files and generated notices remain unchanged. Tests use
local fixtures on macOS arm64; real provider accounts, real OpenCode 2 execution,
Windows/Linux execution, packaged Electron wiring and the new Cursor SDK remain
unexercised. No commit, push or merge was performed by this partner.

Read-only core failure diagnosis for the coordinator: the recovery-column test
helper `labelSchema` relabels a current database as pre-107 without removing its
four `orchestration_v2_*` tables. Upgrade then attempts to create those existing
tables at migration 107. Fix the historical fixture construction, not the frozen
migration. For unclean restart, `observeSession` can record a backing as `ready`
before a settled native boundary; `turn-request-preparation` then prioritizes that
backing's identity over the older `providerSessionAfter` ownership check. Reconcile
that lifecycle with the documented no-resume policy for an unfinished first turn.
These coordinator-owned files have not been edited by this partner.

Remaining Cursor/ACP ownership and package details are consolidated in
[`provider-integration-seams.md`](./provider-integration-seams.md).

Honest limits still requiring follow-up: V2 has no native plan updates. Native
`subagent`/legacy `task` remain denied because upstream child sessions do not
inherit the parent's in-memory sanitized shell environment; the capability
attestation excludes native child tools until a safe native hook is proved.
Managed Inertia child tools remain available through MCP. Conditional/external
native forms are cancelled because the current UI cannot represent them safely.
Explicit native skill-selection and custom compaction instructions fail closed.
The plugin proof covers project/global config in a disposable native home; this
is not an OS sandbox or a promise to override trusted system/organization policy.
No real OpenCode account, native database, provider model call or package-manager
update was exercised. Cursor SDK and generic ACP registry/auth remain required
after this checkpoint; this partner's goal stays active.

Official OpenCode 2.0.28 protocol/schema/server/core packages and the matching
upstream CLI source are cached under the ignored research directory for read-only
inspection; nothing was installed or executed. Nine original `opencode2-*.ts`
modules implement bounded authenticated loopback JSON/SSE, owned-server cleanup,
run/event and interaction handling, metadata, history pagination, and native
fork/revert. Production routing and focused/full portable coverage are in place.
Fork tests use the actual V2 rule that copied
messages get NEW native IDs: the result returns the mapped target head, verifies
copied message contents, and distinguishes the relocation's physical head.
Rollback always sends `files:false`; a failed staged mutation returns uncertainty
and leaves durable reconciliation to core rather than pretending it was reverted.
Source history, active/pending work, changed heads, pagination loops, native/newer
compaction payloads, malformed framing, response limits and owned process cleanup
have deterministic fixtures. Real OpenCode 2, provider accounts and native plugin
loading have not been exercised.

OpenCode 2's CLI does not expose V1's `--pure` mode. Its separate owned config view
uses `OPENCODE_CONFIG_PROJECT_DISABLE=1`, a private config directory, and the V2
policy that checks external plugins before importing them. Discovery must prove
this behavior using an isolated plugin sentinel before enabling native authority;
the V1 proof remains unchanged. Native credentials/history remain provider-owned.

## Pi package — implemented checkpoint and proposed core seams

The coordinator assigned first-class Pi 1.0 integration after receiving the
Codex/Claude package. A new persistent package goal is active. No additional
agents, real accounts, app databases, Git mutations, dependencies or package-file
changes are involved. The adapter will speak the installed executable's JSONL
RPC directly, using Inertia's owned-process machinery and existing HTTP host-tool
bridge; no new runtime dependency is currently needed.

Evidence is pinned T3 `dd148481531a0a090780a2ade20588566db099a2`'s provider-pi
package and upstream `earendil-works/pi` tag `v1.0.2`, plus the official Pi 1.0
RPC documentation. Upstream reference files are cached under the ignored
`.cache/orchestrator-v2/pi-v1.0.2` tree.

Planned production identities: provider `pi`, harness `pi-rpc`, native managed
backend `builtin:pi` / `pi-native`. This partner owns provider union/routing,
catalog/discovery/capability/registry changes and provider settings needed to
select the installed executable, validated argument array and non-secret Pi
configuration. Existing Pi installation/authentication remains provider-owned;
secret environment values stay in the privileged launch environment.

Core integration seam: the existing `AgentHarness` run, interaction, metadata,
steering and host-tool contracts will carry Pi behavior. `agent_settled`, not
`agent_end`, is the completion boundary. The adapter will distinguish accepted,
queued and extension-handled prompts and will clear native queued work before
abort. Native fork/rollback will use the existing `nativeConversation` control
surface, preserving the exact session file reference and session UUID separately;
Pi rollback may return a newly created native backing. The core must atomically
adopt that backing rather than assuming in-place truncation. Boundary selection
must account for Pi's fork operation excluding the selected user-message entry.

Pending core seams, to refine during implementation: persisting a session-file
reference alongside a native session UUID; durable native entry/cursor capture;
project trust and opt-in native extension policy; extension-owned out-of-turn
work and typed UI requests beyond the existing approval/input/activity surface.
No protected core/schema/migration/index file will be changed silently. Adapter
capability declarations will report unsupported gaps rather than emulate native
support. User-supplied extensions run inside Pi and cannot be treated as an OS
sandbox; Inertia's managed bridge will enforce its own tools/approval authority.

The completed Codex/Claude package is documented below.

Pi seam refinement: use Pi's native `--session-dir` to isolate Inertia-created
transcripts under `<PI_CODING_AGENT_DIR>/inertia-sessions` (default
`~/.pi/agent/inertia-sessions`). Persist native UUIDs through the existing session
contract; resolve the exact session file only inside that bounded, canonical
directory, validating its header UUID and workspace before resume. This removes
the need to expose paths in the shared session identity. Native cross-workspace
forks will require the source workspace's canonical path separately from the
destination launch cwd. The source file is always preserved.

**Coordinator migration seam:** append Pi to the database provider/harness/backend
CHECK constraints (provider `pi`, harness `pi-rpc`, backend protocol `pi-native`)
in a new migration. No historical migrations are changed by this partner. Merely
adding the TypeScript provider union cannot admit Pi rows under the old checks.
Migration 108 exact values: providerId `pi`, harnessId `pi-rpc`, backend profile
`builtin:pi`, protocol `pi-native`; no new persisted authentication-method value
or configuration column is required. Native authentication remains unknown until
Pi accepts a request. Executable/arguments come from privileged `INERTIA_PI_EXECUTABLE`
and `INERTIA_PI_ARGS`; the latter is a validated JSON string array. No secret,
session-file path, or environment value is persisted by this adapter.
Native control seam: add optional `NativeConversationLaunch.sourceCwd` for an
authorized canonical source workspace when a fork targets another workspace.
Pi rollback capability is `native-fork`: Pi preserves the source and returns a
replacement native backing. Empty-history rollback uses the existing
`new-session` continuation recipe. Core must supply entry IDs from Pi's active
`get_entries` branch, never infer them from application turn IDs or timestamps.
Coordinator migration 108 is now committed; the earlier ES2022 core error is fixed.

The requested `ProviderNativeBoundaryEvent` now exists in `provider/contracts.ts`
and the harness/event bridge. Exact fields are `type: native-boundary`,
`nativeConversationId`, nullable `nativeSessionId`, `nativeTurnId`,
`persistedHeadId`, and `phase: started | settled`, plus exact app run/turn IDs.
Codex emits from its already correlated native lifecycle notifications (unknown
tree root stays null). Claude resolves settled cursors through its bounded,
scoped persisted transcript after owned process cleanup; wire UUIDs alone are
not promoted. Pi reads the active `get_entries` branch after `agent_settled`.
Unproved anchors remain null. Coordinator owns durable event projection.

Pi implementation currently includes production registry/manifest/model routing,
RPC model/thinking/context metadata, dialog and approval responses, managed
host-tool extension, native shell credential isolation, bounded session lookup,
fork/replacement rollback/new-session continuation, native skill discovery and
selection, and isolated credential-free protocol discovery. Seven initial Pi
fixtures pass; expanded native-control/bridge/discovery tests and portable/full
provider regressions remain in progress. No live Pi account was exercised.

`ProviderManager.nativeConversation(request, exactModelSelection, { cwd,
sourceCwd?, signal?, timeoutMs? })` is implemented via
`provider/native-conversation-service.ts`. It resolves the exact model/backend
route, checks the conversation provider gate and idle state, uses canonical
authorized workspace paths, materializes the private launch configuration,
copies its environment before secret release, and transfers installation-use
authority to the registered native adapter. The service validates
`request.source.identity.providerInstanceId` against the core `providerInstanceId`
helper before work and again after private launch setup, re-resolving the exact
model route. It rechecks both source and target active-run state after that await.
Caller still owns the durable conversation/workspace mutation lock. Four service
tests pass, including stale revisions, foreign instances, active targets after
setup, private launch copying, and cancellation.

Expanded focused tests: Pi run/transport 10, Pi native history 6, shipped managed
extension 3, native service 3, and Claude native operations/boundary 23 pass.
Initial full portable run: 200 files / 3,610 tests passed; 5 files / 8 failed;
one file / nine tests skipped. Four failures are provider registration/test-fixture
expectations being updated for Pi. Four coordinator-owned failures remain in
`limit-reset-turn-dispatch`, `restart-continuation-runtime`, and
`turn-restart-continuation` (two unclean-close cases). Logs:
`/tmp/inertia-pi-portable.log`. Latest concurrent typechecks encountered core
`portable-fork-history.ts` ES2022 `findLast` and new fork command policy entries
missing from `runtimeCommandPolicy.ts`; provider checks were clean beforehand.
Those concurrent type errors are now fixed. Latest Node + unit-test typechecks
and the full standard/type-aware lint pass. `npm run check` was attempted twice;
it passed workflow-concurrency and all 108 migration lineage checks, then stopped
at the concurrently edited `shared/contracts/server-event-schema.ts` ceiling
(first 1257, then 1251 lines). Provider registry/interaction/steering conformance
expectations are updated; a final focused/portable rerun is still pending.
The skill validators now live in `shared/contracts/agent-skill-schema.ts`, removing
the shared event schema's line-ceiling blocker without weakening checks. Pi source
is frozen for the current full gate and portable run. The immediately preceding
portable run loaded the Pi module before a new mismatch test was added and thus
reported that test against the older transform; the latest isolated five-file
Pi/native-service suite passes all 27 tests, including the native tree mismatch
and changed-clone ambiguity cases. A 12-file provider regression passed 202 tests
before that one additional case was added. Current logs are
`/tmp/inertia-pi-check-final.log` and `/tmp/inertia-pi-portable-frozen.log`.

Stable-source verification completed: the portable gate passed 205 files / 3,625
tests, with nine skips and only the four coordinator-owned recovery failures
listed above (three files). All Pi and native-service tests passed in this run.
The full `npm run check` passed workflow concurrency, 108 migration lineage
entries, architecture (1,782 source files), color themes, and both lint stages;
it stopped at `orchestration-v2/native-control-repository.ts:61`, where a
`NativeConversationIdentity` was passed directly to a `JsonValue` parameter.
This newly added coordinator-owned core file remains untouched here.

The coordinator has assigned the remaining provider parity work: official
Cursor SDK, OpenCode 2, and ACP registry/discovery/authentication. This is a Pi
checkpoint, not a V2 handoff; the persistent goal stays active while that work
continues. Existing owned-process, credential, identity and protocol limits
remain requirements for each provider integration.

Next package investigation: OpenCode 2 is a distinct `/api` protocol using
`@opencode/client` (audited T3 pin 2.0.28), not `@opencode-ai/sdk/v2` (the latter
still serves OpenCode 1). A separate bounded HTTP adapter can avoid new runtime
dependencies and dispatch on the positively probed installation major version.
Cursor's official SDK requires `@cursor/sdk` (audited T3 pin 1.0.38); it runs an
agent loop in the Node process, so Inertia needs an owned utility process around
it to preserve process-tree cleanup and credential boundaries. No SDK dependency
has been installed or added here; dependency/packaging ownership remains with
the coordinator. ACP registry work will require a distinct current provider and
harness identity rather than relabelling Kimi or Cursor ACP. Exact migration
values will be recorded before those routes are enabled.

Pi package file inventory (shared files may also contain coordinator edits):

- New provider modules: `pi-rpc.ts`, `pi-rpc-harness.ts`, `pi-launch.ts`,
  `pi-session.ts`, `pi-native-conversation.ts`, `pi-models.ts`, `pi-discovery.ts`,
  `pi-skills.ts`, `pi-resources.ts`, `pi-bridge-source.ts`, `pi-dialogs.ts`,
  `pi-events.ts`, and `native-conversation-service.ts` under `src/server/provider`.
- Provider plumbing: `adapters.ts`, `agent-harness.ts`,
  `agent-harness-registry.ts`, `auth.ts`, `capability-manifest.ts`, `catalog.ts`,
  `contracts.ts`, `discovery.ts`, `installation-lease.ts`,
  `maintenance-capabilities.ts`, `maintenance-install-source.ts`, `metadata.ts`,
  `provider-image-read.ts`, `run-coordinator.ts`, `terminal-resume.ts`,
  `watcher-harness-profile.ts`, plus `providers.ts`, `environment.ts`,
  `runtime-snapshots.ts`, `usage-dashboard.ts`, and `review-summary.ts`.
- Native-boundary extensions: `codex/app-server-events.ts`, `codex/types.ts`,
  `provider/codex-app-server-harness.ts`, `provider/claude-agent-sdk-harness.ts`,
  `provider/claude-native-conversation.ts`, and `provider/native-conversation-operations.ts`.
- Skills integration: `runtime/agent-workflow-controller.ts`,
  `runtime/conversation-provider-contact.ts`, `shared/contracts/agent-workflows.ts`,
  and new `shared/contracts/agent-skill-schema.ts`. Only provider enum additions
  were made to coordinator-owned `runtime/agent-thread-manager.ts`.
- Current shared provider contracts/routing: `provider.ts`, `model-routing.ts`,
  `application-diagnostics.ts`, `backend-profile-settings.ts`,
  `context-compaction.ts`, `desktop.ts`, `issue-report.ts`,
  `provider-identities.ts`, `provider-maintenance.ts`,
  `provider-terminal-resume.ts`, `watcher.ts`, and provider enum validation in
  `contracts/client-command/common.ts`, `contracts/daily-work-schema.ts`,
  `contracts/runtime-evidence-schema.ts`, `contracts/server-event-schema.ts`,
  `contracts/subagent-trace-schema.ts`, `contracts/usage-dashboard-schema.ts`,
  and `server/persistence/database-export.ts`. Released migration helpers remain unchanged.
- Renderer provider labels/settings: `ProviderAuthDialog.tsx`,
  `ModelBackendsSettings.tsx`, `composer/config.tsx`, and utils `agentInput.ts`,
  `backendSettingsModel.ts`, `composerReadiness.ts`, `failureDiagnostics.ts`,
  `modelChooserRoutes.ts`, `modelSearch.ts`, `modelSourceRail.ts`,
  `providerIcons.ts`, `providerStatus.ts`, `selectedModelChip.ts`,
  `subagentDisclosure.ts`; new `assets/provider-icons/pi.svg`.
- New tests: `pi-rpc-harness.test.ts`, `pi-native-conversation.test.ts`,
  `pi-bridge.test.ts`, `pi-discovery.test.ts`, `native-conversation-service.test.ts`.
  Updated native Claude, provider conformance/manifest/terminal-resume,
  watcher-contract tests, cleanup/lifecycle helper type exclusions, and renderer
  provider fixture mapping. `scripts/check-node-runtime-compatibility.mjs`,
  `README.md`, and new `docs/PI.md` include Pi.

Unexercised here: real Pi authentication/model calls, real native extension
loading in an installed Pi 1.x binary, packaged Electron, and Windows/Linux
execution. The portable fixtures exercise shell-free protocol, exact identities,
owned cleanup, fork containment, managed extension source, host HTTP RPC, dialogs,
model/thinking metadata, skills, and secret-free discovery on macOS. No dependencies,
app database, native account files, commits, pushes, or merges were changed by this partner.

Codex/Claude prior-package status: implemented and focused verification complete. No application
database, accounts, Git state, or coordinator-owned core files changed here.

## Integration API (implemented)

`AgentHarness.nativeConversation?: NativeConversationOperations` is a separate
control surface. `execute(request, launch)` accepts `fork` or `rollback`, exact
application identity (project/conversation/workspace/repository/provider instance),
native conversation ID, expected native head, and a stable inclusive native
boundary (`turn` or `start`, with an optional inherited fork head). Fork requests
also carry the target application conversation ID. No ordinary agent turn or
prompt is created for these operations.

The caller owns the durable per-conversation mutation lock, authoritative
workspace/installation/account resolution, and the idle-run admission check.
Launch carries the already sanitized environment, executable, cwd, abort signal,
bounded timeout, resolved harness configuration and optional installation-use
transfer. Provider code validates
native identity, head and boundary before mutation. The harness also refuses
operations against its locally active session.

Results preserve the source request identity and target application conversation
ID on forks. `completed` contains the resulting native conversation ID, separate
session-tree ID when supplied by Codex, effective `headId`, physical
`persistedHeadId`,
and effect (`native-fork`, `native-revert`, `resume-cursor`, `new-session`, or
`unchanged`). `unsupported` and `rejected` do not mutate. `failed` distinguishes
whether mutation may have happened and preserves any known created native ID;
an ambiguous effect must be reconciled, never blindly replayed.
`cleanup-unconfirmed` also requires retaining source/installation exclusion until
the owned process tree is confirmed stopped, even when no history mutation was
sent. Production callers should transfer the resolved installation-use lease to
Codex control; its existing owner quarantines that lease on uncertain cleanup.

Codex uses `thread/fork.lastTurnId` (inclusive), paginated history validation and
`thread/revert.beforeTurnId` (exclusive retained boundary). This integration
requires paginated history for both operations; legacy/unknown history returns
`unsupported`. It never sends obsolete `thread/rollback`. Custom Responses
configuration preserves credential environment exclusions.
Claude uses the installed SDK's `forkSession` with a bounded, scoped transcript
store; UUID remapping is performed by the SDK. It returns the **fork's** head UUID.
Claude rollback returns a continuation recipe, not a filesystem rewind.

`AgentHarnessStartOptions.nativeContinuation` carries a Claude `resume-cursor`
(exact native conversation ID plus `resumeSessionAt`) or `new-session` recipe.
The core must persist it with the native backing and pass it only to the matching
session on a normal turn. A fresh session at thread start must be persisted before
admission. Retain a rollback cursor through failures before native admission;
ambiguous execution requires reconciliation under the durable delivery policy,
not unconditional cursor clearing at queue admission. No shared/public contracts
are changed here.

`source.expectedHeadId` always means the physical persisted native head. For a
Claude `resume-cursor` result, `backing.headId` is the desired effective cursor
while `backing.persistedHeadId` remains the observed source head. Persist both;
do not use the desired cursor as the physical optimistic-concurrency guard for
another control operation before the next native run. Core authorization must
restrict selected boundaries to the application's current retained history.

The coordinator still owns durable command/effect dispatch, provider-manager
route and installation resolution, storing the returned backing/cursor, passing
`nativeContinuation` into run launches, and user-facing capability/fallback
projection. This package is wired into the actual provider harnesses, not yet
the coordinator's new runtime command dispatcher.

## Files and verification

Changed existing provider files:

- `src/server/provider/agent-harness.ts`
- `src/server/provider/codex-app-server-harness.ts`
- `src/server/provider/claude-agent-sdk-harness.ts`

Added provider modules:

- `src/server/provider/native-conversation-operations.ts`: typed control surface.
- `src/server/provider/native-conversation-control.ts`: bounded cancellation,
  exact source lock, cleanup/ambiguous outcome classification.
- `src/server/provider/native-conversation-run-tracking.ts`: live native-session
  exclusion for both harnesses.
- `src/server/provider/codex-native-conversation.ts`: native RPC operations.
- `src/server/provider/claude-native-conversation.ts`: scoped SDK transcript store,
  real SDK fork, deferred rollback and launch option validation.

Added portable tests: `tests/server/native-conversation-operations.test.ts` and
`tests/server/claude-native-conversation.test.ts` (43 passing tests), plus
`tests/server/native-conversation-run-tracking.test.ts` (5 cleanup-exclusion
cases passing from final review), for 48 new tests total. They cover
success, exact/inherited boundaries, physical versus effective heads, remapped
Claude IDs, custom Codex routing, malformed/oversized/foreign/changing transcripts,
symlinks, stale identity/head, pagination, cancellation, deadlines, retained locks,
cleanup ambiguity and real-harness continuation wiring.

Node 22.23.2 was used. Server and unit-test TypeScript checks and focused standard
and type-aware lint pass on the final package. The eight-file provider regression
run passes **78 tests**: all three added files plus `claude-agent-sdk-start`,
`claude-agent-sdk-truthfulness`, `claude-agent-sdk-cleanup-outcome`,
`codex-control-client`, and `codex-compaction-capability`. Native-session exclusion
persists through unconfirmed cleanup and is released only by affirmative late
cleanup proof; separate overlapping runs cannot prematurely release each other.

The first full portable run had 7 failed files / 10 failures, 190 passed files /
3556 passed tests, 1 skipped file / 9 skipped tests. Two assertion failures were a
mixed source/test snapshot while the new result fields were being added; final
focused tests pass. The remaining eight failures were coordinator-owned schema
107 duplicate-table upgrades and busy-connection reconciliation. A final portable
run has finished at `/tmp/inertia-native-operations-portable-final.log`: **6
failed files / 6 failed tests; 191 passed files / 3562 passed tests; 1 skipped
file / 9 skipped tests**. The provider package has no failures in that run. Its
final cleanup-exclusion refinement is additionally covered by the focused run.

Coordinator's 22:08 UTC migration/recovery fixes were checked separately after
that long-running portable run had already loaded the earlier core. All **118
tests across five prior failing core files now pass**: `limit-reset`,
`restart-continuation-plans`, `turn-restart-continuation`,
`turn-runtime-interruption-note`, and `turn-settlement-post-commit`. Output:
`/tmp/inertia-native-operations-core-recheck.log`. The still-running portable
run had four additional cleanup-related failures. Exact remaining names for the
coordinator (no core files edited here):

- `queued-message-runtime.test.ts` → `durable runtime message queue` →
  `waits for the provider stop, then starts queued work once unconfirmed cleanup releases the chat`.
  **Reproduced on the current core**: expected provider run count 2, actual 1,
  line 391. Standalone rerun: 55 pass, 1 fail; log
  `/tmp/inertia-native-operations-queue-recheck.log`.
- `turn-controller-cancellation-persistence.test.ts` →
  `finalizes the turn and releases attachments but keeps durable ownership after failed writes and force-detached cleanup`.
- `turn-controller-result-persistence.test.ts` →
  `finalizes the failed result but keeps its ownership row when cleanup is missing`.
- `turn-stop-settlement.test.ts` →
  `finalizes a stopped turn with a note and keeps the ownership row when the provider is force-detached`.

The two migration failures in the full-run summary were loaded before the
coordinator's fix and pass in the later 118-test core rerun.

Architecture check: **passes** on the final shared working tree (1745 source
files, 7164 internal edges, 4 derived compatibility facades). The provider import
cycle found during development was removed; the coordinator has also resolved
the temporary core line-ceiling failures. `git diff --check` passes for the
modified existing harness files. The coordinator owns the final complete
`npm run check` gate after integration; this partner has not run or claimed that
full gate.

## Evidence / limits

Semantics: pinned T3 `dd148481531a0a090780a2ade20588566db099a2`, installed
Claude SDK 0.3.309, official Codex App Server thread documentation. Implementation
is original integration code; no T3 source copied. No real-account probes.

Explicit limits: no provider can atomically guard against a different external
CLI changing the same native session after our read; the caller must exclude
other Inertia runs and must treat unexpected native effects as ambiguous. Codex
history is capped at 10,000 turns. Claude transcripts are capped at 16 MiB and
20,000 entries and require a bounded regular file in the exact configured
project scope. Empty native fork boundaries return unsupported. Claude forks
do not promise copied file-history undo snapshots and rollback never rewinds
workspace files. Filesystem syscalls cannot be preempted portably; cancellation
retains the source lock until actual settlement and prevents late transcript
writes, or reports possible mutation with a known fork ID once creation began.
Uncertain created artifacts are retained for reconciliation, never blindly
deleted. Real-account behavior, Windows filesystem enforcement and Linux/macOS
packaged wiring were not exercised by this package.
