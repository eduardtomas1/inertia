import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  isRuntimeWebSocketUrl,
  parseRuntimeWorkerCommand,
  parseRuntimeWorkerEvent,
} from "../../src/main/runtime-process-protocol";
import {
  builtInKimiClaudeBackendProfile,
  KIMI_CLAUDE_BUILTIN_PROFILE_ID,
} from "../../src/shared/claude-backend-profiles";
import { backendSecretReferenceForProfile } from "../../src/main/credential-vault";

const capabilityUrl = `ws://127.0.0.1:43210/runtime/${"a".repeat(43)}`;
const dataDirectory = resolve(tmpdir(), "inertia data");
const workspaceDirectory = resolve(tmpdir(), "inertia workspace");
const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";

describe("runtime process protocol", () => {
  it("accepts only absolute bounded startup options", () => {
    expect(parseRuntimeWorkerCommand({
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
      },
    })).toEqual({
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
      },
    });
    expect(parseRuntimeWorkerCommand({ type: "runtime.start", options: { dataDirectory: "relative", defaultWorkspacePath: workspaceDirectory, enableProviders: false } })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: true,
        codexBinaryPath: resolve(tmpdir(), "Codex Ω", "codex.cmd"),
      },
    })).toEqual({
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: true,
        codexBinaryPath: resolve(tmpdir(), "Codex Ω", "codex.cmd"),
      },
    });
    expect(parseRuntimeWorkerCommand({
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: true,
        codexBinaryPath: "codex.cmd",
      },
    })).toBeNull();
    expect(parseRuntimeWorkerCommand({ type: "runtime.shutdown", unexpected: true })).toBeNull();
  });

  it("accepts only strict safe Kimi profiles in the private startup envelope", () => {
    const profile = builtInKimiClaudeBackendProfile(
      backendSecretReferenceForProfile(KIMI_CLAUDE_BUILTIN_PROFILE_ID),
    );
    const command = {
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: true,
        codexBinaryPath: resolve(tmpdir(), "Codex Ω", "codex.cmd"),
        kimiClaudeProfiles: [profile],
      },
    };

    expect(parseRuntimeWorkerCommand(command)).toEqual(command);
    expect(JSON.stringify(command)).not.toContain("api-key-value");
    expect(parseRuntimeWorkerCommand({
      ...command,
      options: {
        ...command.options,
        kimiClaudeProfiles: [{ ...profile, apiKey: "api-key-value" }],
      },
    })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      ...command,
      options: {
        ...command.options,
        kimiClaudeProfiles: [{ ...profile, baseUrl: "https://example.invalid/" }],
      },
    })).toBeNull();
  });

  it("accepts only a loopback capability URL with the runtime token shape", () => {
    expect(isRuntimeWebSocketUrl(capabilityUrl)).toBe(true);
    expect(parseRuntimeWorkerEvent({ type: "runtime.ready", websocketUrl: capabilityUrl })).toEqual({ type: "runtime.ready", websocketUrl: capabilityUrl });
    expect(isRuntimeWebSocketUrl(`ws://localhost:43210/runtime/${"a".repeat(43)}`)).toBe(false);
    expect(isRuntimeWebSocketUrl(`ws://127.0.0.1:43210/runtime/${"a".repeat(42)}`)).toBe(false);
    expect(isRuntimeWebSocketUrl(`ws://127.0.0.1:43210/runtime/${"a".repeat(43)}?leak=1`)).toBe(false);
    expect(isRuntimeWebSocketUrl(`wss://127.0.0.1:43210/runtime/${"a".repeat(43)}`)).toBe(false);
  });

  it("accepts only scoped relative project-path requests and absolute resolutions", () => {
    const requestId = crypto.randomUUID();
    const command = {
      type: "runtime.resolve-project-path",
      requestId,
      request: {
        projectId,
        conversationId,
        relativePath: "src/index.ts",
        action: "open-externally",
      },
    };
    expect(parseRuntimeWorkerCommand(command)).toEqual(command);
    for (const relativePath of ["../secret", "/etc/passwd", "src/\0secret"]) {
      expect(parseRuntimeWorkerCommand({
        ...command,
        request: { ...command.request, relativePath },
      })).toBeNull();
    }
    expect(parseRuntimeWorkerEvent({
      type: "runtime.project-path-resolved",
      requestId,
      path: resolve(workspaceDirectory, "src/index.ts"),
    })).toEqual({
      type: "runtime.project-path-resolved",
      requestId,
      path: resolve(workspaceDirectory, "src/index.ts"),
    });
    expect(parseRuntimeWorkerEvent({
      type: "runtime.project-path-resolved",
      requestId,
      path: "src/index.ts",
    })).toBeNull();
  });

  it("rejects malformed and oversized worker diagnostics", () => {
    expect(parseRuntimeWorkerEvent({ type: "runtime.startup-failed", message: "SQLite unavailable" })).toEqual({
      type: "runtime.startup-failed",
      message: "SQLite unavailable",
    });
    expect(parseRuntimeWorkerEvent({ type: "runtime.startup-failed", message: "x".repeat(1001) })).toBeNull();
    expect(parseRuntimeWorkerEvent({ type: "runtime.stopped", extra: true })).toBeNull();
  });

  it("strictly validates credential broker requests and correlated results", () => {
    const requestId = crypto.randomUUID();
    const secretReference = `secret:backend:${"a".repeat(64)}`;
    const request = {
      type: "runtime.credential-request",
      requestId,
      operation: "resolve",
      secretReference,
    };
    expect(parseRuntimeWorkerEvent(request)).toEqual(request);
    expect(parseRuntimeWorkerEvent({ ...request, operation: "read" })).toBeNull();
    expect(parseRuntimeWorkerEvent({ ...request, secretReference: "plaintext-secret" })).toBeNull();
    expect(parseRuntimeWorkerEvent({ ...request, unexpected: true })).toBeNull();

    expect(parseRuntimeWorkerCommand({
      type: "runtime.credential-result",
      requestId,
      operation: "resolve",
      ok: true,
      secret: "launch-only-secret",
    })).toEqual({
      type: "runtime.credential-result",
      requestId,
      operation: "resolve",
      ok: true,
      secret: "launch-only-secret",
    });
    expect(parseRuntimeWorkerCommand({
      type: "runtime.credential-result",
      requestId,
      operation: "resolve",
      ok: true,
      secret: "x".repeat(16_385),
    })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.credential-result",
      requestId,
      operation: "status",
      ok: true,
      hasSecret: true,
      credentialGeneration: "generation:test",
    })).toMatchObject({
      operation: "status",
      hasSecret: true,
      credentialGeneration: "generation:test",
    });
    expect(parseRuntimeWorkerCommand({
      type: "runtime.credential-result",
      requestId,
      operation: "status",
      ok: true,
      hasSecret: true,
      credentialGeneration: "bad generation",
    })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.credential-result",
      requestId,
      operation: "clear",
      ok: false,
      code: "unavailable",
      message: "Secure credential storage is unavailable.",
    })).toMatchObject({ ok: false, operation: "clear" });
    expect(parseRuntimeWorkerCommand({
      type: "runtime.credential-result",
      requestId,
      operation: "forget",
      ok: true,
      removed: true,
    })).toMatchObject({ ok: true, operation: "forget", removed: true });
  });
});
