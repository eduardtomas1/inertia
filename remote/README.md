# Remote Companion reference components

Remote Companion is a self-hosted/private-network feature. Inertia does not
operate a public relay, account system, browser origin, or availability SLO.
The desktop makes one outbound WebSocket connection; it never opens an inbound
listener or shares the privileged local runtime capability.

The two independently versioned reference artifacts are:

- `inertia-remote-browser-0.3.0.tar.gz`: a static strict-CSP companion;
- `inertia-remote-relay-0.2.0.tar.gz`: the blind relay, endpoint-authentication
  implementation, lockfile, and private-network reverse-proxy examples.

Release assets include `REMOTE-SHA256SUMS.txt`. Each archive also contains a
strict manifest with its source commit, Node range, supported relay/application
protocol ranges, lockfile digest, and the SHA-256/size of every file. Verification
rejects extra files, symlinks, path traversal, non-deterministic layout, altered
archives, and mismatched component versions.

## What stays local

The relay sees endpoint/connection identifiers, IP addresses, timing, sizes,
component versions, and ciphertext. It has no HPKE private keys and no durable
message queue. Invitations, grants, conversation text, and prompts remain E2EE.

Approvals, credentials, files and attachments, terminals, Git, Full Access,
provider settings, local diagnostics, and provider process control have no
remote request schema and remain desktop-only. “Supervised” remote prompting
means the chosen provider may read the explicitly granted project context and
return project-derived prose, while reported actions still require the local
desktop policy. It is not a source-confidentiality promise.

## Local development

Use Node 22 and the reviewed root lockfile:

```sh
npm ci
npm run check:remote
```

In separate terminals:

```sh
INERTIA_REMOTE_ALLOWED_ORIGINS=http://127.0.0.1:4173 \
  node remote/relay/server.mjs
npm --prefix remote/browser run preview
```

Configure Inertia with:

- setup mode: **Local development**;
- companion URL: `http://127.0.0.1:4173/`;
- relay URL: `ws://127.0.0.1:8787/remote`.

Run **Test setup** before enabling. Loopback development reports ephemeral
relay persistence by design; it is never accepted for self-hosted mode.

## Private-network deployment with Tailscale Serve

This is the approachable supported path. It is private to your tailnet; do not
use Tailscale Funnel. Tailnet ACLs remain an additional network boundary, not a
replacement for Remote Companion pairing or E2EE.

1. Download the browser and relay artifacts from the same release plus
   `REMOTE-SHA256SUMS.txt`. Verify them before extraction:

   ```sh
   sha256sum --check REMOTE-SHA256SUMS.txt
   ```

   On macOS use `shasum -a 256 -c REMOTE-SHA256SUMS.txt`.

2. Extract into versioned, read-only application directories. Install only the
   relay artifact's exact lockfile using Node 22:

   ```sh
   cd /opt/inertia-remote-relay-0.2.0
   npm ci --omit=dev
   ```

3. Create a relay service user and a private durable directory such as
   `/var/lib/inertia-remote-relay`. Copy `relay.env.example`, replace the exact
   tailnet HTTPS origin, and protect both paths from other users. Set
   `INERTIA_REMOTE_RELAY_INITIALIZE=1` only for the first successful start;
   remove it afterward. Restoring the browser files without the relay state
   directory creates a different relay identity and requires an explicit
   endpoint reset plus re-pairing.

4. Start the relay on loopback. It refuses non-loopback plaintext binds unless
   the operator explicitly acknowledges the TLS-proxy boundary, and it requires
   durable state outside loopback development.

5. Copy `Caddyfile.tailscale.example`, update its versioned browser root, and
   run Caddy on loopback port 8080. The recipe routes only `/remote` to the
   relay and serves the browser with the required response-header CSP,
   `frame-ancestors 'none'`, no-referrer, same-origin resource policy, and
   nosniff protection.

6. Ask Tailscale Serve to expose that one local origin over tailnet HTTPS:

   ```sh
   tailscale serve --bg http://127.0.0.1:8080
   tailscale serve status
   ```

   Use the printed `https://…ts.net/` URL as the companion URL and the same
   origin with `/remote` and `wss://` as the relay URL. Put that exact HTTPS
   origin in `INERTIA_REMOTE_ALLOWED_ORIGINS`.

7. Run **Test setup**. Self-hosted mode requires all of the following before
   the enable control becomes available: HTTPS companion response, WSS/TLS
   success, required CSP/security headers, exact Origin acceptance, compatible
   browser/desktop/relay protocol ranges, endpoint-auth v2, and durable relay
   storage.

The current Tailscale Serve CLI and HTTPS prerequisites are documented at
<https://tailscale.com/docs/reference/tailscale-cli/serve>. Review that page
when installing a different Tailscale release; the CLI changed in version 1.52.

## Endpoint ownership, restart, and migration

Relay transport v2 sends a stable relay identity and uses a separate desktop
ECDSA P-256 endpoint key. A first claim proves the key before a binding is
durably created. Reconnect proves the bound key and advances a durable epoch.
An authenticated takeover persists the newer epoch first, fences every old
route, then closes the stale desktop. A captured proof cannot cross relay
identities, sockets, endpoint IDs, nonces, purposes, or epochs and expires in
five seconds.

`GET /health` is secret-free and returns only status, component/range values,
endpoint-auth/persistence mode, origin policy presence, and transport class.
It never returns endpoints, keys, nonces, owners, routes, invitations, or frame
content.

Legacy unauthenticated registration is off. During a bounded operator-led
migration only, `INERTIA_REMOTE_ALLOW_LEGACY_REGISTRATION=1` accepts legacy
desktops for unbound, process-local endpoints. It cannot create/replace a v2
binding, health is degraded, and **Test setup** rejects it. New deployments
must never enable this flag.

If durable relay identity changes, Inertia refuses silent takeover. The local
**Reset endpoint and re-test** action disables access, creates a fresh endpoint
signing identity, retires old grants, and requires every browser to use
**Forget this browser** and pair again.

## Pairing and recovery

The desktop creates a five-minute client-fragment link and QR code. Invitation
material appears only after `#`; browsers do not send it in HTTP request targets
or referrers, and the companion removes it from the address bar before parsing.
Raw invitation JSON exists only under **Advanced**. Regeneration invalidates the
prior invitation; Cancel removes it immediately.

The browser keeps its non-extractable device key in IndexedDB. It preserves
that sealed profile through transient plaintext relay closes. Revoked/expired
devices that reconnect with the authenticated-rejection capability receive a
sealed terminal result, including after desktop/relay restart and after the
desktop has pruned the original device into a bounded tombstone. Only that
authenticated result erases authorization-bound state. If browser storage was
cleared, the relay identity changed, or the tombstone retention window elapsed,
forget the old profile locally and create a new pairing.

## Operational checks

- Back up the relay state directory atomically with its permissions; never edit
  individual binding records.
- Monitor process health and capacity without logging request targets, frame
  bodies, WebSocket payloads, or invitation fragments.
- Keep the browser and relay on matching checksummed releases. Structured
  incompatibility guidance tells which component must be upgraded; no client
  silently downgrades.
- Verify `/health` locally, the external HTTPS headers, WSS upgrade with the
  exact companion Origin, certificate chain/hostname/expiry, and a mobile
  background/foreground reconnect before pairing production devices.
- Rotate to a newer matching artifact set by stopping the relay, preserving its
  state directory, installing the new version elsewhere, verifying checksums,
  then restarting. A valid restart retains relay identity and increments
  endpoint epochs on reconnect.

See `docs/REMOTE_COMPANION_PROTOCOL.md`,
`docs/REMOTE_COMPANION_THREAT_MODEL.md`, and
`docs/REMOTE_COMPANION_ONBOARDING_SECURITY_DESIGN.md` for the protocol and
security rationale.
