# Independent Gemini and Kimi provider review

Reviewed against MAIN `c9740a517da9636df343902cb4e08d851d9e33c9` on
2026-09-07. These adapters were unchanged from MAIN before this review.
The shared ACP SDK remains exactly `@agentclientprotocol/sdk@1.4.0` in the
application lockfile. Gemini/Kimi executables are externally managed CLIs,
not bundled or pinned application dependencies; no user CLI was changed.

## Released Kimi terminal authentication — implemented, no authenticated claim

Published `@moonshot-ai/kimi-code@0.41.0` advertises
`authMethods: [{ id: "login", type: "terminal", ... }]` even when the client
does not advertise `clientCapabilities.auth.terminal`. This was independently
confirmed both in its published bundle and by a real, secret-free Linux
`kimi acp` initialize exchange in a fresh private profile. Only method ID/type
and agent identity were reported; no authentication, session or prompt request
was sent. Its owned probe tree was confirmed stopped before profile removal.

ACP allows terminal authentication only when the client advertises support;
terminal methods must not be sent to `authenticate`. The previous application
guard therefore refused the current Kimi release even when already signed in.
After this finding, the user explicitly requested terminal-auth support.
Kimi now negotiates that support through the existing privileged Connect
terminal owner. Other ACP providers retain their existing refusal boundary.
[Official authentication contract](https://agentclientprotocol.com/protocol/v1/authentication),
[official Kimi authentication implementation](https://github.com/MoonshotAI/kimi-code/blob/main/packages/acp-server/src/auth-methods.ts).

`acp-terminal-auth.ts` is the shared turn/login policy. It accepts only Kimi's
published login-only descriptor: ID `login`, arguments `["--login"]`, and no
environment change except replaying the identical configured `KIMI_CODE_HOME`.
Windows case-insensitive duplicate keys fail closed. Unknown arguments, profile
relocation, executable fields, loader/host/credential overrides, duplicate method
IDs and oversized descriptors are rejected without printing descriptor values.
Legacy `_meta` commands are never executed. The client-selected invocation is
preserved as `kimi acp --login`, including the installed executable identity.

Login remains explicitly user-selected in Connect, with the existing interactive
terminal, installation-use transfer and complete-tree cleanup. A turn never
launches login or automatically resends a model request. A valid terminal method
is not sent to `authenticate`; already-signed-in installations proceed to the
authoritative new/resumed session. An authentication-required response points
to Connect and retains the actual failing session operation. A subsequent user
send starts a fresh initialized ACP process. Legacy untyped agent-owned login
still uses its advertised protocol method.

The old drift canary incorrectly passed the unsupported initialize response
without checking authentication. Negative non-supporting-client regressions now
enforce that boundary. The Kimi-only canary opt-in bundles and executes the exact
pure production descriptor policy using existing esbuild, not a second allowlist
or version-dependent TypeScript loader. Its real 0.41.0 initialize now passes
with terminal support negotiated; no authentication/session/prompt is performed.
The published artifact explicitly implements `kimi acp --login` as a login-only
entrypoint. Neither this source check nor initialize proves a real account login.

A follow-up SDK-schema concern was **not a production defect**: its public Zod
response schema normalizes some invalid metadata, but the actual SDK 1.4 client
`initialize` request has no `mapResponse` and returns the unchanged result to
our selector. Native turn and login-probe tests both already rejected numeric
environment values and unknown method types. Those four useful wire regressions
remain; an unnecessary extra transport validator was removed.

Exact inspected artifact:
[Kimi Code 0.41.0 npm tarball](https://registry.npmjs.org/@moonshot-ai/kimi-code/-/kimi-code-0.41.0.tgz),
SHA-256 `4421e1277bbfa5e46a8e1a863fd9ba4d1a3db8dd890d928f571171ac62a80c1e`.
Downloaded with install scripts disabled; the reviewed native executable was
the separate isolated canary installation, not a user's executable/profile.

## Contract and concrete evidence

| Area | Gemini | Kimi |
| --- | --- | --- |
| Discovery/authentication | Version/help require stable ACP and owned session-ID flags, minimum 0.58.0; no auth-status or `authenticate` call; `session/new` owns credential validation | Version/ACP help plus configured-provider probe; unknown static OAuth state may proceed to negotiated authentication, known unauthenticated blocks; validated terminal login uses explicit Connect, while new/resumed sessions remain credential authority |
| Media | Negotiated PNG/JPEG/GIF/WebP bytes; no advertised audio/SVG parity | Same negotiated image formats; final read now shares Gemini's existing bounded descriptor implementation |
| Completion/next send | Requires assistant text and authoritative `end_turn`; fresh process/session, application-reconstructed visible context | Requires turn output and authoritative `end_turn`; next run negotiates `session/resume`, or advertised load with history projection suppressed |
| Follow-up | Active steering unsupported, not silently accepted; ordinary next send supported | Active steering unsupported, not silently accepted; ordinary next send supported on a compatible ACP server |
| Cancellation/late events | Protocol cancel, pending permissions resolved, late assistant output ignored; already-tracked tool completion may settle | Protocol cancel, pending permissions/questions resolved, late output rejected; preparation abort now prevents further image reads |
| Resume/compact | Native load deliberately unavailable; bounded visible user/assistant history only; manual compact fails before spawn | Native resume/load and advertised compact require exact-run evidence; an `end_turn` or command acknowledgement alone never certifies compaction |
| Descendants/settlement | Owned process tree must stop before exact outer/ACP session-record cleanup; ambiguity or missing cleanup proof fails publicly | Owned process tree and host-tool endpoint must stop before a successful public terminal result; incomplete cleanup fails publicly |

The official Gemini 0.58.0 dispatcher can change saved authentication state
when `authenticate` is called, and its session manager starts history replay
without awaiting it. The retained restrictions follow those concrete upstream
behaviors, not an invented feature-parity promise.
[Gemini 0.58.0 dispatcher](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/cli/src/acp/acpRpcDispatcher.ts),
[Gemini 0.58.0 session manager](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/cli/src/acp/acpSessionManager.ts).

ACP's prompt response is the turn-completion boundary; subsequent conversation
prompts are distinct turns. Capability negotiation, rather than a provider
name, authorizes optional image/resume operations.
[Official prompt/cancellation lifecycle](https://agentclientprotocol.com/protocol/prompt-turn),
[official initialization](https://agentclientprotocol.com/protocol/v1/initialization),
[Kimi ACP method coverage](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-acp.md).

## Confirmed application defect and narrow fix

The attachment broker validates retained content, but document preparation
passes image pathnames to the provider. Kimi previously called `readFile`
before enforcing its aggregate bound and without a cancellation signal. A file
grown/replaced after handoff could therefore be fully allocated or followed;
cancellation could not stop preparation. Three isolated regressions failed
against that original implementation: oversized file, symlink, pre-read abort.

`provider-image-read.ts` extracts Gemini's existing implementation instead of
adding a new attachment framework: existing shared 10 MiB/file and 20 MiB/turn
limits, regular-file/no-follow checks, stat/open identity, retained descriptor,
bounded chunk reads, EOF/snapshot checks, cancellation and guaranteed close.
Gemini semantics remain unchanged; Kimi supplies its own run-local abort
signal. This is final-read validation, not a replacement for broker authority,
content validation or digest verification at attachment handoff.

The shared regression matrix also substitutes a different regular file between
stat/open, replaces the pathname after open, exercises aggregate limits and
preserves valid bytes/MIME negotiation. Cursor's independently owned review
subsequently adopted the same reader and extended the matrix.

## Tests run and remaining proof limits

- Seven existing Gemini/Kimi framing, negotiation, history, redaction,
  session-cleanup and compaction suites: **112 passed** (11.52s).
- Discovery, capability/maintenance, follow-up coordinator and Gemini upstream
  surface suites: **106 passed** (6.51s); this includes other-provider cases in
  the shared discovery file, not 106 distinct Gemini/Kimi-only cases.
- After extraction, existing Gemini/Kimi harnesses plus initial media cases:
  **63 passed** (11.64s). Expanded Gemini/Kimi descriptor matrix:
  **14 passed**; Cursor owner subsequently verified its added matrix row.
- New `acp-provider-next-send.test.ts`: **2 passed**. Real synthetic ACP child
  processes use the pinned SDK through production harness/manager code: two
  sequential sends per provider, exact Kimi resume versus Gemini fresh history,
  no unsupported active steering, no post-response text, empty active owner list
  and all fixture PIDs stopped before reuse.
- Drift process suite: **30 passed** (3.16s), including the two negative
  authentication cases that failed before the validator correction.
- Generated portable gate before the user-requested terminal-auth addition:
  **71 files, 1,123 passed / 2 skipped** (115.22s). An earlier invocation stopped
  before tests on duplicate harness ownership markers, corrected at their source.
- Terminal-auth policy, four new native signed-in/auth-required new/resume cases
  and the existing Kimi harness: **54 passed** (11.70s). All four new native cases
  failed before support; exact fixture processes exit before ownership is reused.
- Canary production-policy staging/negotiation and drift process cases:
  **32 passed** (4.04s), including rejection of descriptor-provided loader state.
- The five terminal-auth policy/harness/canary suites together subsequently
  passed **86 tests** (12.83s); final unit TypeScript also passed.
- Integrated generated portable gate with terminal-auth support and the shared
  login/UI ownership changes: **77 files, 1,205 passed / 2 skipped** (120.79s).
  Subsequent malformed-wire regressions changed no production behavior: the
  policy/turn files passed **40 tests**, and the probe owner verified **25 tests**.
- Both repository lint modes and unit TypeScript passed after the owned changes.

Root owns the final integrated full check, coverage and release/native gates.
No authenticated model turn, real-provider compaction, model quality, account
entitlement, live tool subprocess or user CLI upgrade was exercised here.
Native fixture results were obtained on Linux; portable Windows/macOS execution
still depends on the final hosted native lanes. Gemini's new sequential test
mocks only provider-side session-record removal; real filesystem ownership and
cleanup failure cases remain in `gemini-session-cleanup.test.ts` and the main
Gemini harness suite. A fixture pass does not certify a real account login or
asynchronous upstream compaction as completed.
