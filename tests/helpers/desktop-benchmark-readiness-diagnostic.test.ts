import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";

import {
  BENCHMARK_LOGIN_MARKER, BENCHMARK_READINESS_MAX_FRAME_BYTES,
  benchmarkLoginFixtureSource, benchmarkReadinessBlockers,
  projectBenchmarkComposerAdmission, projectBenchmarkRuntimeReadiness,
  readBenchmarkLoginMarker, readBenchmarkRuntimeReadiness,
} from "./desktop-benchmark-readiness-diagnostic";

function welcome() {
  return { type: "server.welcome", snapshot: {
    activeConversationId: "private-conversation-id",
    conversations: [{ id: "private-conversation-id", title: "secret prompt",
      providerId: "codex", modelSelection: { harnessId: "codex-app-server",
        backendProfileId: "builtin:openai", modelId: "provider-default",
        reasoningEffort: null, providerOptions: {}, backendProfileDisplayName: "private name" } }],
    providers: [{ id: "codex", available: true, executable: "/private/path/token",
      installState: "installed", authState: "unknown", canRun: false,
      statusMessage: "Installed; connection not confirmed", models: ["secret model"],
      credentials: "secret credential", rateLimits: [{ private: "data" }] }],
    lifecycleDiagnostics: { actionableState: "safe-and-ready", private: "other runtime data" },
    settings: { private: "settings" }, messages: ["secret conversation text"],
  } };
}

describe("benchmark readiness evidence", () => {
  it("projects only selected route, provider enums/booleans and admission from welcome/replay", () => {
    const event = welcome();
    const value = projectBenchmarkRuntimeReadiness(JSON.stringify(event));
    expect(value).toEqual({ selectedConversationPresent: true,
      selectedRoute: { providerId: "codex", harnessId: "codex-app-server", backend: "builtin:openai",
        model: "provider-default", reasoningSelected: false, providerOptionsPresent: false },
      provider: { available: true, executablePresent: true, installState: "installed", authState: "unknown",
        canRun: false, statusCode: "auth-unconfirmed" }, admission: "safe-and-ready" });
    expect(projectBenchmarkRuntimeReadiness(Buffer.from(JSON.stringify({ type: "runtime.event",
      event: { ...event, type: "snapshot.updated" } })))).toEqual(value);
    expect(JSON.stringify(value)).not.toMatch(/private|secret|token/u);
  });

  it("redacts arbitrary identities/status text while preserving useful selection differences", () => {
    const event = welcome();
    Object.assign(event.snapshot.conversations[0]!.modelSelection, {
      harnessId: "secret harness", backendProfileId: "secret backend", modelId: "secret model",
      reasoningEffort: "secret reasoning", providerOptions: { token: "secret" },
    });
    Object.assign(event.snapshot.providers[0]!, { statusMessage: "secret output", installState: "secret", authState: "secret" });
    const value = projectBenchmarkRuntimeReadiness(JSON.stringify(event));
    expect(value?.selectedRoute).toMatchObject({ harnessId: null, backend: "other-or-missing",
      model: "other", reasoningSelected: true, providerOptionsPresent: true });
    expect(value?.provider).toMatchObject({ statusCode: "other-or-absent", installState: null, authState: null });
    expect(JSON.stringify(value)).not.toContain("secret");
  });

  it("fails closed for malformed/unrelated/oversized frames and bounded collection overflow", () => {
    for (const payload of ["broken", "null", "[]", "1", JSON.stringify({ type: "terminal.output", data: "secret" }),
      JSON.stringify({ type: "server.welcome", snapshot: {} }), "é".repeat(BENCHMARK_READINESS_MAX_FRAME_BYTES / 2 + 1)]) {
      expect(projectBenchmarkRuntimeReadiness(payload)).toBeNull();
    }
    const tooMany = welcome();
    tooMany.snapshot.providers = Array.from({ length: 7 }, () => tooMany.snapshot.providers[0]!);
    expect(projectBenchmarkRuntimeReadiness(JSON.stringify(tooMany))).toBeNull();
    const conversations = welcome();
    conversations.snapshot.conversations = Array.from({ length: 4097 }, () => conversations.snapshot.conversations[0]!);
    expect(projectBenchmarkRuntimeReadiness(JSON.stringify(conversations))).toBeNull();
  });

  it("does not substitute another provider or a duplicate when selected authority is absent", () => {
    const event = welcome();
    event.snapshot.activeConversationId = "not-present";
    expect(projectBenchmarkRuntimeReadiness(JSON.stringify(event))).toMatchObject({
      selectedConversationPresent: false, provider: null,
    });
    const duplicate = welcome();
    duplicate.snapshot.providers.push(duplicate.snapshot.providers[0]!);
    expect(projectBenchmarkRuntimeReadiness(JSON.stringify(duplicate))?.provider).toBeNull();
  });

  it("reports observed provider, route and composer blockers without inferring authentication from Send", () => {
    const runtime = projectBenchmarkRuntimeReadiness(JSON.stringify(welcome()));
    const composer = projectBenchmarkComposerAdmission({ composerPresent: true, connection: "online",
      promptPresent: true, composerDisabled: false, inputDisabled: false, composerBusy: false,
      routeBlocked: true, routeBadge: "Sign in", routeRepair: "connect", sendDisabled: true,
      action: "send-disabled", prompt: "secret", providerOutput: "secret" });
    expect(benchmarkReadinessBlockers(runtime, composer)).toEqual([
      "provider-not-runnable", "provider-auth-unknown", "selected-route-blocked", "send-disabled",
    ]);
    expect(benchmarkReadinessBlockers(null, composer)).not.toContain("provider-auth-unknown");
    expect(JSON.stringify(composer)).not.toContain("secret");
    expect(projectBenchmarkComposerAdmission({ connection: "secret", action: "secret",
      routeBadge: "secret", routeRepair: "secret", promptPresent: "secret" })).toMatchObject({
      connection: null, action: null, routeBadge: null, routeRepair: null, promptPresent: null,
    });
    expect(Buffer.byteLength(JSON.stringify({ runtime, composer }))).toBeLessThan(2048);
  });

  it("distinguishes runtime cleanup/admission from an independently disabled composer", () => {
    const event = welcome();
    event.snapshot.providers[0]!.statusMessage = "Codex probe cleanup could not be confirmed stopped";
    event.snapshot.lifecycleDiagnostics.actionableState = "waiting-for-provider-cleanup";
    expect(benchmarkReadinessBlockers(projectBenchmarkRuntimeReadiness(JSON.stringify(event)),
      projectBenchmarkComposerAdmission({ composerPresent: true, connection: "offline", promptPresent: false,
        composerDisabled: true, composerBusy: true }))).toEqual([
      "runtime-admission-blocked", "provider-not-runnable", "provider-auth-unknown", "provider-cleanup-unconfirmed",
      "connection-not-online", "prompt-empty", "composer-disabled-or-update-pending", "composer-busy",
    ]);
  });

  it("captures a fresh allowlisted welcome and closes its observation socket", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    try {
      const address = server.address();
      if (typeof address === "string" || address === null) throw new Error("Missing test address");
      const closed = new Promise<void>((resolveClose) => server.once("connection", (socket) => {
        socket.once("close", resolveClose);
        socket.send(JSON.stringify(welcome()));
      }));
      await expect(readBenchmarkRuntimeReadiness(`ws://127.0.0.1:${address.port}`, 1000)).resolves.toMatchObject({
        outcome: "captured", value: { provider: { authState: "unknown" } },
      });
      await closed;
    } finally { await new Promise<void>((resolveClose) => server.close(() => resolveClose())); }
  });

  it("bounds an unresponsive observation peer and terminates its socket", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    try {
      const address = server.address();
      if (typeof address === "string" || address === null) throw new Error("Missing test address");
      const closed = new Promise<void>((resolveClose) => server.once("connection", (socket) => socket.once("close", resolveClose)));
      await expect(readBenchmarkRuntimeReadiness(`ws://127.0.0.1:${address.port}`, 50)).resolves.toEqual({ outcome: "timed-out" });
      await closed;
      await expect(readBenchmarkRuntimeReadiness(null, 50)).resolves.toEqual({ outcome: "unavailable" });
    } finally { await new Promise<void>((resolveClose) => server.close(() => resolveClose())); }
  });

  it("records fixed fixture timestamps without changing login output, and rejects stale/unsafe marker data", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "inertia-login-evidence-"));
    try {
      const launchedAt = Date.now();
      await writeFile(join(workspace, "login"), benchmarkLoginFixtureSource);
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ["login", "status"], { cwd: workspace, timeout: 5000 });
      expect(stdout).toBe("Logged in using ChatGPT\n");
      expect(stderr).toBe("");
      const marker = await readBenchmarkLoginMarker(workspace, launchedAt);
      expect(marker).toMatchObject({ stage: "write-completed", fromCurrentLaunch: true });
      expect(await readBenchmarkLoginMarker(workspace, Date.now() + 1000)).toMatchObject({ fromCurrentLaunch: false });
      for (const payload of ["x".repeat(513), "broken", JSON.stringify({ stage: "secret", startedAt: 1, observedAt: 2 }),
        JSON.stringify({ stage: "started", startedAt: 2, observedAt: 1 })]) {
        await writeFile(join(workspace, BENCHMARK_LOGIN_MARKER), payload);
        expect(await readBenchmarkLoginMarker(workspace, launchedAt)).toBeNull();
      }
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
