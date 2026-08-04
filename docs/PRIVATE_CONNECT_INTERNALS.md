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

Private Connect has no external relay, separately deployed browser service,
endpoint signing layer, hosted deployment, or custom-domain configuration.

On startup, the main process removes only regular legacy
`remote-access.vault` and transaction files inside the user-data directory,
then records the migration marker. Existing browser pairings are intentionally
not migrated and must be approved again.
