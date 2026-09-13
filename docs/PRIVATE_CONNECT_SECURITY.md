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
cookie alone. Local loopback development origins are also accepted.

Cookies are scoped by hostname, not port. Other HTTPS services on the same
MagicDNS hostname receive this cookie when visited from the paired browser.
Use a dedicated trusted host for Private Connect; do not expose untrusted
services on other ports of that hostname. Host separation requires external
Tailscale configuration and is not provided by the cookie prefix.

The gateway applies strict JSON schemas, body and frame limits, connection and
per-session in-flight limits, request timeouts, security headers, static-file
containment, and single-use delivery receipts. A reported lock or suspend stops the gateway, closes live sockets, and clears
connection tickets. Electron does not report screen-lock events on Linux;
Linux users must disable Private Connect before leaving the desktop unattended.
Resume rechecks the idle state and restores access only when it reports active
or idle. Unknown state remains fail closed. The
encrypted digest of a non-expired session remains local so that the same
approved browser can reconnect after unlock; while locked, session lookup and
every request fail closed.

The installable browser client caches only its generated HTML, scripts, styles,
manifest, and icons. Its service worker bypasses every `/api/` request and never
adds runtime responses, transcripts, cookies, CSRF values, or pairing fragments
to the cache. When the host is unreachable, an already-open tab may keep its
in-memory view visible but disables mutations; a cold offline launch shows only
the app shell. Notification navigation carries at most a validated conversation
identifier in a fragment, which the client consumes before rendering so it is
not sent to the gateway.

Disabling, revoking, and reducing a device grant first commit an encrypted
authority-reduction marker, which immediately rejects newly arriving work.
Already-admitted mutations drain through one bounded gate before the reduced
state is persisted, active sockets are closed, and the marker is cleared. Only
one authority change can cross this boundary at a time. If the process,
filesystem, or bounded drain fails between those writes, Private Connect stays
closed; the next startup disables it, revokes authority fail closed, and
removes only the still-proven owned Serve mapping before any browser access can
resume.

## Local audit history

The encrypted Private Connect store records the device identifier for accepted
prompts, answers and stop requests without recording their content. Answer and
stop requests first persist an intent record; if that write fails, the runtime
receives no action. An acknowledgement that cannot be saved after an action is
reported as uncertain, so the browser asks the user to check the desktop.
A stop acknowledgement records acceptance of the request, not proof that a
provider process has exited.

The audit remains bounded to 1,000 events. Connection diagnostics use at most
100 entries and cannot evict security events; the settings view reserves at most
10 of its 50 visible entries for those diagnostics. Connection diagnostics are
best effort and are persisted with meaningful state changes. Remote turn origin
is not yet attached to the desktop transcript.

## Runtime authority

The runtime receives only validated state reads, conversation reads, supervised
prompt prepare/commit, exact input responses, and exact run-stop requests. Every
request is checked against the current device grant, project/conversation
scope, expiry, session, and provider prompt-safety contract. Prompt prepare and
commit are separate, and an uncertain commit is never retried automatically.
The browser may retry an uncertain prompt only with the same delivery identity,
allowing the desktop receipt to return the authoritative prior result without
executing it twice.

Transcript text uses best-effort redaction for known credential formats and
unsafe markup, omits code and HTML blocks, and is bounded before projection.
Unrecognized secrets in ordinary project prose can remain. Vault credentials
remain in the privileged vault; they are not deliberately projected to browsers,
stored in the Private Connect store, or written to diagnostics.

A Collaborate prompt can cause the supervised provider to read project files,
and a sanitized answer can still contain project-derived prose. Secret
questions and approvals therefore remain desktop-only. A compromised paired
browser retains only its current grant until revocation or expiry, and Private
Connect has no availability guarantee while the host, Inertia, or Tailscale is
offline.
