# Claude and OpenCode stabilization review

Reviewed on 2026-09-07 against base `c9740a51`, on the integrated stabilization
branch. This is a bounded contract/lifecycle review, not a claim that authenticated
model turns were exercised on every operating system.

## Dependency and upstream contract evidence

| Surface | Base → reviewed product install | Evidence and compatibility boundary |
| --- | --- | --- |
| Claude Agent SDK | `0.3.259` → `0.3.260` | Exact lock and capability-manifest version agree. The [official 0.3.260 release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.260) describes additive event metadata, managed-settings restrictions, and error-reporting changes; it does not establish compatibility with every independently installed CLI. |
| Anthropic SDK | `0.123.0` unchanged | Backend/model metadata integration remains separately tested; this is not the Claude CLI process transport. |
| OpenCode SDK | `1.18.27` unchanged | The adapter imports `/v2`; pinned generated request/response types and actual installed-client HTTP/SSE fixtures establish the precise v2 prompt/steer/compact contract. |

The official [Claude TypeScript SDK documentation](https://code.claude.com/docs/en/agent-sdk/typescript)
defines asynchronous prompt input, permission callbacks, custom process spawning,
and query controls. The [session documentation](https://code.claude.com/docs/en/agent-sdk/sessions)
describes native resume/continue/fork behavior. The product uses a persistent async
prompt channel and exact session correlation; it does not treat any successful
message from another session as completion proof.

The official [OpenCode SDK documentation](https://opencode.ai/docs/sdk/) describes
the generated client and directory-scoped operations. Its introductory examples
are not an exhaustive specification of the installed `/v2` namespace. The
[server documentation](https://opencode.ai/docs/server/) documents local HTTP,
OpenAPI, health, and Basic authentication. Source review therefore checked the
installed generated v2 signatures as well as those public pages.

The separate secret-free latest canary observed Claude Agent SDK `0.3.263`,
Anthropic SDK `0.124.0`, Claude CLI `2.1.263`, and OpenCode SDK/CLI `1.18.29`.
Latest SDK type compilation/runtime-surface construction and Claude version/auth
help passed. These observations do **not** silently upgrade the reviewed lock or
prove an authenticated latest-Claude turn.

## Lifecycle and feature evidence

All test filenames below are under `tests/server/` unless stated otherwise.

| Area | Claude | OpenCode |
| --- | --- | --- |
| Discovery/auth/capabilities | `provider/discovery.ts` parses bounded `auth status --json`; `providers.test.ts` covers explicit logged-in/logged-out fixtures. Native Fast mode requires exact-session init attestation. `claude-fast-mode.test.ts`, `provider-capability-manifest.test.ts`. | Requires `serve --pure` and semantic isolation proof tied to executable identity, not merely a version string. `opencode-pure-isolation.test.ts`. `auth list` indicates configured credentials, not proven authentication. Empty/unknown output cannot establish readiness. |
| Attachments | Native text/base64 image blocks; bounded prompt reservations and aggregate media size. `claude-follow-up-media.test.ts` covers asynchronous media preparation, Stop races, delivery/correlation, and release of reservations. | Initial text/file parts and exact v2 follow-up file receipts. `opencode-sdk-harness.test.ts` covers aggregate/individual limits, unsupported media, and image-bearing requests; `opencode-boundary.test.ts` covers privileged transport boundaries. |
| Initial completion/next admission | Root session and input UUID correlation; a result is provisional while verified descendants or accepted follow-ups remain outstanding. `claude-agent-sdk-lifecycle.test.ts`, `claude-agent-sdk-truthfulness.test.ts`, `claude-delegated-resume.test.ts`. | Prompt admission is not work completion. Root idle requires observed work and settled descendants; parent continuation is distinct from child output. `opencode-sdk-harness.test.ts`, `opencode-descendant-completion.test.ts`. |
| Follow-ups and permission races | Bounded persistent input channel, singular/plural result UUID correlation, late permission responses, queued media cancellation. `claude-follow-up-media.test.ts`, `claude-agent-sdk-lifecycle.test.ts`; the new actual installed-SDK stream regression is described below. | Exact v2 session/prompt/receipt identity, accepted-but-unstarted work, early approvals, pending admission cancellation, bounded outstanding requests. `opencode-sdk-harness.test.ts`, `opencode-interactions.test.ts`, `opencode-descendant-interactions.test.ts`. |
| Cancel/late events | Stop rejects further input, drops queued prompts, settles permission waits, consumes interrupt receipts, and forces shutdown when queued SDK input could otherwise survive. Foreign/late root and subagent messages are scoped separately. `claude-agent-sdk-lifecycle.test.ts`, `claude-subagent-trace.test.ts`. | Cancellation joins pending HTTP admission and interrupts the correct protocol surface; exact-session and parent-linked descendant validation reject foreign events. `opencode-sdk-harness.test.ts`, `opencode-session-ownership.test.ts`, `opencode-event-projection.test.ts`. |
| Resume/compact | Explicit native resume session. `/compact` requires successful native compact evidence for that exact session; ordinary results, contradictory proof, and foreign Fast/compact evidence are insufficient. `provider-compaction.test.ts`, `claude-delegated-resume.test.ts`. | Selected-session validation and native v2 compaction start/end correlation; stale activity, acknowledgement-only responses, and wrong-session events cannot establish success. `opencode-sdk-harness.test.ts`. |
| Descendants/process settlement | One owned SDK process, shell-free spawn, SDK kill routed through whole-tree termination; unconfirmed process/host-tool cleanup makes the result fail closed. `claude-agent-sdk-harness.test.ts`, `claude-agent-sdk-lifecycle.test.ts`, `claude-delegate-lifecycle.test.ts`, `claude-host-tools.test.ts`. | Isolated owned local server with bounded startup/requests and memoized whole-tree termination; live descendants retain the turn and cleanup failures remain explicit. `opencode-descendant-completion.test.ts`, `opencode-session-ownership.test.ts`, `opencode-sdk-harness.test.ts`. |

The shared runtime's real-SQLite terminal-settlement regressions own durable
terminal/projection consistency, mandatory cleanup, and next-turn admission.
Adapter fixtures alone do not prove the complete desktop first-send → Stop →
runtime restart → second-send journey for these two providers.

## Confirmed defect and added coverage

No Claude/OpenCode adapter protocol defect was confirmed in this review. Two concrete
coverage findings were handled without changing either provider protocol:

1. The latest OpenCode canary copied its runtime entrypoint and process helper but
   omitted the latter's `linux-process-group.mjs` dependency. The new staged
   execution regression failed before the fix with `ERR_MODULE_NOT_FOUND`, before
   any OpenCode handshake. `scripts/provider-drift-staging.mjs` now owns the small
   explicit local module closure used by the production canary and test. The test
   executes that copied entrypoint outside the checkout, proves the plugin-positive
   control, rejects a `--pure` server that still loads the plugin, and confirms its
   fixture process has stopped. No cleanup guard or timeout was weakened.
2. Existing Claude harness lifecycle fixtures inject generator-backed `query()`
   implementations. `claude-installed-sdk-transport.test.ts` additionally runs the
   actual pinned SDK over synthetic bidirectional stdio and the production prompt
   channel. It checks that a provisional result does not close the permission or
   follow-up stream, that a subsequent permission response is written, and that
   the second result retains its own input UUID. It never starts a real CLI or
   contacts a model, and makes no native process-cleanup claim.

After the staging fix, the **actual OpenCode CLI and SDK 1.18.29** passed both
existing canary modes in a fresh isolated workspace/profile: the normal server
loaded the sentinel plugin; `--pure` excluded it while the SDK's health, provider,
and agent response checks passed. Only the prior canary's downloaded packages
were reused. No existing user configuration or credentials were exposed.

### Shared cold-discovery follow-up

An intermittent isolated Electron cancel → runtime recycle → second-send failure
reported missing exact-installation `text-streaming` evidence. Three fixed
repetitions passed before any fix; that alone did not resolve the original failure.
The retained original trace did not include the capability authority's internal
coordinates, so its precise ordering cannot be asserted retrospectively.

A subsequent deterministic production-manager reproduction confirmed a concrete
context-loss path: `codexControlContext(cwd)`, `metadata(providerId, cwd)`, and
`claudeSkills(cwd)` dropped `cwd` when cold-starting discovery. A delayed lookup
could overwrite valid workspace-scoped discovery with a probe from the application
directory. Real bounded Node/subcommand fixtures demonstrated loss of Codex
installation capability evidence, and loss of Claude authentication correlation.

All three callers now forward the same working directory used by their actual
operation. `provider-cold-discovery-context.test.ts` covers each cold and
deliberately late ordering with the production manager/installation coordinator.
It checks preservation of exact capability and auth evidence, actual Codex control
and metadata transport, and release of installation authority before next-turn
capability admission. Claude skill enumeration itself is stubbed to avoid reading
user skill directories; its forwarded directory is asserted. All six cases have
observed fail-before evidence across the two staged fix steps. Capability,
installation-replacement, cancellation, and cleanup guards are unchanged.

## Verification and remaining limits

Executed on Linux with Node 22 and the integrated Vitest 5 dependency graph:

- Focused Claude/OpenCode adapter, projection, permission, attachment, backend,
  isolation, and descendant tests: **22 files, 225 passed**.
- `providers.test.ts` and `provider-compaction.test.ts`, name-filtered to
  Claude/OpenCode: **10 passed**, 70 unrelated cases not selected.
- Full capability-manifest, compaction, canary environment, and canary process
  tests: **4 files, 84 passed**, 1 Windows-only case skipped.
- Installed-Claude-SDK transport and staged-OpenCode semantic regression:
  **2 files, 2 passed**. The staging regression also has the observed fail-before
  module-resolution result described above.
- Cold-discovery context, installation leases, workflow controller/commands,
  and provider-info refresh: **5 files, 83 passed**, including all six new
  cold/late context regressions.
- Changed-file standard and type-aware lint, plus unit-test TypeScript: passed.

These are separate command results, not a deduplicated aggregate test count.
The portable provider suite on the earlier integrated source also passed
1,087 tests with 2 skips; the root integration gate remains responsible for the
final all-provider source state.

Not exercised: authenticated Claude/OpenCode model turns, billing/account access,
real-provider attachment interpretation, live background delegation against a
model, native Windows/macOS provider execution, and full desktop journeys for
these providers. Synthetic Claude stdio is stronger than a mocked query for SDK
transport compatibility but is not CLI compatibility proof. The real OpenCode
secret-free server canary is stronger than a scripted HTTP fixture but does not
prove model execution or every upstream v2 event. Those boundaries remain explicit.
