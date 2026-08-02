import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Remote Companion private-network deployment contract", () => {
  it("ships a tailnet-only reverse proxy with production browser headers", async () => {
    const [caddy, environment, guide] = await Promise.all([
      readFile("remote/relay/Caddyfile.tailscale.example", "utf8"),
      readFile("remote/relay/relay.env.example", "utf8"),
      readFile("remote/README.md", "utf8"),
    ]);
    expect(caddy).toContain("@relay path /remote");
    expect(caddy).toContain("reverse_proxy @relay 127.0.0.1:8787");
    expect(caddy).toContain("connect-src wss:");
    expect(caddy).toContain("frame-ancestors 'none'");
    expect(caddy).toContain("Referrer-Policy \"no-referrer\"");
    expect(environment).toContain("INERTIA_REMOTE_RELAY_STATE_DIR=");
    expect(environment).toContain("INERTIA_REMOTE_ALLOWED_ORIGINS=https://");
    expect(environment).not.toContain("ALLOW_LEGACY_REGISTRATION=1");
    expect(guide).toContain("tailscale serve --bg http://127.0.0.1:8080");
    expect(guide).toMatch(/do not\s+use Tailscale Funnel/u);
  });

  it("adds checksummed remote artifacts to the exact-tag release pipeline", async () => {
    const [workflow, releaseAssets, artifactBuilder] = await Promise.all([
      readFile(".github/workflows/release-platforms.yml", "utf8"),
      readFile("scripts/release-assets.mjs", "utf8"),
      readFile("scripts/remote-artifacts.mjs", "utf8"),
    ]);
    expect(workflow).toContain("npm run build:remote-artifacts");
    expect(workflow).toContain("npm run verify:remote-artifacts");
    expect(releaseAssets).toContain("REMOTE-SHA256SUMS.txt");
    expect(artifactBuilder).toContain("Caddyfile.tailscale.example");
    expect(artifactBuilder).toContain("relay.env.example");
  });
});
