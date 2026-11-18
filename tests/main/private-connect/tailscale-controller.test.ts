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
const identity = { endpointId: "11111111-1111-4111-8111-111111111111" };

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
      fetch: async () => new Response(JSON.stringify({ product: "Inertia Private Connect", protocol: { minimum: 1, maximum: 1 }, endpointId: identity.endpointId }), { status: 200 }),
    });
    const ready = await controller.ensurePrivateServe(41000, 8443, identity);
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

  it("leaves a Serve port that still points at an earlier gateway alone and maps a free port instead", async () => {
    let serve = JSON.stringify({ Web: { "desktop.example.ts.net:8443": { "/": { Proxy: "http://127.0.0.1:42000" } } } });
    const command = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "status") return { stdout: status, stderr: "", code: 0 };
      if (args[0] === "serve" && args[1] === "status") return { stdout: serve, stderr: "", code: 0 };
      if (args[0] === "serve" && args[1] === "--bg") {
        serve = JSON.stringify({ Web: {
          "desktop.example.ts.net:8443": { "/": { Proxy: "http://127.0.0.1:42000" } },
          "desktop.example.ts.net:9443": { "/": { Proxy: "http://127.0.0.1:41000" } },
        } });
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    });
    const controller = new PrivateConnectTailscaleController({
      discover: async () => "tailscale",
      command,
      fetch: async () => new Response(JSON.stringify({ product: "Inertia Private Connect", protocol: { minimum: 1, maximum: 1 } }), { status: 200 }),
    });
    const ready = await controller.ensurePrivateServe(41000, 8443);
    expect(ready.servePort).toBe(9443);
    expect(command).toHaveBeenCalledWith("tailscale", ["serve", "--bg", "--yes", "--https=9443", "http://127.0.0.1:41000"]);
    expect(command).not.toHaveBeenCalledWith("tailscale", ["serve", "--bg", "--yes", "--https=8443", "http://127.0.0.1:41000"]);
  });

  it("rejects a matching-product endpoint belonging to a different gateway instance", async () => {
    const controller = new PrivateConnectTailscaleController({
      discover: async () => "tailscale",
      command: vi.fn(async (_executable, args: readonly string[]) => ({ stdout: args[0] === "status" ? status : mapping, stderr: "", code: 0 })),
      fetch: async () => new Response(JSON.stringify({ product: "Inertia Private Connect", protocol: { minimum: 1, maximum: 1 }, endpointId: "33333333-3333-4333-8333-333333333333" }), { status: 200 }),
    });
    await expect(controller.ensurePrivateServe(41000, 8443, identity)).rejects.toMatchObject({ classification: "endpoint-unreachable" });
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

  it("records ownership before Tailscale Serve runs so a crash leaves recoverable proof", async () => {
    const order: string[] = [];
    let serve = JSON.stringify({ Web: {} });
    const command = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "status") return { stdout: status, stderr: "", code: 0 };
      if (args[0] === "serve" && args[1] === "status") return { stdout: serve, stderr: "", code: 0 };
      order.push("serve");
      serve = mapping;
      return { stdout: "", stderr: "", code: 0 };
    });
    const controller = new PrivateConnectTailscaleController({
      discover: async () => "tailscale",
      command,
      fetch: async () => new Response(JSON.stringify({ product: "Inertia Private Connect", protocol: { minimum: 1, maximum: 1 }, endpointId: identity.endpointId }), { status: 200 }),
    });
    await controller.ensurePrivateServe(41000, 8443, identity, async (ownership) => {
      order.push(`persist:${ownership.port}:${ownership.target}`);
    });
    expect(order).toEqual(["persist:8443:http://127.0.0.1:41000", "serve"]);

    const refused = new PrivateConnectTailscaleController({ discover: async () => "tailscale", command });
    serve = JSON.stringify({ Web: {} });
    order.length = 0;
    await expect(refused.ensurePrivateServe(41000, 8443, identity, async () => { throw new Error("storage failed"); })).rejects.toThrow("storage failed");
    expect(order).toEqual([]);
  });

  it("reports whether disabling removed the mapping, found it absent, or left a changed mapping alone", async () => {
    let serve = mapping;
    const command = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "serve" && args[1] === "status") return { stdout: serve, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    });
    const controller = new PrivateConnectTailscaleController({ discover: async () => "tailscale", command });
    const proof = { port: 8443, target: "http://127.0.0.1:41000" };

    await expect(controller.disableOwnedServe(null, proof)).resolves.toBe("removed");
    expect(command).toHaveBeenCalledWith("tailscale", ["serve", "--https=8443", "off"]);

    command.mockClear();
    serve = JSON.stringify({ Web: {} });
    await expect(controller.disableOwnedServe(null, proof)).resolves.toBe("absent");
    await expect(controller.disableOwnedServe(null, null)).resolves.toBe("absent");
    expect(command).not.toHaveBeenCalledWith("tailscale", ["serve", "--https=8443", "off"]);

    serve = JSON.stringify({ Web: { "desktop.example.ts.net:8443": { "/": { Proxy: "http://127.0.0.1:42000" } } } });
    await expect(controller.disableOwnedServe(null, proof)).rejects.toMatchObject({ classification: "mapping-ownership-lost" });
    expect(command).not.toHaveBeenCalledWith("tailscale", ["serve", "--https=8443", "off"]);
  });

  it("surfaces a failed removal so the caller keeps the gateway port held", async () => {
    const command = vi.fn(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "serve" && args[1] === "status") return { stdout: mapping, stderr: "", code: 0 };
      throw new TailscaleCommandError("command-timeout", "timed out", "", "");
    });
    const controller = new PrivateConnectTailscaleController({ discover: async () => "tailscale", command });
    await expect(controller.disableOwnedServe(null, { port: 8443, target: "http://127.0.0.1:41000" })).rejects.toMatchObject({ classification: "command-timeout" });
  });
});
