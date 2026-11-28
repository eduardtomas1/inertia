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

Antigravity ACP (`antigravity-acp`) routes permission requests to Inertia, so
Private Connect admits Antigravity ACP prompts under the same approval-routed
safety tier as Cursor, Kimi Code, and Grok. Historical headless `antigravity-cli`
routes without an approval channel remain refused.

A pending input is projected only when every question is non-secret and the
complete set fits the projected bounds. The runtime requires an answer for
every pending question, so a partial projection would render a form that can
never be submitted; an input that does not fit is withheld entirely and
reported as requiring local action.

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
constant time. Authenticated limits are keyed per device. Pairing limits are
keyed per invitation or pairing-request identifier, not per loopback peer
address, which behind Tailscale Serve is shared by every remote browser. A
failed check is counted only when the host's `pairingCapabilityLive` reports
that the identifier names the current invitation or a pending pairing, so
floods of unknown identifiers neither reach a secret comparison nor spend the
real invitation's budget. The gateway reserves a failure slot before awaiting
the host, so overlapping requests cannot exceed the bound, and releases it when
the check succeeds. The `Tailscale-User-Login` header, or the socket address
when the header is absent, only splits an identifier's failure budget into
per-caller shares of the stage limit; the identifier's total is twice that
limit. Serve removes client-supplied copies of the header
(https://tailscale.com/kb/1312/serve), but a local process can reach the
loopback port directly and rotate it, so the total is the bound that holds
against rotation.

On startup, the main process removes only regular legacy
`remote-access.vault` and transaction files inside the user-data directory,
then records the migration marker. Existing browser pairings are intentionally
not migrated and must be approved again.

Secure platform storage is checked only when Private Connect is needed: at
startup when the encrypted Private Connect store already exists, and otherwise
when Settings first loads the Private Connect section or enables it. A launch
that never uses Private Connect does not touch the macOS Keychain.
