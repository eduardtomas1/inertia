# Codex provider review — 2026-09-07

Compared with main `c9740a51`; the later main release/CI-only changes do not alter
this adapter. Review covers native app-server discovery, exact session/turn
identity, prompt and media routing, interactions, steering, compaction,
descendants, cancellation, and process settlement. No user profile or
authenticated model request was used.

## Confirmed receipt defect

`turn/steer` previously treated every successful JSON-RPC result as accepted
input, ignoring the returned `turnId`. A missing, foreign, incorrectly typed,
or whitespace-altered ID therefore appeared to acknowledge the selected turn.
The [official app-server contract](https://learn.chatgpt.com/docs/app-server)
requires `expectedTurnId` on the request and returns the accepting `turnId`.
The latest CLI-generated `TurnSteerResponse` also names that receipt.

The adapter now captures the expected turn before awaiting the request and
accepts only strict equality with the response. It deliberately does not
reject a valid receipt merely because a terminal event arrived in the same
stdout batch. No extra prompt, fallback resend, retry, or session replacement
is introduced. Existing manager-level ownership/admission remains authoritative.

`codex-steer-receipt.test.ts` uses an actual Node protocol child through the
production app-server adapter. Four invalid cases failed before the fix. All
five now check the text/image wire input, exact thread and expected turn,
acknowledgement/completion batching, confirmed process exit, and refusal to send
another steer after settlement. The shared fixture's old empty successful
receipt was corrected to the documented shape rather than preserving a fixture
that repeated the implementation's mistake.

## Retained lifecycle proof

| Area | Reviewed owner and meaningful retained evidence |
| --- | --- |
| Discovery/auth/host tools | Bounded executable/version/login probes, installation-scoped protocol evidence, native control lease, and host-owned MCP registration; provider discovery, host-registration, host-tools and capability-manifest suites. A version/help result is not account authentication proof. |
| First/next prompt and media | Exact root thread, app-server prompt blocks and retained local-image references; core bridge first/second-send and attachment fixtures cover the application boundary, while the new receipt case covers active-turn text/image steering. A fixture path proves routing, not upstream image interpretation. |
| Steering | Exact `expectedTurnId`/`turnId`, bounded request lifetime, manager conversation/run/turn ownership and late-call refusal; new five-case receipt regression plus existing app-server and host admission tests. |
| Approvals/input | Command/file-change decisions and structured questions remain correlated to native requests and the active owner; malformed/late/foreign replies do not gain authority. Existing interactions/control suites remain unchanged. |
| Completion/descendants | Root completion, correlated subagent continuation and pending host interactions have distinct owners. Goal ordering, subagent continuation and trace tests prevent unrelated child activity or replay from fabricating parent progress. |
| Compaction/resume | Native compaction request acknowledgement is not completion: exact-session context-compaction lifecycle must be observed. Saved-thread resume and capability metadata stay scoped to the selected installation/session; compaction/control and metadata fixtures retain negative cases. |
| Cancellation/shutdown | Interrupt and bounded whole-tree cleanup precede a confirmed terminal result. Late events remain inert; the shared real-SQLite settlement regressions separately prove durable state, projection consistency, rollback, mandatory cleanup and next admission. |

Focused post-fix execution on Linux with Node 22 and Vitest 5:

- New receipts, app-server, compaction, subagent continuation, goal ordering:
  **93 passed across five files**.
- Extended core/control/host-registration/interactions/status/Fast/subagent and
  provider-info refresh selection: **70 passed, one host-specific skip across
  eight files**.

These are separate commands, not deduplicated totals. Final integrated portable,
desktop and packaging results are recorded in `STABILIZATION_EVIDENCE.md`.

The secret-free upstream canary independently downloaded Codex CLI `0.153.4`,
validated its version/app-server help, generated its current TypeScript protocol,
and checked exhaustive server request/notification dispositions. It did not send
a paid prompt, authenticate, compact a real user session, or prove model-side
tool/media behavior. Native Windows/macOS and authenticated end-to-end proof
are separate from the Linux fixtures and generated-schema check.
