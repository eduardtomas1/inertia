# Private Connect internals

The implementation is split by trust boundary:

- `src/shared/private-connect` contains strict scopes, grants, browser-neutral
  pairing links, protocol schemas, and runtime projection contracts.
- `src/main/private-connect` owns Tailscale discovery/Serve lifecycle, the
  loopback HTTP/WebSocket gateway, encrypted `private-connect.vault`, pairing,
  grants, sessions, audit events, and lock/unlock handling.
- `src/server/private-connect` contains the sanitized supervised runtime
  gateway and bounded transcript cache.
- `src/renderer/private-connect` is the packaged React PWA. It is built into
  the desktop app and is not a separately released or deployed artifact.
  `App.tsx` owns session state, live invalidation, and delivery bookkeeping;
  `pairing/` renders the unauthenticated screens, `workspace/` renders the
  authenticated shell, and `components/` holds reusable inputs. Presentation
  modules receive plain props so none of them reach for Electron preload APIs.

Private Connect has no external relay, separately deployed browser service,
endpoint signing layer, hosted deployment, or custom-domain configuration.

## Question and answer contract

Provider question identifiers are not UUIDs. Codex forwards the provider's own
value, Claude derives one from its tool-use identity, and Cursor and OpenCode
synthesize theirs. `src/shared/private-connect/questions.ts` is therefore the
single contract used by both the browser-facing protocol and the worker-facing
runtime schema, so the two boundaries cannot disagree about identifier shape,
answer bounds, or the custom-answer capability.

Gemini ACP does not expose a structured agent-question channel. More
importantly, Gemini CLI policy, trusted MCP configuration, or allowlists can
authorize actions without emitting an ACP permission request. Inertia therefore
cannot truthfully guarantee that every write or command from a remote prompt
would receive a local decision. Private Connect refuses prompts and does not
project prose questions for Gemini conversations; use the local provider flow.

A pending input is projected only when every question is non-secret and the
complete set fits the projected bounds. The runtime requires an answer for
every pending question, so a partial projection would render a form that can
never be submitted; an input that does not fit is withheld entirely and
reported as requiring local action.

## Gemini continuation contract

Local Gemini follow-ups never load a provider session. Gemini CLI 0.58 has no
protocol-level end marker for its asynchronous `session/load` history replay,
so every turn starts a fresh ACP process and session. The local supervised
runtime supplies a bounded application-visible user/assistant transcript. It
carries no provider session identifier, hidden reasoning, tool payload,
provider-managed credential state, or historical attachment bytes, and its
truncation state is explicit. Text explicitly entered into visible messages
remains part of the reconstruction. Private Connect cannot submit Gemini
prompts, turn that reconstruction into native resume, or request Gemini
compaction.

## Packaging verification

`scripts/package-smoke.mjs` reads the packaged `app.asar` header before
launching the application and fails when `out/private-connect` is missing its
HTML, web manifest, icons, or content-hashed assets, or when a retired remote
artifact is still present. It parses the asar header directly rather than
taking a dependency, and it accepts either the Linux/Windows `resources` layout
or the macOS `Contents/Resources` layout while requiring exactly one match, so
no platform-specific path is left unexercised.

## Gateway hardening notes

The gateway derives its `connect-src` socket sources from the already-validated
`Host` header rather than allowing the whole `wss:` scheme, so a compromised
page cannot open a socket to an unrelated host. The CSRF guard is compared in
constant time. Rate limiting keys on the loopback peer address, which behind
Tailscale Serve is shared by every remote browser; that is deliberate, because
keying on a client-supplied Tailscale identity header would let a caller
rotate the header to escape the bound. Authenticated limits are keyed per
device instead.

On startup, the main process removes only regular legacy
`remote-access.vault` and transaction files inside the user-data directory,
then records the migration marker. Existing browser pairings are intentionally
not migrated and must be approved again.
