# Cursor provider review — 2026-09-07

Scope: production Cursor ACP adapter and discovery/authentication, negotiated
media/configuration, interaction authority, cancellation/cleanup, subsequent
turns, native session loading and compaction; compared with `c9740a51`.
No user application/profile, provider login, credential or authenticated model
request was used. The legacy print-mode adapter is not the production route.

## Confirmed defects and corrections

1. **Question replies used the wrong envelope.** The adapter returned a flat
   answer/cancellation object. Cursor's documented response wraps the outcome,
   and the official downloaded CLI reads that nested field. The flat answer
   therefore becomes cancellation, even though Inertia showed the question as
   answered. Corrected all answer/cancellation paths and the old fixture that
   asserted the same wrong shape. The new strict Node protocol peer rejects the
   old envelope; both answer and cancel cases fail before and pass after.
   See [Cursor question contract](https://cursor.com/docs/cli/acp#cursorask_question).
2. **Supervised plan creation was silently accepted.** Cursor treats acceptance
   as successful plan creation and may write its own local plan artifact when
   no URI is supplied. Inertia displayed the plan then accepted without asking.
   The adapter now uses the existing one-shot file-change approval path:
   supervised mode awaits the exact owner's approve/deny/cancel decision;
   auto-edit/full retain their existing file-write policy. There is no mode
   switch or persistent permission grant. Three supervised cases fail before
   and pass after; automatic-policy positive controls remain green. See
   [Cursor plan contract](https://cursor.com/docs/cli/acp#cursorcreate_plan).
3. **Final image reads lacked the retained-file safety boundary.** Cursor read
   the entire path before checking its aggregate limit, following replacements
   and ignoring preparation cancellation. Its existing MIME mapping now uses the
   same descriptor-bound reader as Gemini/Kimi: regular-file identity, 10 MiB
   per file / 20 MiB total before allocation, bounded chunks, cancellation,
   unchanged descriptor snapshot and guaranteed close. Four Cursor cases fail
   before: per-file growth, regular-file substitution, symlink replacement and
   pre-aborted preparation. No supported MIME type was removed.

Cursor changes are confined to `cursor-acp-harness.ts`, its existing fixture
expectations, `cursor-acp-interactions.test.ts`, and one additional row in the
shared `acp-provider-image-read.test.ts` matrix. The bounded reader is shared
with the independently reviewed Gemini/Kimi fix; no new framework or IPC surface.

## Retained contracts and evidence boundaries

| Area | Reviewed behavior / retained owner |
| --- | --- |
| Transport | `agent acp` / `cursor-agent acp`; configured editor launcher uses `cursor agent acp`. JSON-RPC over newline-delimited stdio, protocol v1 / pinned ACP SDK 1.4.0. UTF-8 and envelope validation precede SDK dispatch; 1 MiB frames, 8,192 events / 32 MiB total, 4 MiB text result, bounded stderr and interaction/tool maps. [Official transport](https://cursor.com/docs/cli/acp#transport-and-message-format). |
| Discovery/auth | Version + ACP help + provider identity + bounded `status` probe, with confirmed process cleanup required for admission. An unrelated generic `agent` is rejected; Cursor-specific executable is preferred. Session initialization validates protocol/provider identity and uses advertised `cursor_login`; unsupported terminal authentication fails closed. Real account login/status and network/quota errors were not exercised. [Official authentication](https://cursor.com/docs/cli/reference/authentication). |
| Media | Text plus PNG/JPEG/GIF/WebP image blocks only when image capability is advertised; 10 MiB/file and 20 MiB aggregate through the retained-descriptor reader. The fixture proves base64 wire delivery, not actual vision understanding. Unsupported image negotiation fails; audio/video are not claimed. Application document extraction feeds text separately, not a claimed native Cursor PDF capability. [ACP content](https://agentclientprotocol.com/protocol/v1/content). |
| Configuration | Mode/model/effort must be advertised. Setter responses replace the authoritative configuration options; tests cover model-dependent effort choices. This proves requested protocol routing, not the upstream inference backend's actual model identity. |
| Next send/resume | A fresh owned process loads the exact saved session, never silently creates a replacement when resume is unsupported. New real-child cases prove answer → cleanup → same-session next send and cancel → cleanup → next send; replay text and foreign-session updates do not enter the new answer. Live in-flight steering is not advertised for Cursor: queued follow-ups remain application-owned. [ACP session setup](https://agentclientprotocol.com/protocol/v1/session-setup). |
| Cancellation/late events | `session/cancel`, pending interaction cancellation and outer bounded process-tree fallback remain intact. Terminal status waits for confirmed cleanup; failed cleanup is authoritative and prevents reuse. Existing cases cover setup cancellation, sockets, delayed cleanup, malformed updates racing completion and retained prior failure. New cases verify post-cancel text suppression plus foreign run/turn and late approval refusal. [ACP turn contract](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation). |
| Compaction | Requires a current post-load advertisement of `summarize`, then clean ACP lifecycle completion; a bare command `end_turn`, stale advertisement, missing capability or failed/cancelled lifecycle is not success. Summary chunks are retained context, not new answer text. Tests cover all of those distinctions; no authenticated upstream compaction was run. |
| Terminal resume | Separate from ACP session loading: ACP-to-terminal identity compatibility remains explicitly restricted to the already verified `2026.08.04-aaa8809` build. Downloading a newer CLI does not expand that allowlist or claim native terminal-resume compatibility. |

## Verification

- Before new corrections: Cursor harness/shared ACP suites **54 passed**.
- Strict question peer: **2 expected failures before**, then passed after the
  envelope correction. The peer validates the actual outbound response and only
  accepts the documented nested contract.
- Supervised plan policy: **3 expected failures before**; auto-edit/full controls
  passed. The fixed peer proves no response before a decision, exact identity
  admission, deny/cancel mapping, late refusal and complete cleanup.
- Cursor harness + interactions + shared ACP parser/compaction: **61 passed**.
- Added Cursor media matrix: **4 expected failures before**. Final combined
  Cursor interaction/transport/compaction and all three shared media rows:
  **82 passed** across five files.
- Cursor discovery selection: **3 passed**, 39 unrelated tests omitted by the
  explicit name filter; not represented as a full discovery-suite pass.
- Shared terminal-resume / capability suites: **39 passed**.
- Focused standard and type-aware Oxlint, Node and unit-test TypeScript configs,
  and `git diff --check`: passed.

These are real local Linux Node-child protocol fixtures, not an authenticated
Cursor session or native Windows/macOS run. Parent-owned final integrated
portable/native gates and latest-upstream canary results must be reported
separately. Earlier packaged candidate `1876149f` predates these Cursor fixes.

## Upstream inspection identity

The existing canary workflow's official installer URL was downloaded and read,
not executed; its reviewed Linux x64 archive was extracted into an isolated
temporary directory. Launcher was handed to the integrator's credential-free
canary. Shipped `189.index.js` corroborates both nested question response access
and plan-artifact creation after acceptance; no upstream code was copied into
production or tests.

- Versioned archive: `2026.09.02-c22c1a3`.
- Installer SHA-256: `e3f0427f5391edeb3cf22f78d340281cffb192255496eeeaca8b6c4d0c34330f`.
- Archive SHA-256: `b73b59854762535c0fc20d7ccc51c3b5a356a851491088d60a362be48750f53c`.
- Launcher SHA-256: `2ccc9a8e167797641448b5e5c936f006ba137a2555f117f38c5eb76a5238a233`.

Local raw logs: `/tmp/inertia-stabilization-cursor-final.log`,
`/tmp/inertia-stabilization-cursor-media-before.log`,
`/tmp/inertia-stabilization-cursor-question-before-final.log`,
`/tmp/inertia-stabilization-cursor-plan-before-final.log`,
`/tmp/inertia-stabilization-cursor-discovery.log`, and
`/tmp/inertia-stabilization-cursor-shared-capabilities.log`.
