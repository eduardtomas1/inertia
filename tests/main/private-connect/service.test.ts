import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateConnectService } from "../../../src/main/private-connect/service";
import type { PrivateConnectTailscaleController } from "../../../src/main/private-connect/tailscale-controller";
import type { PrivateConnectStore, PersistedPrivateConnect } from "../../../src/main/private-connect/store";
import { parsePrivateConnectPairingFragment } from "../../../src/shared/private-connect/pairing-link";

const projectId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const directories: string[] = [];
const services: PrivateConnectService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function testStore(): { store: PrivateConnectStore; saved: () => PersistedPrivateConnect | null } {
  let state: PersistedPrivateConnect | null = null;
  return {
    store: {
      available: () => true,
      load: async () => state,
      save: async (next: PersistedPrivateConnect) => { state = structuredClone(next); },
    } as unknown as PrivateConnectStore,
    saved: () => state,
  };
}

function testTailscale(): PrivateConnectTailscaleController {
  return {
    ensurePrivateServe: async (gatewayPort: number) => ({
      status: { backendState: "Running", connected: true, dnsName: "desktop.example.ts.net", tailnetLabel: "example", addresses: ["100.64.0.2"] },
      servePort: 8443,
      gatewayPort,
      externalUrl: "https://desktop.example.ts.net:8443/",
      ownership: { port: 8443, gatewayPort, target: `http://127.0.0.1:${gatewayPort}` },
    }),
    disableOwnedServe: async () => undefined,
  } as unknown as PrivateConnectTailscaleController;
}

async function createService(): Promise<PrivateConnectService> {
  const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-service-"));
  directories.push(directory);
  await mkdir(join(directory, "static"));
  await writeFile(join(directory, "static", "index.html"), "<!doctype html><title>Private Connect</title>");
  const memory = testStore();
  const service = await PrivateConnectService.create({
    store: memory.store,
    runtime: { privateConnectRequest: async (_subject, request) => ({ type: "response", requestId: request.requestId, ok: false, code: "unavailable", message: "test" }) },
    staticRoot: join(directory, "static"),
    buildVersion: "test",
    tailscale: testTailscale(),
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  services.push(service);
  return service;
}

describe("Private Connect service lifecycle", () => {
  it("enables, pairs, grants, authenticates, and revokes a browser", async () => {
    const service = await createService();
    await service.setEnabled(true);
    expect(service.state()).toMatchObject({ enabled: true, status: "ready", externalUrl: "https://desktop.example.ts.net:8443/" });
    const invitation = await service.createInvitation();
    const parsed = parsePrivateConnectPairingFragment(new URL(invitation.url).hash);
    expect(parsed).not.toBeNull();
    const started = await service.pairStart({ invitation: parsed!, deviceId, deviceLabel: "Browser" }, "example");
    await service.approvePairing(started.requestId, "collaborate", [projectId]);
    const approved = await service.pairStatus(started.requestId);
    expect(approved.status).toBe("approved");
    if (approved.status !== "approved") return;
    const cookie = approved.cookie.match(/^[^=]+=([^;]+)/u)?.[1] ?? null;
    const session = service.session(cookie);
    expect(session).not.toBeNull();
    expect(service.issueWebSocketTicket(session!)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const ping = await service.handleRequest(session!, { protocolVersion: 1, type: "client.ping", requestId: "33333333-3333-4333-8333-333333333333" });
    expect(ping).toMatchObject({ ok: true, result: { kind: "pong" } });
    await service.revokeDevice(deviceId);
    expect(service.session(cookie)).toBeNull();
  });

  it("fails closed on lock and removes owned gateway state", async () => {
    const service = await createService();
    await service.setEnabled(true);
    service.setPrivacyLocked(true);
    expect(service.state()).toMatchObject({ status: "error", externalUrl: null, diagnostics: { gatewayPort: null, mappingOwnership: "missing" } });
    await service.setEnabled(false);
    expect(service.state().status).toBe("off");
  });
});
