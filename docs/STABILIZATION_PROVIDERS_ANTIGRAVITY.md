# Antigravity integration investigation — 2026-09-07

Status: **investigation complete; no Antigravity provider route implemented**.
No Gemini provider, persisted identity, session, authentication configuration,
installer, or user application was changed by this investigation. A complete
adapter is not claimed: the currently published ACP runtime has a confirmed
terminal-failure ambiguity described below.

## Product and transport boundaries

Google ended individual Gemini CLI requests for Free/Google AI Pro/Ultra on
June 18, 2026. API-key and Gemini Code Assist enterprise access are unaffected.
Keep the existing Gemini provider and its history for those supported users;
never reinterpret an existing Gemini session as an Antigravity session.
[Official transition announcement](https://github.com/google-gemini/gemini-cli/discussions/28017).

The `agy` CLI and the Antigravity ACP server are separate distributions. The
CLI's documented streaming input accepts text but rejects interactive control
messages. It is not a substitute for Inertia's approval/question transport.
The CLI installer was inspected, not run; no user CLI was installed or upgraded.
[Official CLI headless contract](https://antigravity.google/docs/cli/headless/).

Google documents ACP-registry installation for Zed. The registry publishes
`antigravity-acp` 1.1.1 for Linux x64/ARM64, Windows x64/ARM64 and macOS ARM64;
there is **no macOS Intel artifact** in that registry entry. Linux invokes
`agy_acp_server.par --uid=`; Windows uses `agy_acp_server.exe`. The adjacent
`localharness_external` executable is part of the runtime, not an optional CLI.
[Google IDE instructions](https://antigravity.google/docs/ide/extensions/zed),
[official distribution manifest](https://raw.githubusercontent.com/agentclientprotocol/registry/main/antigravity-acp/agent.json).

## Native evidence and its limits

The pinned official Linux x64 archive was downloaded to a private temporary
directory. Its central directory was checked before extraction: exactly two
regular executable entries, with no traversal or symlink entries. Only those
entries were extracted. A synthetic HOME/XDG/cwd, a minimal environment, no
display or usable keyring bus, and dead-end HTTP proxies were used. This was
credential isolation, not a claimed network-namespace sandbox.

Two bounded native invocations were made: help, then **initialize only**. No
`authenticate`, session creation/loading, prompt, model inference, or real
credential/profile access was requested. Both exact private process groups
were confirmed stopped. Help exited 1 with valid help text; initialize exited
0 with no stderr and one matching JSON-RPC response. Discovery must not assume
that this executable supports the usual successful `--version` probe.

The actual initialize response identified `antigravity-acp`, version
`agy_acp_server_1.1.1`, protocol 1, and advertised:

- Session loading, listing and resumption; logout.
- Image, audio and embedded-context prompts; HTTP and SSE MCP servers.
- Agent-managed authentication IDs `oauth-personal`, `oauth-business`,
  `gemini-api-key` and `agent-platform`. No terminal-auth descriptor.

These are **native capability advertisements**, not proof of authenticated
turns, vision, successful cancellation, persistence, or native Windows/macOS
operation. No existing Inertia provider canary result implies Antigravity
coverage.

## Published runtime source review

The official archive includes its Python ACP adapter source. References below
are to `google3/cloud/developer_experience/antigravity_extensions/acp_server/`
inside that exact artifact, not to a third-party adapter.

| Contract | Evidence and integration consequence |
| --- | --- |
| Authentication | `server.py:2370` returns an authenticate receipt after the selected native flow succeeds. `new_session` at 2691 calls the auth assertion at 2588; personal/business OAuth can open a browser. Therefore session creation is not a passive discovery/auth-status check. Initialize carries no authenticated-state result. |
| Browser login | `oauth/credential_manager.py:381` owns a localhost OAuth callback, opens the browser and prints a fallback URL to stderr, with a 300-second native timeout. The internal passive credential check at 485 is not an ACP method. An explicit Connect operation needs exact receipt, cancellation and process-tree ownership; do not invent an `agy login` command for this different runtime. |
| Native state | `paths.py:73` roots state at `GEMINI_HOME`, otherwise the user's `.gemini` directory. ACP settings/credentials/trajectories live in its `antigravity-acp` subtree, distinct from the CLI's subtree/keyring. Do not copy tokens, infer ACP authentication from the CLI, or reuse Gemini cleanup paths. |
| Companion process | `main.py:44` resolves the adjacent native harness and sets `ANTIGRAVITY_HARNESS_PATH`. The entire installation and descendant tree need Inertia's existing identity/cleanup protection. |
| Permissions | `config_options.py` exposes `default`, `auto_edit`, `yolo`. `server.py:3804` still requests review for certain enterprise policies even in automatic modes. Set the selected native mode, but honor remaining callbacks; do not transplant Kimi's automatic approval shortcut. Prefer one-shot options, never an implicit persistent grant. |
| Questions | `server.py:4173` multiplexes single-choice questions through `session/request_permission`, using `interaction_<8 hex digits>` IDs and arbitrary option IDs. It is not Kimi's named-tool/numbered-option format. Preserve exact choices, always request explicit input, and reject malformed/ambiguous input. Multi-select/freeform support is not established. |
| Resume | `server.py:3081` restores the exact trajectory without replay; loading at 3171 also emits history. Prefer advertised resume; suppress replay when falling back to load. Missing trajectories fail rather than silently creating a new session. |
| Plan/compact | The packaged SDK's `BuiltinSlashCommandName` contains `plan`, and the ACP adapter also advertises logout. No compact command or persistent plan session mode is established. A slash-command plan request is not evidence of Inertia's plan-only execution semantics. |
| Cancellation | `server.py:2787` forwards cancellation to the active native conversation; cleanup at 2802 disposes sessions/tasks. This is source evidence only. An adapter still needs bounded host cancellation, late-event suppression and confirmed descendant cleanup before terminal settlement. |
| Media | `server.py:1056` parses text, image/audio and embedded text; image/audio bytes are base64-decoded. Preserve Inertia's descriptor-bound image reader and negotiated capability gate. No new audio/document feature is implied merely by upstream advertisement. |

## Confirmed upstream terminal-failure blocker

`AgyAdapter.prompt` in `server.py:4291` catches SDK execution, connection and
validation exceptions at 4454. It emits an ordinary assistant text chunk,
without structured failure metadata. The final response at 4541–4545 can
still carry `stopReason: end_turn`. The second WebSocket failure/rebuild error
has the same reporting issue. Failed tool updates are not a reliable substitute:
an exception before any tool has no tool update to classify.

A private deterministic proof compiles the **unchanged published prompt-method
AST**, with SDK/schema/client doubles and no imports of the provider runtime.
All five cases passed their expected assertions:

- Success: `end_turn`.
- SDK execution, connection and validation failures before tools: each emits
  only assistant text, then `end_turn`.
- Cancellation positive control: `cancelled`.

Each case made exactly one synthetic SDK chat call. This proves the source
branch, **not an authenticated native outage**. Parsing error prose or Python
logging output would be a brittle host workaround; those strings are neither a
structured ACP error receipt nor a reliable discriminator from assistant text.
An upstream typed JSON-RPC failure or documented structured terminal-error
extension is needed for an unambiguous adapter contract.

The public Python Agent SDK exposes typed errors, but its documented setup uses
a Gemini API key or enterprise API-key/ADC configuration. It is not a documented
individual-subscription OAuth replacement; implementing an internal OAuth/proxy
bridge would exceed the supported public SDK contract.
[Official SDK overview](https://antigravity.google/docs/sdk/overview/),
[official SDK source and distribution requirements](https://github.com/google-antigravity/antigravity-sdk-python).

## Design once the contract is resolved

Add distinct `antigravity` / `antigravity-acp` / `builtin:antigravity` identities
with an append-only migration and exact continuation identity. Keep legacy
Gemini identities and transcripts unchanged; switching providers starts a new
native conversation, never retargets an old session ID.

Reuse bounded ACP framing, owned-process admission/cleanup, descriptor-bound
images, host MCP, exact interaction ownership and replay suppression. Keep
Antigravity's authentication, permissions/questions, advertised configuration
and failure projection provider-specific. Do not duplicate a complete Kimi
harness or build a generic framework solely to disguise incompatible contracts.
Gate unsupported platforms/features explicitly. Add deterministic protocol,
migration, cancellation and cleanup cases before claiming production support.

## Reproducible identities

- [Official ACP Linux x64 archive](https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_1.1.1-linux-x86_64.zip):
  681,969,407 bytes; SHA-256
  `38f62d01b32deb0907b3d39a71ec301fd36369f6ffd1cf262d4af385177f79df`.
- Extracted `server.py` SHA-256:
  `f49336e59953e4ca05d0600599eee027acdc7b319cfc9a9c2301225586f805c8`.
- Inspected CLI installer SHA-256:
  `ee1ea43ce4e9e56356c4ab6dad907ef357ae4bdfcaadb682735909fb57c9c640`.
  Its current manifest named CLI 1.1.27; that is not the ACP version.
- Local-only native probe, sanitized response and AST proof:
  `/tmp/inertia-antigravity-review.TWTPtS/{probe.mjs,initialize.json,prompt-contract-proof.py}`.
- Local unpublished upstream issue draft:
  `/tmp/inertia-antigravity-upstream-issue-draft.md`.

No upstream issue was posted and no production adapter or test suite was changed
for this investigation. This document is evidence and a design boundary, not an
implemented migration or a claim that the upstream blocker is fixed.
