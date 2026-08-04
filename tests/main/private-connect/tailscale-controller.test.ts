import { describe, expect, it, vi } from "vitest";

import {
  PrivateConnectTailscaleController,
  PrivateConnectTailscaleError,
} from "../../../src/main/private-connect/tailscale-controller";
import { TailscaleCommandError } from "../../../src/main/private-connect/tailscale-command";

const status = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "desktop.example.ts.net.", TailnetName: "example", TailscaleIPs: ["100.64.0.2"] },
});
const mapping = JSON.stringify({
  Web: { "desktop.example.ts.net:8443": { "/": { Proxy: "http://127.0.0.1:41000" } } },
});
const identity = { hostId: "11111111-1111-4111-8111-111111111111", buildVersion: "test" };

describe("Private Connect Tailscale controller", () => {
  it("verifies and owns an exact loopback Serve mapping", async () => {
    const command = vi.fn(async (_executable: string, args: readonly string[]) => ({
      stdout: args[0] === "status" ? status : mapping,
      stderr: "",
      code: 0,
    }));
    const controller = new PrivateConnectTailscaleController({
      discover: async () => "/usr/local/bin/tailscale",
      command,
      fetch: async () => new Response(JSON.stringify({ product: "Inertia Private Connect", protocol: { minimum: 1, maximum: 1 }, hostId: identity.hostId, buildVersion: identity.buildVersion }), { status: 200 }),
    });
    const ready = await controller.ensurePrivateServe(41000, 8443, null, identity);
    expect(ready.externalUrl).toBe("https://desktop.example.ts.net:8443/");
    expect(controller.currentOwnership()).toEqual({ port: 8443, gatewayPort: 41000, target: "http://127.0.0.1:41000" });
    await controller.disableOwnedServe(41000);
    expect(controller.currentOwnership()).toBeNull();
    expect(command).toHaveBeenCalledWith("/usr/local/bin/tailscale", ["serve", "--https=8443", "off"]);
  });

  it("fails closed when Tailscale is not connected or the endpoint identity is wrong", async () => {
    const command = vi.fn(async () => ({ stdout: JSON.stringify({ BackendState: "NeedsLogin", Self: { TailscaleIPs: [] } }), stderr: "", code: 0 }));
    const controller = new PrivateConnectTailscaleController({ discover: async () => "tailscale", command });
    await expect(controller.ensurePrivateServe(41000)).rejects.toMatchObject({ classification: "logged-out" });
    const bad = new PrivateConnectTailscaleController({
      discover: async () => "tailscale",
      command: vi.fn(async (_executable, args: readonly string[]) => ({ stdout: args[0] === "status" ? status : mapping, stderr: "", code: 0 })),
      fetch: async () => new Response(JSON.stringify({ product: "not Inertia" }), { status: 200 }),
    });
    await expect(bad.ensurePrivateServe(41000, 8443)).rejects.toMatchObject({ classification: "endpoint-unreachable" });
    expect(bad).toBeInstanceOf(PrivateConnectTailscaleController);
  });

  it("surfaces a trusted consent URL from a nonzero Serve exit", async () => {
    const command = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "status") return { stdout: status, stderr: "", code: 0 };
      if (args[0] === "serve" && args[1] === "status") return { stdout: JSON.stringify({ Web: {} }), stderr: "", code: 0 };
      throw new TailscaleCommandError("unknown", "failed", "", "https://login.tailscale.com/admin/machine/consent");
    });
    const controller = new PrivateConnectTailscaleController({ discover: async () => "tailscale", command });
    await expect(controller.ensurePrivateServe(41000, 8443)).rejects.toMatchObject({ classification: "serve-consent-required", consentUrl: "https://login.tailscale.com/admin/machine/consent" });
  });

  it("reclaims the persisted Serve port when the old gateway target is still present", async () => {
    let serve = JSON.stringify({ Web: { "desktop.example.ts.net:8443": { "/": { Proxy: "http://127.0.0.1:42000" } } } });
    const command = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "status") return { stdout: status, stderr: "", code: 0 };
      if (args[0] === "serve" && args[1] === "status") return { stdout: serve, stderr: "", code: 0 };
      if (args[0] === "serve" && args[1] === "--bg") {
        serve = JSON.stringify({ Web: { "desktop.example.ts.net:8443": { "/": { Proxy: "http://127.0.0.1:41000" } } } });
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const controller = new PrivateConnectTailscaleController({
      discover: async () => "tailscale",
      command,
      fetch: async () => new Response(JSON.stringify({ product: "Inertia Private Connect", protocol: { minimum: 1, maximum: 1 } }), { status: 200 }),
    });
    await controller.ensurePrivateServe(41000, 8443, "http://127.0.0.1:42000");
    expect(command).toHaveBeenCalledWith("tailscale", ["serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:41000"]);
  });

  it("rejects a matching-product endpoint with a different stable host identity", async () => {
    const controller = new PrivateConnectTailscaleController({
      discover: async () => "tailscale",
      command: vi.fn(async (_executable, args: readonly string[]) => ({ stdout: args[0] === "status" ? status : mapping, stderr: "", code: 0 })),
      fetch: async () => new Response(JSON.stringify({ product: "Inertia Private Connect", protocol: { minimum: 1, maximum: 1 }, hostId: "33333333-3333-4333-8333-333333333333", buildVersion: "test" }), { status: 200 }),
    });
    await expect(controller.ensurePrivateServe(41000, 8443, null, identity)).rejects.toMatchObject({ classification: "endpoint-unreachable" });
  });

  it("does not overwrite a mapping that changed ownership", async () => {
    let reads = 0;
    const controller = new PrivateConnectTailscaleController({
      discover: async () => "tailscale",
      command: vi.fn(async (_executable, args: readonly string[]) => {
        if (args[0] === "status") return { stdout: status, stderr: "", code: 0 };
        reads += 1;
        return { stdout: reads === 1 ? mapping : JSON.stringify({ Web: {} }), stderr: "", code: 0 };
      }),
      fetch: async () => new Response(JSON.stringify({ product: "Inertia Private Connect" }), { status: 200 }),
    });
    await expect(controller.ensurePrivateServe(41000, 8443)).rejects.toBeInstanceOf(PrivateConnectTailscaleError);
  });
});
