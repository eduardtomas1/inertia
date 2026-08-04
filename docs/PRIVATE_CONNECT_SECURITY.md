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

## Browser authentication

Pairing uses a short-lived invitation in a URL fragment; it is never sent as a
query credential. A desktop approval creates a device grant and a session
cookie named `__Host-inertia-private-connect`. The cookie is Secure, HttpOnly,
SameSite Strict, host-only, and carries no Domain attribute. Mutations require
both a same-origin request and the session's CSRF header. WebSocket upgrades
require an HTTPS same-origin request and a short-lived single-use ticket, not a
cookie alone.

The gateway applies strict JSON schemas, body and frame limits, connection
limits, request timeouts, security headers, static-file containment, and
single-use delivery receipts. A locked or suspended desktop stops the gateway,
clears active sessions and tickets, and resumes only after the desktop unlocks.

## Runtime authority

The runtime receives only validated state reads, conversation reads, supervised
prompt prepare/commit, exact input responses, and exact run-stop requests. Every
request is checked against the current device grant, project/conversation
scope, expiry, session, and provider prompt-safety contract. Prompt prepare and
commit are separate, and an uncertain commit is never retried automatically.

Transcript text is sanitized, strips credentials and unsafe markup, omits code
and HTML blocks, and is byte-bounded before projection. Credentials remain in
the privileged vault and are never persisted in the Private Connect store,
sent to the browser, or written to diagnostics.
