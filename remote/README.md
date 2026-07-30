# Remote Companion reference components

This directory contains independently versioned, dependency-minimal reference
components:

- `relay`: an in-memory opaque WebSocket router;
- `browser`: a static strict-CSP companion built from the shared version 1
  protocol and HPKE implementation.

They are intended for local development and reviewed self-hosting. This
repository does not deploy a public service, create accounts, configure
domains, or provide a production SLO.

## Local development

Install the reviewed root dependency graph with Node 22, then build/check the
remote components:

```sh
npm ci
npm run check:remote
```

Run the loopback relay:

```sh
node remote/relay/server.mjs
```

It listens on `127.0.0.1:8787` by default. Serve
`remote/browser/dist` from a local static HTTP server and include that exact
origin in `INERTIA_REMOTE_ALLOWED_ORIGINS` when starting the relay. Browser
`dist` is generated and intentionally ignored; do not commit it.

## Self-hosting boundary

Outside loopback:

- serve the browser over HTTPS;
- expose the relay only as WSS through a reviewed TLS reverse proxy;
- set `INERTIA_REMOTE_ALLOWED_ORIGINS` to a comma-separated exact allowlist of
  browser origins;
- keep the relay's plaintext listener on loopback where possible;
- if an internal non-loopback plaintext bind is unavoidable behind TLS,
  `INERTIA_REMOTE_ALLOW_INSECURE_BIND=1` is an explicit acknowledgement, not
  transport security;
- set `INERTIA_REMOTE_RELAY_HOST` and `INERTIA_REMOTE_RELAY_PORT` as needed;
- pin source/artifacts, publish checksums, restrict origin administrators, and
  monitor capacity without logging frame bodies.

The relay accepts browser WebSockets only from configured origins. Desktop
clients send no Origin. It stores no queue or account state and loses all
routing state on restart. Health is available at `/health`; WebSockets use
`/remote`.

See `docs/REMOTE_COMPANION_PROTOCOL.md` and
`docs/REMOTE_COMPANION_THREAT_MODEL.md` before exposing either component to a
network.
