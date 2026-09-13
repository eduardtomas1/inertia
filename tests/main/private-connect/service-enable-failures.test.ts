import { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivateConnectGatewayServer } from "../../../src/main/private-connect/gateway-server";
import { PrivateConnectService } from "../../../src/main/private-connect/service";
import type { PrivateConnectStore } from "../../../src/main/private-connect/store";
import type { PrivateConnectTailscaleController } from "../../../src/main/private-connect/tailscale-controller";

const services: PrivateConnectService[] = [];
afterEach(async () => {
  try { for (const service of services.splice(0)) await service.shutdown(); }
  finally { vi.restoreAllMocks(); }
});

async function fixture() {
  const save = vi.fn(async () => undefined);
  const ensure = vi.fn(async (gatewayPort: number) => ({
    servePort: 8443,
    gatewayPort,
    externalUrl: "https://desktop.example.ts.net:8443/",
    ownership: { port: 8443, gatewayPort, target: `http://127.0.0.1:${gatewayPort}` },
  }));
  const disable = vi.fn(async () => undefined);
  const changed = vi.fn();
  const service = await PrivateConnectService.create({
    store: { available: () => true, load: async () => null, save } as unknown as PrivateConnectStore,
    tailscale: { ensurePrivateServe: ensure, disableOwnedServe: disable } as unknown as PrivateConnectTailscaleController,
    runtime: { privateConnectRequest: async (_subject, request) => ({
      type: "response", requestId: request.requestId, ok: false, code: "unavailable", message: "Fixture",
    }) },
    staticRoot: ".", buildVersion: "fixture", onStateChange: changed,
  });
  services.push(service);
  return { service, save, ensure, disable, changed };
}

describe("Private Connect startup failure ownership", () => {
  it.each(["storage", "listen"])("settles %s failure and allows update preparation and a fresh retry", async (stage) => {
    const f = await fixture();
    const error = new Error(`simulated ${stage} failure`);
    if (stage === "storage") f.save.mockRejectedValueOnce(error);
    else vi.spyOn(Server.prototype, "listen").mockImplementationOnce(function (this: Server) {
      queueMicrotask(() => this.emit("error", error));
      return this;
    });
    const stop = vi.spyOn(PrivateConnectGatewayServer.prototype, "stop");

    await expect(f.service.setEnabled(true)).rejects.toBe(error);
    expect.soft(f.service.state()).toMatchObject({
      enabled: false, status: "error", externalUrl: null,
      diagnostics: { gatewayPort: null, externalUrl: null, errorClass: "unknown" },
    });
    expect.soft(f.changed).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
    expect.soft(stop).toHaveBeenCalledOnce();
    expect(f.ensure).not.toHaveBeenCalled();
    // No Serve operation was admitted, so cleanup must not remove a prior mapping.
    expect(f.disable).not.toHaveBeenCalled();
    await expect.soft(f.service.prepareForUpdate()).resolves.toBe(true);
    await f.service.releaseUpdatePreparation();

    await expect(f.service.setEnabled(true)).resolves.toMatchObject({ status: "ready" });
    expect(f.ensure).toHaveBeenCalledOnce();
    expect(f.service.state().diagnostics.gatewayPort).toBeGreaterThan(0);
  });

  it("cleans the exact admitted gateway when persisting ready state fails", async () => {
    const f = await fixture();
    const error = new Error("simulated ready-state persistence failure");
    f.save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(error);
    const stop = vi.spyOn(PrivateConnectGatewayServer.prototype, "stop");

    await expect(f.service.setEnabled(true)).rejects.toBe(error);
    const port = f.ensure.mock.calls[0]?.[0];
    expect(port).toBeGreaterThan(0);
    expect(f.disable).toHaveBeenCalledExactlyOnceWith(port);
    expect(stop).toHaveBeenCalledOnce();
    const gateway = stop.mock.contexts[0];
    if (!(gateway instanceof PrivateConnectGatewayServer)) throw new Error("The failed gateway was not stopped");
    expect(gateway.address()).toBeNull();
    expect(f.service.state()).toMatchObject({
      status: "error", externalUrl: null,
      diagnostics: { gatewayPort: null, externalUrl: null },
    });
    await expect(f.service.prepareForUpdate()).resolves.toBe(true);
  });
});
