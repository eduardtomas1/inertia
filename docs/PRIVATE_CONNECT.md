# Inertia Private Connect

Private Connect lets you open a running Inertia desktop from another device on
the same Tailscale tailnet. The desktop remains authoritative: the gateway is
loopback-only, the Tailscale CLI is invoked directly, and the bundled client is
served from the application package.

## Setup

1. Install and sign in to [Tailscale](https://tailscale.com/download) on the
   desktop and the device you will use. The Inertia desktop must remain online
   and unlocked while the other device connects.
2. In Inertia, open **Settings → Connections & devices**.
3. Enable Private Connect. Inertia requires a connected Tailscale backend,
   MagicDNS, and a trusted Tailscale Serve mapping to the loopback gateway.
4. Choose **Create pairing link**, then open the link or scan its QR code on
   the other device.
5. Compare the six-digit code shown on both devices and approve the request as
   **Monitor** or **Collaborate**.
6. Review paired devices in the same Settings section. You can change a
   device's access level, project scope, or expiry at any time; changing a grant
   closes its current connection and requires it to reconnect.

The invitation is held in the URL fragment, expires after five minutes, and is
consumed when pairing starts. The client removes the fragment before rendering
or making another request. Create a new link if it expires or is accidentally
shared.

## Access levels

- Monitor can read sanitized projects, conversations, bounded transcripts, and
  live run state for the projects selected on the desktop.
- Collaborate adds supervised text prompts, answers to non-secret agent
  questions, and stopping the exact active run shown in the conversation.

Neither level can approve actions, answer secret input, access files or
attachments, open a terminal, mutate Git, change providers, create projects or
conversations, enable Full Access, or execute arbitrary commands.

Private Connect is deliberately unavailable when Tailscale is missing, signed
out, disconnected, lacks MagicDNS, reports Funnel, or cannot prove the owned
Serve mapping. It never falls back to LAN, public HTTP, a relay, a VPS,
Cloudflare, Clerk, a custom domain, or a tunnel other than Tailscale Serve.

## Pause, disable, and recover

Locking or suspending the desktop closes every live browser connection and
removes the Serve mapping. A non-expired encrypted session grant remains on the
desktop, so the browser can reconnect after unlock without weakening the locked
state or repeating device approval. **Disable** is different: it revokes active
sessions and removes Inertia's mapping.

Inertia removes only a Serve mapping whose target and stored ownership proof
still match. If Tailscale reports that the mapping changed outside Inertia, the
app leaves it untouched and shows a warning. Review the current mapping with
`tailscale serve status --json`; do not use `tailscale serve reset` unless you
intend to remove unrelated mappings too.

If setup does not become ready:

- confirm both devices are in the same tailnet and can resolve MagicDNS names;
- finish any HTTPS certificate or Serve consent flow offered by Settings;
- check that tailnet ACLs permit the browser device to reach the desktop;
- verify Funnel is not enabled for the selected port; public exposure is not a
  supported Private Connect mode;
- create a fresh link if its five-minute invitation expired.
