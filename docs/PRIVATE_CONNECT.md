# Inertia Private Connect

Private Connect lets you open a running Inertia desktop from another device on
the same Tailscale tailnet. The desktop remains authoritative: the gateway is
loopback-only, the Tailscale CLI is invoked directly, and the bundled client is
served from the application package.

## Setup

1. Install and sign in to Tailscale on the desktop and the device you will use.
2. In Inertia, open **Settings → Connections & devices**.
3. Enable Private Connect. Inertia requires a connected Tailscale backend,
   MagicDNS, and a trusted Tailscale Serve mapping to the loopback gateway.
4. Choose **Create pairing link**, then open the link or scan its QR code on
   the other device.
5. Compare the six-digit code shown on both devices and approve the request as
   **Monitor** or **Collaborate**.

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
