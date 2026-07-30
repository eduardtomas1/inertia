import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  isRuntimeWebSocketUrl,
  parseRuntimeWorkerCommand,
  parseRuntimeWorkerEvent,
} from "../../src/node/runtime-process-protocol";
import {
  builtInKimiClaudeBackendProfile,
  KIMI_CLAUDE_BUILTIN_PROFILE_ID,
} from "../../src/shared/claude-backend-profiles";
import { backendSecretReferenceForProfile } from "../../src/main/credential-vault";

const capabilityUrl = `ws://127.0.0.1:43210/runtime/${"a".repeat(43)}`;
const dataDirectory = resolve(tmpdir(), "inertia data");
const workspaceDirectory = resolve(tmpdir(), "inertia workspace");
const attachmentRoot = resolve(tmpdir(), "inertia attachments");
const packageSmokePdfInput = resolve(tmpdir(), "inertia package smoke.pdf");
const packageSmokePdfResult = resolve(tmpdir(), "inertia package smoke result.json");
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
        attachmentRoot,
      },
    })).toEqual({
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: true,
        codexBinaryPath: resolve(tmpdir(), "Codex Ω", "codex.cmd"),
        attachmentRoot,
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
    expect(parseRuntimeWorkerCommand({
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: true,
        attachmentRoot: "relative",
      },
    })).toBeNull();
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

  it("accepts only absolute packaged PDF smoke paths in the private startup envelope", () => {
    const command = {
      type: "runtime.start",
      options: {
        dataDirectory,
        defaultWorkspacePath: workspaceDirectory,
        enableProviders: false,
        packageSmokePdf: {
          inputPath: packageSmokePdfInput,
          resultPath: packageSmokePdfResult,
        },
      },
    };

    expect(parseRuntimeWorkerCommand(command)).toEqual(command);
    expect(parseRuntimeWorkerCommand({
      ...command,
      options: {
        ...command.options,
        packageSmokePdf: {
          inputPath: "relative.pdf",
          resultPath: packageSmokePdfResult,
        },
      },
    })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      ...command,
      options: {
        ...command.options,
        packageSmokePdf: {
          inputPath: packageSmokePdfInput,
          resultPath: packageSmokePdfResult,
          unexpected: true,
        },
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
    expect(parseRuntimeWorkerEvent({ type: "runtime.shutdown-unconfirmed" })).toEqual({
      type: "runtime.shutdown-unconfirmed",
    });
    expect(parseRuntimeWorkerEvent({ type: "runtime.shutdown-unconfirmed", extra: true })).toBeNull();
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

  it("strictly validates secure-file requests and correlated results", () => {
    const requestId = crypto.randomUUID();
    const request = {
      type: "runtime.secure-file-request",
      requestId,
      operation: "read",
      root: workspaceDirectory,
      rootIdentity: { dev: "1", ino: "2" },
      parentIdentities: [],
      targetIdentity: { dev: "1", ino: "3" },
      path: "README.md",
      maxBytes: 1024,
    };
    expect(parseRuntimeWorkerEvent(request)).toEqual(request);
    expect(parseRuntimeWorkerEvent({
      ...request,
      path: "../outside.txt",
    })).toBeNull();
    expect(parseRuntimeWorkerEvent({
      ...request,
      parentIdentities: [{ dev: "1", ino: "4" }],
    })).toBeNull();
    const recoveryRequest = {
      type: "runtime.secure-file-request",
      requestId,
      operation: "recover",
      root: workspaceDirectory,
      rootIdentity: { dev: "1", ino: "2" },
      parentIdentities: [],
      path: "README.md",
    };
    expect(parseRuntimeWorkerEvent(recoveryRequest)).toEqual(recoveryRequest);
    expect(parseRuntimeWorkerEvent({
      ...recoveryRequest,
      targetIdentity: { dev: "1", ino: "3" },
    })).toBeNull();

    const metadata = {
      digest: "a".repeat(64),
      size: 4,
      modifiedAt: "2026-07-29T10:00:00.000Z",
      mode: 0o600,
    };
    expect(parseRuntimeWorkerCommand({
      type: "runtime.secure-file-result",
      requestId,
      result: {
        ok: true,
        operation: "read",
        contentBase64: Buffer.from("test").toString("base64"),
        metadata,
      },
    })).toMatchObject({
      type: "runtime.secure-file-result",
      requestId,
      result: { ok: true, operation: "read", metadata },
    });
    expect(parseRuntimeWorkerCommand({
      type: "runtime.secure-file-result",
      requestId,
      result: {
        ok: true,
        operation: "read",
        contentBase64: Buffer.from("short").toString("base64"),
        metadata,
      },
    })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.secure-file-result",
      requestId,
      result: {
        ok: false,
        code: "unsafe",
        message: "The workspace identity changed.",
      },
    })).toMatchObject({
      result: { ok: false, code: "unsafe" },
    });
    expect(parseRuntimeWorkerCommand({
      type: "runtime.secure-file-result",
      requestId,
      result: { ok: true, operation: "recover" },
    })).toMatchObject({
      result: { ok: true, operation: "recover" },
    });
  });

  it("strictly validates opaque attachment requests and trusted descriptors", () => {
    const requestId = crypto.randomUUID();
    const attachmentId = crypto.randomUUID();
    const request = {
      type: "runtime.attachment-request",
      requestId,
      attachmentId,
    };
    const attachment = {
      id: attachmentId,
      name: "preview.png",
      path: resolve(attachmentRoot, `${attachmentId}.png`),
      mimeType: "image/png",
      size: 8,
      digest: "a".repeat(64),
    };
    expect(parseRuntimeWorkerEvent(request)).toEqual(request);
    expect(parseRuntimeWorkerEvent({
      ...request,
      attachmentId: "../outside.png",
    })).toBeNull();
    expect(parseRuntimeWorkerEvent({ ...request, path: "/tmp/untrusted" }))
      .toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.attachment-result",
      requestId,
      ok: true,
      attachment,
    })).toEqual({
      type: "runtime.attachment-result",
      requestId,
      ok: true,
      attachment,
    });
    for (const tampered of [
      { ...attachment, path: "relative.png" },
      { ...attachment, mimeType: "image/svg+xml" },
      { ...attachment, size: 0 },
      { ...attachment, digest: "not-a-digest" },
      { ...attachment, extra: true },
    ]) {
      expect(parseRuntimeWorkerCommand({
        type: "runtime.attachment-result",
        requestId,
        ok: true,
        attachment: tampered,
      })).toBeNull();
    }
    expect(parseRuntimeWorkerCommand({
      type: "runtime.attachment-result",
      requestId,
      ok: false,
      code: "not-found",
      message: "The attachment capability is unavailable.",
    })).toMatchObject({ ok: false, code: "not-found" });

    const releaseRequest = {
      type: "runtime.attachment-release-request",
      requestId,
      attachmentId,
    };
    expect(parseRuntimeWorkerEvent(releaseRequest)).toEqual(releaseRequest);
    expect(parseRuntimeWorkerEvent({
      ...releaseRequest,
      path: attachment.path,
    })).toBeNull();
    expect(parseRuntimeWorkerEvent({
      ...releaseRequest,
      attachmentId: "not-an-opaque-capability",
    })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.attachment-release-result",
      requestId,
      ok: true,
      released: true,
    })).toEqual({
      type: "runtime.attachment-release-result",
      requestId,
      ok: true,
      released: true,
    });
    expect(parseRuntimeWorkerCommand({
      type: "runtime.attachment-release-result",
      requestId,
      ok: true,
      released: true,
      path: attachment.path,
    })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.attachment-release-result",
      requestId,
      ok: false,
      code: "unavailable",
      message: "Secure attachment storage is unavailable.",
    })).toMatchObject({
      type: "runtime.attachment-release-result",
      ok: false,
      code: "unavailable",
    });

    const cleanupRequest = {
      type: "runtime.attachment-cleanup-request",
      requestId,
      attachmentId,
    };
    expect(parseRuntimeWorkerEvent(cleanupRequest)).toEqual(cleanupRequest);
    expect(parseRuntimeWorkerEvent({
      ...cleanupRequest,
      mode: "force",
    })).toBeNull();

    const relinquishRequest = {
      type: "runtime.attachment-relinquish-request",
      requestId,
      attachmentId,
    };
    expect(parseRuntimeWorkerEvent(relinquishRequest))
      .toEqual(relinquishRequest);
    expect(parseRuntimeWorkerEvent({
      ...relinquishRequest,
      path: attachment.path,
    })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.attachment-relinquish-result",
      requestId,
      ok: true,
      relinquished: true,
    })).toEqual({
      type: "runtime.attachment-relinquish-result",
      requestId,
      ok: true,
      relinquished: true,
    });
    expect(parseRuntimeWorkerCommand({
      type: "runtime.attachment-relinquish-result",
      requestId,
      ok: true,
      relinquished: true,
      released: true,
    })).toBeNull();
    expect(parseRuntimeWorkerCommand({
      type: "runtime.attachment-relinquish-result",
      requestId,
      ok: false,
      code: "invalid",
      message: "The attachment request identifier was already used.",
    })).toMatchObject({
      type: "runtime.attachment-relinquish-result",
      ok: false,
      code: "invalid",
    });
  });
});
