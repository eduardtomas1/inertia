# Final provider capability review

This bounded follow-up covers every production route: Codex, Claude, Cursor,
Kimi, OpenCode and Antigravity. It follows the completion/restart review and
checks the manifest's 28 capabilities against their admission, adapter and
terminal paths. Unsupported capabilities must remain visibly unavailable or
fail before launch; this work does not invent upstream support.

## Additional reproduced defects

| Boundary | Reproduction and correction |
| --- | --- |
| Claude terminal drain | After a provisional answer and an empty delegate roster, one repository notice discarded the existing parent-resume timeout. The negative control settled without the notice and stayed pending with it. Preserve one monotonic deadline across quiet, unknown, child-owned, repeated empty/ambient roster and queued-ack traffic. Actual root work releases the former bound; no duration or delegate ownership rule changes. |
| Cursor and Kimi configuration | A provider could acknowledge a selected model, thought level or config-based plan mode with an authoritative response retaining its old value, and Inertia still sent the prompt. Confirm requested selections against authoritative full responses, including retention across subsequent configuration changes. Native mode APIs and provider-default selection remain compatible. |
| Antigravity conversation identity | Explicit foreign conversation IDs during resume or after first attestation could replace the owned identity and project foreign text/tools/results. Pin the requested or first attested ID and reject contradictions before projection. ID-less continuation frames remain valid. |
| OpenCode session identity | Both initial resume and post-create session reads accepted a returned session with a different ID. Validate the requested ID before prompt delivery; do not silently create a replacement session. |
| Codex rejected requests | Malformed or foreign approval and auxiliary requests still used the user-cancel cause. Extend the explicit protocol-failure cause to these paths, preserving genuine user cancellation, first accepted outcome and cleanup proof. |
| Shared active controls | Invalidating installation evidence during a healthy admitted run disabled its pending approval/input and steering controls in all five interactive providers. Use the admitted run's existing capability snapshot and exact negotiated observations for controls, as already done for its events. New runs still require fresh evidence, and stale owners/cancelled runs remain rejected. |

The Claude drain finding is distinct from the earlier rejected claim that an
extra iterator read alone proves an indefinite hang. This pass reproduced actual
loss of the existing bound. No unordered roster-to-child correlation or invented
child terminal event was added.

## Capability coverage

The review maps all manifest capability IDs below. Adapter-specific mappings
refer to deterministic fixtures, with shared admission and controller tests
covering capability refusal, exact identities and persistence. Existing mapped
fixtures and freshly executed focused batches are distinguished; final full and
portable gates execute the aggregate test inventory.

| Capability IDs | Paths and representative deterministic coverage |
| --- | --- |
| `text-streaming`, `reasoning`, `tool-activity`, `file-changes`, `images`, `plans` | Six native harnesses and message projectors; all provider harness suites, ACP image/permission/compaction fixtures, Claude prompt/projection/plan tests, OpenCode lifecycle tests and Antigravity parser fixtures. Bounded common document context is assembled before native text delivery. |
| `goals`, `approvals`, `structured-input`, `follow-up-steer`, `subagent-create`, `subagent-stop` | Exact run/turn controls in `run-coordinator`; Codex goals/interaction/delegation, Claude prompt/delegate/permission, ACP question/permission and OpenCode follow-up fixtures. Cursor/Kimi active steering and Antigravity interactive controls remain unavailable. |
| `session-resume`, `compaction`, `native-session-id` | Codex thread resume, Claude SDK resume, Cursor session load, negotiated Kimi resume/load, OpenCode session GET and Antigravity conversation flag. Resume/compaction/session attestation fixtures plus all-six SQLite restart tests. Unsupported compaction fails before launch. |
| `usage-tokens`, `rate-limits`, `model-discovery`, `auth-state-discovery` | Bounded provider discovery, negotiated metadata and usage projections; readiness, model, rate-limit, terminal-auth and native-rich fixtures. Missing upstream values stay unknown; unsuccessful auth probes do not become connected. |
| `host-tool-bridge`, `provider-native-tools` | Authenticated run-owned host bridges and exact tool policy; host-tool, native-tool, restricted-run, permission and cleanup-join fixtures. Unsupported bridges or enforceable no-tool requests are refused at admission. |
| `cancellation`, `process-cleanup`, `provider-owned-server` | All-six lifecycle conformance, admission cleanup receipts, native adapter termination/EOF/malformed-output fixtures, descendant ownership and cleanup uncertainty. Terminal UI publication waits for exact cleanup. |
| `maintenance-update`, `custom-backend`, `endpoint-selection`, `performance-modes` | Installation lease/maintenance authority, native/custom backend routing and credential environment boundaries; backend integration, maintenance, manifest and Claude Fast/Standard attestation fixtures. No unsupported native updater, endpoint or speed setting is claimed. |

Provider-specific review boundaries:

- **Claude:** SDK prompt and follow-up UUIDs, session/skill/Fast-mode attestation,
  bounded images, approvals/questions, tools, compaction, usage, delegation,
  ambient work, parent resumption, terminal errors and process cleanup.
- **Codex:** thread/turn/request identity, goals, inputs and approvals, tool and
  descendant events, follow-up delivery, compaction, routing, terminal ordering,
  cancellation and exact process cleanup.
- **Cursor/Kimi:** discovery/auth, advertised configuration, start/resume, rich
  text/reasoning/tools, bounded images, question/permission envelopes, host
  bridges, compaction proof, metadata, next-send behavior, malformed transport
  and joined cleanup.
- **OpenCode:** owned server startup, provider/model negotiation, exact session
  reads, asynchronous prompt admission, root/child events, early approvals,
  follow-up receipts, idle/EOF, resume and cleanup.
- **Antigravity:** supported flags/models, NDJSON prompt/parser, headless limits,
  session ownership, bounded tool/usage output, explicit terminal results,
  cancellation, authentication guidance and process retirement.

## Review and verification

Each production delta received author tests and independent source review.
Root reviewed every final production diff and new regression fixture. Review
also required a monotonic Claude deadline and sequential ACP selection retention
before source freeze. Focused counts and final aggregate gate results are
recorded in the main audit ledger; overlapping batches are not additive.

The first aggregate check stopped at unchanged file-size ceilings. Cursor's
session configuration and the embedded OpenCode lifecycle server were extracted
into focused modules; root compared the moved code against the original text.
The OpenCode extraction reuses an independently reviewed fixture from held PR
#431: descendant timelines wait for their SSE subscriber so early ancestry
events cannot disappear before the test client connects. Both immediate and
150 ms delayed subscribers retain the same product assertions. No production
deadline or test timeout was widened.

The shared-control regression covers every interactive provider with real
manager installation evidence and exact run identities, including negotiated
Cursor input, refused new launches and rejected controls after cancellation.
Adapter tests use synthetic streams or disposable local child servers. Shared
terminal/restart tests use the real SQLite store and controller with controlled
provider results; they do not replace adapter-level protocol evidence.

No live account was exercised. Native Windows/Linux validation and hosted CI
belong to the coordinating task. Upstream Kimi can collapse partial-output
failures into a normal `end_turn`; the wire response cannot reliably distinguish
that case. Source review and passing fixtures cannot guarantee every future
upstream version or service behavior.
