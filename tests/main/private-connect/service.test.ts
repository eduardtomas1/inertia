import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";

import { afterEach, describe, expect, it } from "vitest";

import { PrivateConnectService, type PrivateConnectServiceOptions } from "../../../src/main/private-connect/service";
import type { PrivateConnectTailscaleController } from "../../../src/main/private-connect/tailscale-controller";
import type { PrivateConnectStore, PersistedPrivateConnect } from "../../../src/main/private-connect/store";
import { parsePrivateConnectPairingFragment } from "../../../src/shared/private-connect/pairing-link";
import { PRIVATE_CONNECT_LIMITS, PRIVATE_CONNECT_SOCKET_CLOSE, privateConnectConversationDetailSchema, type PrivateConnectStateView } from "../../../src/shared/private-connect/protocol";
import { privateConnectRuntimeRequestSchema } from "../../../src/shared/private-connect/runtime-contract";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherProjectId = "99999999-9999-4999-8999-999999999999";
const deviceId = "22222222-2222-4222-8222-222222222222";
const directories: string[] = [];
const services: PrivateConnectService[] = [];

function requestStatus(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/.well-known/inertia/private-connect", headers: { Host: host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function testStore(initial: PersistedPrivateConnect | null = null): { store: PrivateConnectStore; saved: () => PersistedPrivateConnect | null; failNextSave: () => void } {
  let state: PersistedPrivateConnect | null = initial;
  let rejectNextSave = false;
  return {
    store: {
      available: () => true,
      load: async () => state,
      save: async (next: PersistedPrivateConnect) => {
        if (rejectNextSave) {
          rejectNextSave = false;
          throw new Error("simulated persistence failure");
        }
        state = structuredClone(next);
      },
    } as unknown as PrivateConnectStore,
    saved: () => state,
    failNextSave: () => { rejectNextSave = true; },
  };
}

function testTailscale(calls?: { ensure: unknown[][]; disable: number[] }): PrivateConnectTailscaleController {
  return {
    ensurePrivateServe: async (...args: unknown[]) => {
      calls?.ensure.push(args);
      const gatewayPort = args[0] as number;
      return {
      status: { backendState: "Running", connected: true, dnsName: "desktop.example.ts.net", tailnetLabel: "example", addresses: ["100.64.0.2"] },
      servePort: 8443,
      gatewayPort,
      externalUrl: "https://desktop.example.ts.net:8443/",
      ownership: { port: 8443, gatewayPort, target: `http://127.0.0.1:${gatewayPort}` },
      };
    },
    disableOwnedServe: async () => { calls?.disable.push(1); },
  } as unknown as PrivateConnectTailscaleController;
}

async function createServiceWith(
  memory = testStore(),
  tailscale = testTailscale(),
  runtimeOverrides: Partial<PrivateConnectServiceOptions["runtime"]> = {},
  now: () => Date = () => new Date("2030-01-01T00:00:00.000Z"),
  onStateChange?: PrivateConnectServiceOptions["onStateChange"],
): Promise<PrivateConnectService> {
  const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-service-"));
  directories.push(directory);
  await mkdir(join(directory, "static"));
  await writeFile(join(directory, "static", "index.html"), "<!doctype html><title>Private Connect</title>");
  const service = await PrivateConnectService.create({
    store: memory.store,
    runtime: {
      privateConnectRequest: async (_subject, request) => {
        privateConnectRuntimeRequestSchema.parse(request);
        if (request.type === "state.get") return {
          type: "response", requestId: request.requestId, ok: true,
          result: {
            kind: "state",
            validator: "A".repeat(43),
            state: {
              generatedAt: "2030-01-01T00:00:00.000Z",
              projects: [{ id: projectId, name: "Project" }],
              conversations: [{ id: "44444444-4444-4444-8444-444444444444", projectId, title: "Conversation", providerLabel: "Test", runId: null, status: "idle", pendingLocalApproval: false, promptSafety: { supported: false, headline: "Unavailable", explanation: "Desktop-only." }, updatedAt: "2030-01-01T00:00:00.000Z" }],
              runs: [],
            },
          },
        };
        if (request.type === "conversation.get") return {
          type: "response", requestId: request.requestId, ok: true,
          result: {
            kind: "conversation",
            validator: "B".repeat(43),
            detail: {
              generatedAt: "2030-01-01T00:00:00.000Z",
              conversation: { id: request.conversationId, projectId, title: "Conversation", providerLabel: "Test", runId: null, status: "idle", pendingLocalApproval: false, promptSafety: { supported: false, headline: "Unavailable", explanation: "Desktop-only." }, updatedAt: "2030-01-01T00:00:00.000Z" },
              messages: [], activities: [], subagents: [], questions: [], waitingForLocalAction: false,
            },
          },
        };
        return { type: "response", requestId: request.requestId, ok: false, code: "unavailable", message: "test" };
      },
      ...runtimeOverrides,
    },
    staticRoot: join(directory, "static"),
    buildVersion: "test",
    tailscale,
    now,
    onStateChange,
  });
  services.push(service);
  return service;
}

async function createService(): Promise<PrivateConnectService> { return await createServiceWith(); }

describe("Private Connect service lifecycle", () => {
  it("rejoins a pending pairing when the browser retries the same invitation", async () => {
    const service = await createService();
    await service.setEnabled(true);
    const invitation = await service.createInvitation();
    const request = {
      invitation: parsePrivateConnectPairingFragment(new URL(invitation.url).hash)!,
      deviceId,
      deviceLabel: "Browser",
    };

    const started = await service.pairStart(request, "example");

    await expect(service.pairStart(request, "example")).resolves.toEqual(started);
    expect(service.state().pendingPairings).toHaveLength(1);
  });

  it("removes directional controls from untrusted device labels", async () => {
    const service = await createService();
    await service.setEnabled(true);
    const invitation = await service.createInvitation();

    await service.pairStart({
      invitation: parsePrivateConnectPairingFragment(new URL(invitation.url).hash)!,
      deviceId,
      deviceLabel: "Browser\u202Ecod.exe",
    }, "example");

    expect(service.state().pendingPairings[0]?.deviceLabel).toBe("Browser cod.exe");
  });

  it("does not expose an approved browser session before its grant is durable", async () => {
    const memory = testStore();
    const service = await createServiceWith(memory);
    await service.setEnabled(true);
    const invitation = await service.createInvitation();
    const started = await service.pairStart({
      invitation: parsePrivateConnectPairingFragment(new URL(invitation.url).hash)!,
      deviceId,
      deviceLabel: "Browser",
    }, "example");
    memory.failNextSave();

    await expect(service.approvePairing(started.requestId, "collaborate", [projectId]))
      .rejects.toThrow("simulated persistence failure");
    await expect(service.pairStatus(started.requestId)).resolves.toMatchObject({
      status: "pending",
    });
    expect(service.state().devices).toEqual([]);
    expect(memory.saved()?.devices).toEqual([]);

    await service.approvePairing(started.requestId, "collaborate", [projectId], 30, [
      { projectId, conversationIds: ["allowed-conversation"], includeFutureConversations: false },
      { projectId: otherProjectId, conversationIds: [], includeFutureConversations: true },
    ]);
    expect(service.state().devices[0]).toMatchObject({
      projectIds: [projectId],
      grants: [{ projectId, conversationIds: ["allowed-conversation"], includeFutureConversations: false }],
    });
    await expect(service.pairStatus(started.requestId)).resolves.toMatchObject({
      status: "approved",
    });
  });

  it("expires an approved invitation that the browser never collects", async () => {
    let currentTime = Date.parse("2030-01-01T00:00:00.000Z");
    const service = await createServiceWith(
      testStore(),
      testTailscale(),
      {},
      () => new Date(currentTime),
    );
    await service.setEnabled(true);
    const invitation = await service.createInvitation();
    const started = await service.pairStart({
      invitation: parsePrivateConnectPairingFragment(new URL(invitation.url).hash)!,
      deviceId,
      deviceLabel: "Browser",
    }, "example");
    await service.approvePairing(started.requestId, "monitor", [projectId]);
    currentTime = Date.parse(invitation.expiresAt) + 1;

    await expect(service.pairStatus(started.requestId)).resolves.toEqual({
      status: "expired",
      requestId: started.requestId,
    });
    await expect(service.createInvitation()).resolves.toMatchObject({
      expiresAt: expect.any(String),
    });
  });

  it("gives a late approval its own collection window instead of the invitation deadline", async () => {
    let currentTime = Date.parse("2030-01-01T00:00:00.000Z");
    const service = await createServiceWith(
      testStore(),
      testTailscale(),
      {},
      () => new Date(currentTime),
    );
    await service.setEnabled(true);
    const invitation = await service.createInvitation();
    const started = await service.pairStart({
      invitation: parsePrivateConnectPairingFragment(new URL(invitation.url).hash)!,
      deviceId,
      deviceLabel: "Browser",
    }, "example");
    currentTime = Date.parse(invitation.expiresAt) - 1_000;
    await service.approvePairing(started.requestId, "monitor", [projectId]);

    currentTime = Date.parse(invitation.expiresAt) + 5_000;
    const collected = await service.pairStatus(started.requestId);
    expect(collected.status).toBe("approved");
    expect(collected).toHaveProperty("cookie");

    currentTime += PRIVATE_CONNECT_LIMITS.pairingCollectionMs;
    await expect(service.pairStatus(started.requestId)).rejects.toThrow();
  });

  it("adapts runtime projections into exactly the contract the packaged client parses", async () => {
    const providerQuestionId = "toolu_01AbCdEfGhIjKlMnOpQrStUv:question:1";
    const inputRequestId = "88888888-8888-4888-8888-888888888888";
    const conversationId = "44444444-4444-4444-8444-444444444444";
    const service = await createServiceWith(testStore(), testTailscale(), {
      privateConnectRequest: async (_subject, request) => {
        privateConnectRuntimeRequestSchema.parse(request);
        return {
          type: "response", requestId: request.requestId, ok: true,
          result: {
            kind: "conversation",
            validator: "B".repeat(43),
            detail: {
              generatedAt: "2030-01-01T00:00:00.000Z",
              conversation: { id: conversationId, projectId, title: "Conversation", providerLabel: "Test", runId: null, status: "needs-input", pendingLocalApproval: false, promptSafety: { supported: true, headline: "Supported", explanation: "Supervised." }, updatedAt: "2030-01-01T00:00:00.000Z" },
              messages: [], activities: [], subagents: [],
              plan: { steps: [{ label: "Investigate", status: "inProgress" }] },
              inputRequestId,
              questions: [{
                id: providerQuestionId,
                label: "Which branch?",
                options: [{ id: "main", label: "main" }],
                allowMultiple: false,
                allowCustomAnswer: true,
              }],
              waitingForLocalAction: false,
            },
          },
        };
      },
    });
    await service.setEnabled(true);
    const invitation = await service.createInvitation();
    const started = await service.pairStart({
      invitation: parsePrivateConnectPairingFragment(new URL(invitation.url).hash)!,
      deviceId,
      deviceLabel: "Browser",
    }, "example");
    await service.approvePairing(started.requestId, "collaborate", [projectId]);
    const approved = await service.pairStatus(started.requestId);
    if (approved.status !== "approved") throw new Error("pairing was not approved");
    const session = service.session(approved.cookie.match(/^[^=]+=([^;]+)/u)?.[1] ?? null);

    const response = await service.handleRequest(session!, {
      protocolVersion: 1,
      type: "conversation.get",
      requestId: "55555555-5555-4555-8555-555555555555",
      conversationId,
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const detail = (response.result as { detail: unknown }).detail;
    const parsed = privateConnectConversationDetailSchema.safeParse(detail);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.questions[0]).toMatchObject({
      id: providerQuestionId,
      allowCustomAnswer: true,
    });
    expect(parsed.data.inputRequestId).toBe(inputRequestId);
  });

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
    const port = service.state().diagnostics.gatewayPort;
    if (!port) throw new Error("gateway did not start");
    expect(await requestStatus(port, "desktop.example.ts.net:8443")).toBe(200);
    expect(await requestStatus(port, "other.example.ts.net:8443")).toBe(400);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws?ticket=${encodeURIComponent(service.issueWebSocketTicket(session!))}`, { headers: { Host: `127.0.0.1:${port}`, Origin: `https://127.0.0.1:${port}` } });
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    expect(service.state().activeSessions).toBe(1);
    const closed = new Promise<number>((resolve) => socket.once("close", (code: number) => resolve(code)));
    const ping = await service.handleRequest(session!, { protocolVersion: 1, type: "client.ping", requestId: "33333333-3333-4333-8333-333333333333" });
    expect(ping).toMatchObject({ ok: true, result: { kind: "pong" } });
    const state = await service.handleRequest(session!, { protocolVersion: 1, type: "state.get", requestId: "55555555-5555-4555-8555-555555555555" });
    expect(state).toMatchObject({ ok: true, result: { kind: "state", validator: "A".repeat(43), state: { capabilities: { scopes: ["private:read", "private:prompt", "private:input", "private:stop"], preset: "collaborate" } } } });
    await expect(service.handleRequest(session!, {
      protocolVersion: 1,
      type: "input.respond",
      requestId: "66666666-6666-4666-8666-666666666666",
      conversationId: "44444444-4444-4444-8444-444444444444",
      inputRequestId: "77777777-7777-4777-8777-777777777777",
      answers: { choice: ["yes"] },
    })).resolves.toMatchObject({ ok: false, code: "unavailable" });
    await expect(service.handleRequest(session!, {
      protocolVersion: 1,
      type: "run.stop",
      requestId: "88888888-8888-4888-8888-888888888888",
      conversationId: "44444444-4444-4444-8444-444444444444",
      runId: "run-1",
    })).resolves.toMatchObject({ ok: false, code: "unavailable" });
    await service.revokeDevice(deviceId);
    expect(service.session(cookie)).toBeNull();
    await expect(closed).resolves.toBe(
      PRIVATE_CONNECT_SOCKET_CLOSE.accessRevoked,
    );
    await expect.poll(() => service.state().activeSessions).toBe(0);
  });

  it("fails closed on lock and removes owned gateway state", async () => {
    const service = await createService();
    await service.setEnabled(true);
    await service.setPrivacyLocked(true);
    expect(service.state()).toMatchObject({ status: "error", externalUrl: null, diagnostics: { gatewayPort: null, mappingOwnership: "missing" } });
    await service.setEnabled(false);
    expect(service.state().status).toBe("off");
  });

  it("pauses live access on lock without discarding an unexpired browser grant", async () => {
    const service = await createService();
    await service.setEnabled(true);
    const invitation = await service.createInvitation();
    const parsed = parsePrivateConnectPairingFragment(new URL(invitation.url).hash);
    const started = await service.pairStart({
      invitation: parsed!,
      deviceId,
      deviceLabel: "Browser",
    }, "example");
    await service.approvePairing(started.requestId, "monitor", [projectId]);
    const approved = await service.pairStatus(started.requestId);
    if (approved.status !== "approved") throw new Error("pairing did not approve");
    const cookie = approved.cookie.match(/^[^=]+=([^;]+)/u)?.[1] ?? "";
    const session = service.session(cookie);
    const port = service.state().diagnostics.gatewayPort;
    if (!session || !port) throw new Error("Private Connect was not ready");
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws?ticket=${encodeURIComponent(service.issueWebSocketTicket(session))}`,
      { headers: { Host: `127.0.0.1:${port}`, Origin: `https://127.0.0.1:${port}` } },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code: number) => resolve(code))
    );

    await service.setPrivacyLocked(true);
    await expect(closed).resolves.toBe(
      PRIVATE_CONNECT_SOCKET_CLOSE.hostUnavailable,
    );
    expect(service.session(cookie)).toBeNull();
    expect(service.state()).toMatchObject({
      status: "error",
      activeSessions: 0,
      devices: [{ id: deviceId, revokedAt: null }],
    });

    await service.setPrivacyLocked(false);
    expect(service.state()).toMatchObject({ status: "ready" });
    expect(service.session(cookie)).not.toBeNull();
  });

  it("keeps persisted access closed when starting locked and resumes after unlock", async () => {
    const memory = testStore();
    const first = await createServiceWith(memory);
    await first.setEnabled(true);
    await first.shutdown();
    const calls = { ensure: [] as unknown[][], disable: [] as number[] };
    const second = await createServiceWith(memory, testTailscale(calls));
    await second.setPrivacyLocked(true);
    await expect(second.startIfEnabled()).rejects.toThrow("paused while the desktop is locked");
    expect(calls.ensure).toHaveLength(0);
    expect(second.state()).toMatchObject({ enabled: true, status: "error", externalUrl: null });
    await second.setPrivacyLocked(false);
    expect(calls.ensure).toHaveLength(1);
    expect(second.state()).toMatchObject({ enabled: true, status: "ready" });
  });

  it("cancels an in-progress startup before a queued lock cleanup can run", async () => {
    let releaseEnsure!: () => void;
    let reportEnsureEntered!: () => void;
    const ensureEntered = new Promise<void>((resolve) => { reportEnsureEntered = resolve; });
    const ensureReleased = new Promise<void>((resolve) => { releaseEnsure = resolve; });
    const observed: PrivateConnectStateView[] = [];
    const calls = { disable: 0 };
    const tailscale = {
      ensurePrivateServe: async (_gatewayPort: number) => {
        reportEnsureEntered();
        await ensureReleased;
        return {
          status: { backendState: "Running", connected: true, dnsName: "desktop.example.ts.net", tailnetLabel: "example", addresses: ["100.64.0.2"] },
          servePort: 8443,
          gatewayPort: _gatewayPort,
          externalUrl: "https://desktop.example.ts.net:8443/",
          ownership: { port: 8443, gatewayPort: _gatewayPort, target: `http://127.0.0.1:${_gatewayPort}` },
        };
      },
      disableOwnedServe: async () => { calls.disable += 1; },
    } as unknown as PrivateConnectTailscaleController;
    const service = await createServiceWith(
      testStore(),
      tailscale,
      {},
      undefined,
      (state) => observed.push(state),
    );
    const enabling = service.setEnabled(true);
    await ensureEntered;
    const locking = service.setPrivacyLocked(true);
    releaseEnsure();
    await Promise.all([enabling, locking]);
    expect(observed.some(({ status }) => status === "ready")).toBe(false);
    expect(calls.disable).toBeGreaterThan(0);
    expect(service.state()).toMatchObject({ enabled: false, status: "error", externalUrl: null });
  });

  it("reconciles persisted Serve ownership and sessions after a restart", async () => {
    const memory = testStore();
    const firstCalls = { ensure: [] as unknown[][], disable: [] as number[] };
    const first = await createServiceWith(memory, testTailscale(firstCalls));
    await first.setEnabled(true);
    const invitation = await first.createInvitation();
    const parsed = parsePrivateConnectPairingFragment(new URL(invitation.url).hash);
    const started = await first.pairStart({ invitation: parsed!, deviceId, deviceLabel: "Browser" }, "example");
    await first.approvePairing(started.requestId, "collaborate", [projectId]);
    const approved = await first.pairStatus(started.requestId);
    if (approved.status !== "approved") throw new Error("pairing did not approve");
    const cookie = approved.cookie.match(/^[^=]+=([^;]+)/u)?.[1] ?? "";
    await first.shutdown();
    expect(firstCalls.disable).toHaveLength(0);
    const secondCalls = { ensure: [] as unknown[][], disable: [] as number[] };
    const second = await createServiceWith(memory, testTailscale(secondCalls));
    await second.startIfEnabled();
    expect(second.state()).toMatchObject({ enabled: true, status: "ready" });
    expect(secondCalls.ensure[0]?.slice(0, 3)).toEqual([expect.any(Number), 8443, `http://127.0.0.1:${firstCalls.ensure[0]?.[0] as number}`]);
    expect(second.session(cookie)).not.toBeNull();
    expect(second.issueWebSocketTicket(second.session(cookie)!)).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("recovers an interrupted authority reduction before reopening access", async () => {
    const memory = testStore();
    const first = await createServiceWith(memory);
    await first.setEnabled(true);
    const invitation = await first.createInvitation();
    const parsed = parsePrivateConnectPairingFragment(new URL(invitation.url).hash);
    const started = await first.pairStart({
      invitation: parsed!,
      deviceId,
      deviceLabel: "Browser",
    }, "example");
    await first.approvePairing(started.requestId, "collaborate", [projectId]);
    const approved = await first.pairStatus(started.requestId);
    if (approved.status !== "approved") throw new Error("pairing did not approve");
    const cookie = approved.cookie.match(/^[^=]+=([^;]+)/u)?.[1] ?? "";
    await first.shutdown();
    const persisted = memory.saved();
    if (!persisted) throw new Error("Private Connect state was not saved");
    persisted.pendingAuthorityReduction = {
      generation: persisted.grantGeneration + 1,
      createdAt: "2030-01-01T00:00:00.000Z",
    };
    const calls = { ensure: [] as unknown[][], disable: [] as number[] };

    const recovered = await createServiceWith(memory, testTailscale(calls));

    expect(recovered.state()).toMatchObject({
      enabled: false,
      status: "off",
      devices: [{ id: deviceId, revokedAt: "2030-01-01T00:00:00.000Z" }],
    });
    expect(recovered.session(cookie)).toBeNull();
    expect(calls.disable).toHaveLength(1);
    expect(memory.saved()).toMatchObject({
      enabled: false,
      servePort: null,
      serveTarget: null,
      sessions: [],
      pendingAuthorityReduction: null,
    });
  });

  it("applies an edited grant immediately and lets the same browser reconnect", async () => {
    const service = await createService();
    await service.setEnabled(true);
    const invitation = await service.createInvitation();
    const parsed = parsePrivateConnectPairingFragment(new URL(invitation.url).hash);
    const started = await service.pairStart({
      invitation: parsed!,
      deviceId,
      deviceLabel: "Browser",
    }, "example");
    await service.approvePairing(started.requestId, "collaborate", [projectId]);
    const approved = await service.pairStatus(started.requestId);
    if (approved.status !== "approved") throw new Error("pairing did not approve");
    const cookie = approved.cookie.match(/^[^=]+=([^;]+)/u)?.[1] ?? "";
    const session = service.session(cookie);
    const port = service.state().diagnostics.gatewayPort;
    if (!session || !port) throw new Error("Private Connect was not ready");
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/api/ws?ticket=${encodeURIComponent(service.issueWebSocketTicket(session))}`,
      { headers: { Host: `127.0.0.1:${port}`, Origin: `https://127.0.0.1:${port}` } },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code: number) => resolve(code))
    );

    await service.updateDevice(
      deviceId,
      "monitor",
      [projectId],
      "2030-01-15T00:00:00.000Z",
      [{ projectId: otherProjectId, conversationIds: [], includeFutureConversations: true }],
    );

    expect(service.state().devices[0]).toMatchObject({
      projectIds: [projectId],
      grants: [{ projectId, conversationIds: [], includeFutureConversations: true }],
    });

    await expect(closed).resolves.toBe(
      PRIVATE_CONNECT_SOCKET_CLOSE.authorityChanged,
    );
    const refreshed = service.session(cookie);
    expect(refreshed).not.toBeNull();
    const state = await service.handleRequest(refreshed!, {
      protocolVersion: 1,
      type: "state.get",
      requestId: "55555555-5555-4555-8555-555555555555",
    });
    expect(state).toMatchObject({
      ok: true,
      result: { kind: "state", state: { capabilities: { preset: "monitor" } } },
    });
  });

  it("drains an admitted mutation before reducing authority and blocks new work", async () => {
    let releaseStop: () => void = () => undefined;
    let stopEntered = false;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const service = await createServiceWith(testStore(), testTailscale(), {
      privateConnectRequest: async (_subject, request) => {
        privateConnectRuntimeRequestSchema.parse(request);
        if (request.type !== "run.stop") throw new Error("unexpected request");
        stopEntered = true;
        await stopGate;
        return {
          type: "response",
          requestId: request.requestId,
          ok: true,
          result: {
            kind: "run.stopped",
            conversationId: request.conversationId,
            runId: request.runId,
            alreadyStopped: false,
          },
        };
      },
    });
    await service.setEnabled(true);
    const invitation = await service.createInvitation();
    const parsed = parsePrivateConnectPairingFragment(new URL(invitation.url).hash);
    const started = await service.pairStart({
      invitation: parsed!,
      deviceId,
      deviceLabel: "Browser",
    }, "example");
    await service.approvePairing(started.requestId, "collaborate", [projectId]);
    const approved = await service.pairStatus(started.requestId);
    if (approved.status !== "approved") throw new Error("pairing did not approve");
    const cookie = approved.cookie.match(/^[^=]+=([^;]+)/u)?.[1] ?? "";
    const session = service.session(cookie);
    if (!session) throw new Error("Private Connect session was unavailable");

    const stop = service.handleRequest(session, {
      protocolVersion: 1,
      type: "run.stop",
      requestId: "55555555-5555-4555-8555-555555555555",
      conversationId: "44444444-4444-4444-8444-444444444444",
      runId: "run-1",
    });
    await expect.poll(() => stopEntered).toBe(true);
    let updateFinished = false;
    const update = service.updateDevice(
      deviceId,
      "monitor",
      [projectId],
      "2030-01-15T00:00:00.000Z",
    ).finally(() => { updateFinished = true; });
    await expect.poll(() => service.session(cookie)).toBeNull();
    expect(updateFinished).toBe(false);
    await expect(service.revokeDevice(deviceId)).rejects.toThrow(
      "authority change is already in progress",
    );
    await expect(service.handleRequest(session, {
      protocolVersion: 1,
      type: "run.stop",
      requestId: "66666666-6666-4666-8666-666666666666",
      conversationId: "44444444-4444-4444-8444-444444444444",
      runId: "run-2",
    })).resolves.toMatchObject({ ok: false, code: "forbidden" });

    releaseStop();
    await expect(stop).resolves.toMatchObject({
      ok: true,
      result: { kind: "run.stopped", runId: "run-1" },
    });
    await update;
    expect(service.session(cookie)).not.toBeNull();
    await expect(service.handleRequest(service.session(cookie)!, {
      protocolVersion: 1,
      type: "run.stop",
      requestId: "77777777-7777-4777-8777-777777777777",
      conversationId: "44444444-4444-4444-8444-444444444444",
      runId: "run-3",
    })).resolves.toMatchObject({ ok: false, code: "forbidden" });
  });

  it("persists prompt delivery receipts so a restart cannot replay an accepted delivery", async () => {
    const memory = testStore();
    let commits = 0;
    const runtime = {
      preparePrivateConnectPrompt: async () => ({ preparationId: "66666666-6666-4666-8666-666666666666" }),
      commitPrivateConnectPrompt: async (_subject: unknown, request: { requestId: string; deliveryId: string }, _preparationId: string) => {
        commits += 1;
        return { type: "response", requestId: request.requestId, ok: true, result: { kind: "prompt.accepted", deliveryId: request.deliveryId, turnId: "turn-1" } } as const;
      },
    };
    const first = await createServiceWith(memory, testTailscale(), runtime);
    await first.setEnabled(true);
    const invitation = await first.createInvitation();
    const parsed = parsePrivateConnectPairingFragment(new URL(invitation.url).hash);
    const started = await first.pairStart({ invitation: parsed!, deviceId, deviceLabel: "Browser" }, "example");
    await first.approvePairing(started.requestId, "collaborate", [projectId]);
    const approved = await first.pairStatus(started.requestId);
    if (approved.status !== "approved") throw new Error("pairing did not approve");
    const cookie = approved.cookie.match(/^[^=]+=([^;]+)/u)?.[1] ?? "";
    const session = first.session(cookie);
    const request = { protocolVersion: 1 as const, type: "prompt.send" as const, requestId: "77777777-7777-4777-8777-777777777777", deliveryId: "88888888-8888-4888-8888-888888888888", conversationId: "44444444-4444-4444-8444-444444444444", content: "hello" };
    await expect(first.handleRequest(session!, request)).resolves.toMatchObject({ ok: true, result: { kind: "prompt.accepted" } });
    expect(commits).toBe(1);
    await first.shutdown();
    const second = await createServiceWith(memory, testTailscale(), runtime);
    await second.startIfEnabled();
    const replay = await second.handleRequest(second.session(cookie)!, { ...request, requestId: "99999999-9999-4999-8999-999999999999" });
    expect(replay).toMatchObject({ ok: true, requestId: "99999999-9999-4999-8999-999999999999", result: { kind: "prompt.accepted" } });
    expect(commits).toBe(1);
  });

  it("persists uncertain prompt intent before queueing so restart retries cannot duplicate a turn", async () => {
    const memory = testStore();
    let commits = 0;
    const runtime = {
      preparePrivateConnectPrompt: async () => ({ preparationId: "66666666-6666-4666-8666-666666666666" }),
      commitPrivateConnectPrompt: async () => {
        commits += 1;
        throw new Error("runtime acknowledgement lost");
      },
    };
    const first = await createServiceWith(memory, testTailscale(), runtime);
    await first.setEnabled(true);
    const invitation = await first.createInvitation();
    const parsed = parsePrivateConnectPairingFragment(new URL(invitation.url).hash);
    const started = await first.pairStart({ invitation: parsed!, deviceId, deviceLabel: "Browser" }, "example");
    await first.approvePairing(started.requestId, "collaborate", [projectId]);
    const approved = await first.pairStatus(started.requestId);
    if (approved.status !== "approved") throw new Error("pairing did not approve");
    const cookie = approved.cookie.match(/^[^=]+=([^;]+)/u)?.[1] ?? "";
    const request = { protocolVersion: 1 as const, type: "prompt.send" as const, requestId: "77777777-7777-4777-8777-777777777777", deliveryId: "88888888-8888-4888-8888-888888888888", conversationId: "44444444-4444-4444-8444-444444444444", content: "hello" };
    await expect(first.handleRequest(first.session(cookie)!, request)).resolves.toMatchObject({ ok: false, code: "uncertain" });
    expect(commits).toBe(1);
    expect(memory.saved()?.deliveryReceipts).toEqual([
      expect.objectContaining({ deliveryId: request.deliveryId, uncertainAt: expect.any(String) }),
    ]);
    await first.shutdown();
    const second = await createServiceWith(memory, testTailscale(), runtime);
    await second.startIfEnabled();
    await expect(second.handleRequest(second.session(cookie)!, {
      ...request,
      requestId: "99999999-9999-4999-8999-999999999999",
    })).resolves.toMatchObject({ ok: false, code: "uncertain" });
    expect(commits).toBe(1);
  });

  it("prunes expired device history before persisting a new pairing", async () => {
    const memory = testStore();
    const first = await createServiceWith(memory);
    await first.setEnabled(true);
    await first.shutdown();
    const persisted = memory.saved();
    if (!persisted) throw new Error("Private Connect state was not persisted");
    persisted.devices = Array.from({ length: 16 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      label: `Expired ${index + 1}`,
      scopes: ["private:read"] as const,
      projectIds: [projectId],
      grants: [{ projectId, conversationIds: [], includeFutureConversations: true }],
      createdAt: "2029-01-01T00:00:00.000Z",
      expiresAt: "2029-02-01T00:00:00.000Z",
      lastSeenAt: null,
      revokedAt: null,
      grantVersion: 1,
    }));
    const second = await createServiceWith(memory);
    await second.startIfEnabled();
    const invitation = await second.createInvitation();
    const parsed = parsePrivateConnectPairingFragment(new URL(invitation.url).hash);
    const started = await second.pairStart({ invitation: parsed!, deviceId, deviceLabel: "New browser" }, "example");
    await expect(second.approvePairing(started.requestId, "monitor", [projectId])).resolves.toBeUndefined();
    expect(memory.saved()?.devices).toEqual([
      expect.objectContaining({ id: deviceId, label: "New browser" }),
    ]);
  });
});
