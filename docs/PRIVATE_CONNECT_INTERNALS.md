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

A pending input is projected only when every question is non-secret and the
complete set fits the projected bounds. The runtime requires an answer for
every pending question, so a partial projection would render a form that can
never be submitted; an input that does not fit is withheld entirely and
reported as requiring local action.

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
