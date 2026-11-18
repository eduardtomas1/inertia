import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PrivateConnectService } from "../../../src/main/private-connect/service";
import type { PersistedPrivateConnect, PrivateConnectStore } from "../../../src/main/private-connect/store";
import {
  PrivateConnectTailscaleError,
  type PrivateConnectServeProof,
  type PrivateConnectTailscaleController,
} from "../../../src/main/private-connect/tailscale-controller";
import { parsePrivateConnectPairingFragment } from "../../../src/shared/private-connect/pairing-link";

const projectId = "11111111-1111-4111-8111-111111111111";
const deviceId = "22222222-2222-4222-8222-222222222222";
const browserNonce = "a".repeat(43);
const directories: string[] = [];
const services: PrivateConnectService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown().catch(() => undefined);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

type DisableBehaviour = "removed" | "absent" | "fail" | "changed";

function memoryStore(initial: PersistedPrivateConnect | null = null) {
  let state = initial ? structuredClone(initial) : null;
  return {
    store: {
      available: () => true,
      load: async () => state,
      save: async (next: PersistedPrivateConnect) => { state = structuredClone(next); },
    } as unknown as PrivateConnectStore,
    saved: () => state,
  };
}

function controllableTailscale() {
  const control = {
    disable: "removed" as DisableBehaviour,
    ensureFailure: null as Error | null,
    ensureCalls: [] as unknown[][],
    disableCalls: [] as [number | null, PrivateConnectServeProof | null | undefined][],
  };
  const tailscale = {
    ensurePrivateServe: async (...args: unknown[]) => {
      control.ensureCalls.push(args);
      const gatewayPort = args[0] as number;
      const ownership = { port: 8443, gatewayPort, target: `http://127.0.0.1:${gatewayPort}` };
      const beforeServe = args[3] as ((value: typeof ownership) => Promise<void>) | undefined;
      await beforeServe?.(ownership);
      if (control.ensureFailure) throw control.ensureFailure;
      return {
        status: { backendState: "Running", connected: true, dnsName: "desktop.example.ts.net", tailnetLabel: "example", addresses: ["100.64.0.2"] },
        servePort: 8443,
        gatewayPort,
        externalUrl: "https://desktop.example.ts.net:8443/",
        ownership,
      };
    },
    disableOwnedServe: async (gatewayPort: number | null, proof?: PrivateConnectServeProof | null) => {
      control.disableCalls.push([gatewayPort, proof]);
      if (control.disable === "fail") throw new PrivateConnectTailscaleError("command-timeout", "Tailscale did not answer.");
      if (control.disable === "changed") throw new PrivateConnectTailscaleError("mapping-ownership-lost", "Changed.");
      return control.disable;
    },
  } as unknown as PrivateConnectTailscaleController;
  return { tailscale, control };
}

async function createService(
  memory: ReturnType<typeof memoryStore>,
  tailscale: PrivateConnectTailscaleController,
): Promise<PrivateConnectService> {
  const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-serve-removal-"));
  directories.push(directory);
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>static-shell-sentinel</title>");
  writeFileSync(join(directory, "service-worker.js"), "self.registration;");
  const service = await PrivateConnectService.create({
    store: memory.store,
    runtime: { privateConnectRequest: async (_subject, request) => ({ type: "response", requestId: request.requestId, ok: false, code: "unavailable", message: "fixture" }) },
    staticRoot: directory,
    buildVersion: "test",
    tailscale,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
    serveRemovalRetryMs: 20,
  });
  services.push(service);
  return service;
}

async function pair(service: PrivateConnectService): Promise<string> {
  const invitation = await service.createInvitation();
  const started = await service.pairStart({
    browserNonce,
    invitation: parsePrivateConnectPairingFragment(new URL(invitation.url).hash)!,
    deviceId,
    deviceLabel: "Phone",
  }, "example");
  await service.approvePairing(started.requestId, "collaborate", [projectId]);
  const approved = await service.pairStatus(started.requestId, browserNonce);
  if (approved.status !== "approved") throw new Error("pairing did not approve");
  return approved.cookie.match(/^[^=]+=([^;]+)/u)?.[1] ?? "";
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; setCookie: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body, setCookie: response.headers["set-cookie"] }));
    });
    request.once("error", reject);
    request.end();
  });
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: "127.0.0.1", port }, () => probe.close(() => resolve(true)));
  });
}

async function expectQuarantined(port: number, cookie: string): Promise<void> {
  const responses = await Promise.all([
    get(port, "/"),
    get(port, "/service-worker.js", { "Service-Worker": "script" }),
    get(port, "/.well-known/inertia/private-connect"),
    get(port, "/api/session/csrf", { Cookie: `__Host-inertia-private-connect=${cookie}` }),
  ]);
  for (const response of responses) {
    expect(response.status).toBe(503);
    expect(response.body).not.toContain("static-shell-sentinel");
    expect(response.body).not.toContain("self.registration");
    expect(response.body).not.toContain("csrf\"");
    expect(response.setCookie).toBeUndefined();
  }
  await expect(new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?ticket=x`, { headers: { Host: `127.0.0.1:${port}`, Origin: `https://127.0.0.1:${port}` } });
    socket.once("open", () => { socket.close(); resolve("open"); });
    socket.once("error", reject);
  })).rejects.toBeInstanceOf(Error);
}

async function readyFixture() {
  const memory = memoryStore();
  const { tailscale, control } = controllableTailscale();
  const service = await createService(memory, tailscale);
  await service.setEnabled(true);
  const cookie = await pair(service);
  const port = service.state().diagnostics.gatewayPort;
  if (!port) throw new Error("Private Connect was not ready");
  return { memory, service, control, cookie, port };
}

describe("Private Connect Serve removal failures", () => {
  it.each(["disable", "lock"] as const)("keeps the gateway port bound and answering 503 when %s cannot remove the mapping", async (change) => {
    const f = await readyFixture();
    expect((await get(f.port, "/api/session/csrf", { Cookie: `__Host-inertia-private-connect=${f.cookie}` })).status).toBe(200);
    f.control.disable = "fail";

    if (change === "disable") await f.service.setEnabled(false);
    else await f.service.setPrivacyLocked(true);

    expect(await portIsFree(f.port)).toBe(false);
    await expectQuarantined(f.port, f.cookie);
    expect(f.service.state()).toMatchObject({
      externalUrl: null,
      notice: expect.stringContaining("keeping the local gateway port closed"),
      diagnostics: { gatewayPort: null, mappingOwnership: "owned" },
    });
    expect(f.memory.saved()).toMatchObject({ servePort: 8443, serveTarget: `http://127.0.0.1:${f.port}` });
    const attempts = f.control.disableCalls.length;
    await vi.waitFor(() => expect(f.control.disableCalls.length).toBeGreaterThan(attempts + 1));
    expect(await portIsFree(f.port)).toBe(false);

    f.control.disable = "removed";
    await vi.waitFor(async () => expect(await portIsFree(f.port)).toBe(true));
    expect(f.service.state()).toMatchObject({ notice: null, diagnostics: { mappingOwnership: "missing" } });
    expect(f.memory.saved()).toMatchObject(change === "disable"
      ? { servePort: null, serveTarget: null }
      : { servePort: 8443, serveTarget: null });
  });

  it("refuses to re-enable until the earlier mapping is removed, then enables on a fresh gateway", async () => {
    const f = await readyFixture();
    f.control.disable = "fail";
    await f.service.setEnabled(false);
    const ensureCalls = f.control.ensureCalls.length;

    await expect(f.service.setEnabled(true)).rejects.toThrow("could not remove its earlier Tailscale Serve mapping");
    expect(f.control.ensureCalls).toHaveLength(ensureCalls);
    expect(f.service.state()).toMatchObject({ status: "error", externalUrl: null });
    await expectQuarantined(f.port, f.cookie);

    f.control.disable = "removed";
    await expect(f.service.setEnabled(true)).resolves.toMatchObject({ status: "ready" });
    expect(f.control.ensureCalls).toHaveLength(ensureCalls + 1);
    expect(f.control.ensureCalls.at(-1)?.slice(1, 2)).toEqual([null]);
    expect(f.service.state().diagnostics.gatewayPort).not.toBe(f.port);
  });

  it("holds a failed enable's gateway closed when its cleanup cannot remove the new mapping", async () => {
    const memory = memoryStore();
    const { tailscale, control } = controllableTailscale();
    const service = await createService(memory, tailscale);
    control.ensureFailure = new PrivateConnectTailscaleError("endpoint-unreachable", "The private HTTPS endpoint could not be verified.");
    control.disable = "fail";

    await expect(service.setEnabled(true)).rejects.toThrow("could not be verified");
    const target = memory.saved()?.serveTarget;
    const port = Number(target?.slice(target.lastIndexOf(":") + 1));
    expect(port).toBeGreaterThan(0);
    expect(await portIsFree(port)).toBe(false);
    await expectQuarantined(port, "anything");

    control.disable = "removed";
    await vi.waitFor(async () => expect(await portIsFree(port)).toBe(true));
    expect(memory.saved()).toMatchObject({ serveTarget: null });
  });

  it("releases the port when the mapping changed outside Inertia", async () => {
    const f = await readyFixture();
    f.control.disable = "changed";
    await f.service.setEnabled(false);
    expect(await portIsFree(f.port)).toBe(true);
    expect(f.service.state()).toMatchObject({ notice: expect.stringContaining("changed outside Inertia"), diagnostics: { mappingOwnership: "unrelated" } });
  });
});

describe("Private Connect stale Serve mapping from an earlier run", () => {
  async function crashedState() {
    const f = await readyFixture();
    const snapshot = structuredClone(f.memory.saved()!);
    await f.service.shutdown();
    services.splice(services.indexOf(f.service), 1);
    expect(snapshot).toMatchObject({ enabled: true, servePort: 8443, serveTarget: `http://127.0.0.1:${f.port}` });
    expect(snapshot.sessions).toHaveLength(1);
    return { snapshot, cookie: f.cookie, oldPort: f.port };
  }

  function auditDetails(memory: ReturnType<typeof memoryStore>): string[] {
    return (memory.saved()?.audit ?? []).filter((event) => event.type === "serve.ownership-warning").map((event) => event.detail);
  }

  async function holdPort(port: number) {
    const squatter = createServer((_request, response) => response.end("squatter"));
    await new Promise<void>((resolve) => squatter.listen({ host: "127.0.0.1", port }, resolve));
    return { close: () => new Promise<void>((resolve) => squatter.close(() => resolve())) };
  }

  it("removes the stale mapping at startup, keeps sessions when the earlier port bound cleanly, and enables without reusing it", async () => {
    const { snapshot, cookie, oldPort } = await crashedState();
    const memory = memoryStore(snapshot);
    const { tailscale, control } = controllableTailscale();

    const service = await createService(memory, tailscale);

    expect(control.disableCalls[0]).toEqual([null, { port: 8443, target: `http://127.0.0.1:${oldPort}` }]);
    expect(memory.saved()).toMatchObject({ servePort: 8443, serveTarget: null });
    expect(memory.saved()?.sessions).toHaveLength(1);
    expect(auditDetails(memory)).toEqual(expect.arrayContaining([
      expect.stringContaining("port was free, so browser sessions were kept"),
      expect.stringContaining("removed a Tailscale Serve mapping left by an earlier session"),
    ]));
    expect(service.state().notice).toBeNull();
    expect(await portIsFree(oldPort)).toBe(true);

    await service.startIfEnabled();
    expect(service.state()).toMatchObject({ status: "ready" });
    expect(control.ensureCalls[0]?.slice(1, 2)).toEqual([8443]);
    expect(service.session(cookie)).not.toBeNull();
  });

  it("keeps sessions when the earlier mapping is already gone", async () => {
    const { snapshot, cookie } = await crashedState();
    const memory = memoryStore(snapshot);
    const { tailscale, control } = controllableTailscale();
    control.disable = "absent";

    const service = await createService(memory, tailscale);
    await service.startIfEnabled();

    expect(service.state()).toMatchObject({ status: "ready", notice: null });
    expect(service.session(cookie)).not.toBeNull();
  });

  it("ends sessions when another process holds the earlier gateway port, then enables normally", async () => {
    const { snapshot, cookie, oldPort } = await crashedState();
    const squatter = await holdPort(oldPort);
    try {
      const memory = memoryStore(snapshot);
      const { tailscale, control } = controllableTailscale();
      const service = await createService(memory, tailscale);

      expect(memory.saved()).toMatchObject({ serveTarget: null, sessions: [] });
      expect(auditDetails(memory)).toEqual(expect.arrayContaining([
        expect.stringContaining("Another process held the local gateway port"),
      ]));
      expect(service.state().notice).toContain("paired browsers were signed out");

      await service.startIfEnabled();
      expect(service.state()).toMatchObject({ status: "ready" });
      expect(control.ensureCalls).toHaveLength(1);
      expect(service.session(cookie)).toBeNull();
      expect(service.state().devices).toMatchObject([{ id: deviceId, revokedAt: null }]);
    } finally {
      await squatter.close();
    }
  });

  it("holds the earlier gateway port closed, then turns Private Connect back on once the retry removes the mapping", async () => {
    const { snapshot, cookie, oldPort } = await crashedState();
    const memory = memoryStore(snapshot);
    const { tailscale, control } = controllableTailscale();
    control.disable = "fail";

    const service = await createService(memory, tailscale);
    expect(await portIsFree(oldPort)).toBe(false);
    await expectQuarantined(oldPort, cookie);
    expect(service.state().notice).toContain("will turn back on once it is removed");

    await expect(service.startIfEnabled()).rejects.toThrow("could not remove its earlier Tailscale Serve mapping");
    expect(control.ensureCalls).toHaveLength(0);
    expect(service.state()).toMatchObject({ status: "error", externalUrl: null });
    expect(memory.saved()).toMatchObject({ serveTarget: `http://127.0.0.1:${oldPort}` });

    control.disable = "removed";
    await vi.waitFor(() => expect(service.state()).toMatchObject({ status: "ready", notice: null }));
    expect(await portIsFree(oldPort)).toBe(true);
    expect(control.ensureCalls).toHaveLength(1);
    expect(memory.saved()).toMatchObject({ enabled: true, serveTarget: expect.not.stringMatching(`:${oldPort}$`) });
    expect(memory.saved()?.sessions).toHaveLength(1);
    expect(service.session(cookie)).not.toBeNull();
  });

  it("does not turn Private Connect on after the retry when it was off before the earlier session ended", async () => {
    const { snapshot, oldPort } = await crashedState();
    const memory = memoryStore({ ...snapshot, enabled: false });
    const { tailscale, control } = controllableTailscale();
    control.disable = "fail";

    const service = await createService(memory, tailscale);
    expect(service.state().notice).toContain("stays off while Inertia retries");
    await service.startIfEnabled();

    control.disable = "removed";
    await vi.waitFor(async () => expect(await portIsFree(oldPort)).toBe(true));
    await vi.waitFor(() => expect(service.state().notice).toBeNull());
    expect(memory.saved()).toMatchObject({ enabled: false, serveTarget: null });
    expect(control.ensureCalls).toHaveLength(0);
    expect(service.state()).toMatchObject({ enabled: false, status: "off" });
  });

  it("ends sessions and still blocks enable when another process holds the earlier gateway port and removal fails", async () => {
    const { snapshot, oldPort } = await crashedState();
    const squatter = await holdPort(oldPort);
    try {
      const memory = memoryStore(snapshot);
      const { tailscale, control } = controllableTailscale();
      control.disable = "fail";
      const service = await createService(memory, tailscale);
      expect(memory.saved()?.sessions).toEqual([]);
      await expect(service.startIfEnabled()).rejects.toThrow("could not remove its earlier Tailscale Serve mapping");
      expect(control.ensureCalls).toHaveLength(0);
      expect(service.state()).toMatchObject({ status: "error", externalUrl: null });

      control.disable = "removed";
      await vi.waitFor(() => expect(service.state()).toMatchObject({ status: "ready" }));
      expect(service.state().notice).toContain("paired browsers were signed out");
    } finally {
      await squatter.close();
    }
  });
});
