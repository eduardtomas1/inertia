# Private Connect security model

The desktop owns identity, persistence, grants, provider sessions, and all
privileged actions. The browser is an untrusted client.

## Boundary

The local gateway binds only to `127.0.0.1` on an ephemeral port. Tailscale
Serve maps a preferred HTTPS port to that exact loopback port. Inertia accepts
only the mapping it created and verifies the HTTPS well-known endpoint before
reporting readiness. Funnel and unrelated Serve mappings are rejected.

The Tailscale executable is spawned without a shell, with bounded arguments,
time, and output. Tailscale status and Serve JSON are parsed with forward-
compatible schemas and unknown values fail closed at the readiness decision.
Tailscale supplies encrypted private reachability and network identity; Inertia
still performs its own application pairing and grant checks. Normalized
Tailscale identity headers are display and audit metadata, never sufficient
authorization. Loopback prevents network exposure but is not a confidentiality
boundary against already-malicious software running as the same host user.

## Browser authentication

Pairing uses a short-lived invitation in a URL fragment; it is never sent as a
query credential. A desktop approval creates a device grant and a session
cookie named `__Host-inertia-private-connect`. The cookie is Secure, HttpOnly,
SameSite Strict, host-only, and carries no Domain attribute. Mutations require
both a same-origin request and the session's CSRF header. WebSocket upgrades
require an HTTPS same-origin request and a short-lived single-use ticket, not a
cookie alone.

The gateway applies strict JSON schemas, body and frame limits, connection and
per-session in-flight limits, request timeouts, security headers, static-file
containment, and single-use delivery receipts. A locked or suspended desktop
stops the gateway, closes live sockets, and clears connection tickets. The
encrypted digest of a non-expired session remains local so that the same
approved browser can reconnect after unlock; while locked, session lookup and
every request fail closed.

Disabling, revoking, and reducing a device grant first commit an encrypted
authority-reduction marker, which immediately rejects newly arriving work.
Already-admitted mutations drain through one bounded gate before the reduced
state is persisted, active sockets are closed, and the marker is cleared. Only
one authority change can cross this boundary at a time. If the process,
filesystem, or bounded drain fails between those writes, Private Connect stays
closed; the next startup disables it, revokes authority fail closed, and
removes only the still-proven owned Serve mapping before any browser access can
resume.

## Runtime authority

The runtime receives only validated state reads, conversation reads, supervised
prompt prepare/commit, exact input responses, and exact run-stop requests. Every
request is checked against the current device grant, project/conversation
scope, expiry, session, and provider prompt-safety contract. Prompt prepare and
commit are separate, and an uncertain commit is never retried automatically.
The browser may retry an uncertain prompt only with the same delivery identity,
allowing the desktop receipt to return the authoritative prior result without
executing it twice.

Transcript text is sanitized, strips credentials and unsafe markup, omits code
and HTML blocks, and is byte-bounded before projection. Credentials remain in
the privileged vault and are never persisted in the Private Connect store,
sent to the browser, or written to diagnostics.

A Collaborate prompt can cause the supervised provider to read project files,
and a sanitized answer can still contain project-derived prose. Secret
questions and approvals therefore remain desktop-only. A compromised paired
browser retains only its current grant until revocation or expiry, and Private
Connect has no availability guarantee while the host, Inertia, or Tailscale is
offline.
