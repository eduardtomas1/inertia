import { describe, expect, it, vi } from "vitest";

import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import {
  cursorVersionHasVerifiedAcpTerminalResume,
  providerTerminalResumeAvailability,
} from "../../src/shared/provider-terminal-resume";
import type {
  Conversation,
  ProviderId,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  ProviderTerminalResumeRegistry,
  providerTerminalResumeArguments,
  providerTerminalResumeLaunch,
  providerTerminalResumeProcessInvocation,
} from "../../src/server/provider/terminal-resume";
import { ProviderManager } from "../../src/server/providers";

const sessionIds: Readonly<Record<ProviderId, string>> = {
  codex: "019fe0c1-c6fc-79a1-bff4-92311f314da8",
  claude: "11111111-1111-4111-8111-111111111111",
  cursor: "22222222-2222-4222-8222-222222222222",
  kimi: "kimi-session-33333333",
  opencode: "ses_01K4Z9-safe.session",
};

function nativeConversation(providerId: ProviderId): Conversation {
  const modelSelection = nativeModelSelection({ providerId });
  return {
    id: "33333333-3333-4333-8333-333333333333",
    projectId: "44444444-4444-4444-8444-444444444444",
    title: "Native chat",
    providerId,
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(
      modelSelection,
      null,
      false,
    ),
    model: "provider-default",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: "/workspace/native-chat",
    providerSessionId: sessionIds[providerId],
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2026-08-08T00:00:00.000Z",
    updatedAt: "2026-08-08T00:00:00.000Z",
  };
}

function readyProvider(providerId: ProviderId): ProviderInfo {
  return {
    id: providerId,
    label: providerId === "opencode"
      ? "OpenCode"
      : `${providerId[0]!.toUpperCase()}${providerId.slice(1)}`,
    command: providerId,
    available: true,
    version: providerId === "cursor" ? "2026.08.04-aaa8809" : "1.2.3",
    executable: `/opt/provider/${providerId}`,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: "Connected",
    models: [],
    rateLimits: [],
    metadataState: {
      models: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
      rateLimits: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
    },
  };
}

describe("provider terminal resume mapping", () => {
  it("mirrors acquire and release into the shared conversation-work authority", () => {
    const authority = {
      reserve: vi.fn(() => true),
      reserveAtCheckout: vi.fn(() => true),
      release: vi.fn(),
    };
    const registry = new ProviderTerminalResumeRegistry(authority);

    expect(registry.acquire("conversation-1")).toBe(true);
    expect(registry.acquire("conversation-1")).toBe(false);
    expect(authority.reserve).toHaveBeenCalledOnce();
    registry.release("conversation-1");
    registry.release("conversation-1");
    expect(authority.release).toHaveBeenCalledOnce();

    expect(registry.acquireAtCheckout(
      "conversation-2",
      "project-1",
      "/workspace/missing-owned-chat",
    )).toBe(true);
    expect(authority.reserveAtCheckout).toHaveBeenCalledWith(
      "conversation-2",
      "project-1",
      "/workspace/missing-owned-chat",
    );
    registry.release("conversation-2");
    expect(authority.release).toHaveBeenCalledTimes(2);

    expect(registry.acquireAtCheckout(
      "conversation-3",
      "project-2",
      "/workspace/deleting-chat",
      "conversation-delete:request-3",
    )).toBe(true);
    expect(authority.reserveAtCheckout).toHaveBeenLastCalledWith(
      "conversation-delete:request-3",
      "project-2",
      "/workspace/deleting-chat",
    );
    registry.release("conversation-3");
    expect(authority.release).toHaveBeenLastCalledWith(
      "conversation-delete:request-3",
    );
  });

  it("waits for transient conversation work without joining an active resume", async () => {
    let available = false;
    const authority = {
      reserve: vi.fn(() => available),
      reserveAtCheckout: vi.fn(() => true),
      release: vi.fn(),
    };
    const registry = new ProviderTerminalResumeRegistry(authority);
    setTimeout(() => {
      available = true;
    }, 10);

    await expect(registry.acquireWhenAvailable("conversation-1", 100))
      .resolves.toBe(true);
    await expect(registry.acquireWhenAvailable("conversation-1", 100))
      .resolves.toBe(false);
    expect(authority.reserve).toHaveBeenCalledTimes(2);
    registry.release("conversation-1");
  });

  it("uses exact interactive CLI argv for every native provider", () => {
    expect(providerTerminalResumeArguments("codex", sessionIds.codex)).toEqual([
      "resume",
      sessionIds.codex,
    ]);
    expect(providerTerminalResumeArguments("claude", sessionIds.claude)).toEqual([
      "--resume",
      sessionIds.claude,
    ]);
    expect(providerTerminalResumeArguments("cursor", sessionIds.cursor)).toEqual([
      "--resume",
      sessionIds.cursor,
    ]);
    expect(providerTerminalResumeArguments("kimi", sessionIds.kimi)).toEqual([
      "--session",
      sessionIds.kimi,
    ]);
    expect(providerTerminalResumeArguments("opencode", sessionIds.opencode)).toEqual([
      "--session",
      sessionIds.opencode,
    ]);
  });

  it("rejects option-like, control, quoted, and oversized saved identifiers", () => {
    for (const sessionId of [
      "--continue",
      "safe\nother",
      "safe\" & whoami",
      "x".repeat(257),
    ]) {
      expect(() => providerTerminalResumeArguments("codex", sessionId)).toThrow(
        "invalid or stale",
      );
    }
  });

  it("keeps Windows batch paths and session IDs as data without a generic shell", () => {
    const executable = "C:\\Users\\Álex (Dev)\\AppData\\Roaming\\npm\\codex.cmd";
    const environment = {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      CODEX_API_KEY: "never-render-this-secret",
    };
    const invocation = providerTerminalResumeProcessInvocation(
      executable,
      "codex",
      sessionIds.codex,
      environment,
      "win32",
    );
    expect(invocation.command).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args.at(-1)).toContain("codex.cmd ^\"resume^\"");
    expect(invocation.args.at(-1)).toContain(sessionIds.codex);
    expect(JSON.stringify(invocation)).not.toContain("never-render-this-secret");

    const launch = providerTerminalResumeLaunch(
      "/Applications/Codex CLI/codex",
      "codex",
      sessionIds.codex,
      environment,
      "darwin",
    );
    expect(launch).toMatchObject({
      executable: "/Applications/Codex CLI/codex",
      args: ["resume", sessionIds.codex],
    });
    expect(launch.args).not.toContain("never-render-this-secret");
  });
});

describe("provider terminal resume availability", () => {
  it("exposes exact native sessions only when the installed CLI is ready", () => {
    for (const providerId of ["codex", "claude", "cursor", "kimi", "opencode"] as const) {
      expect(providerTerminalResumeAvailability(
        nativeConversation(providerId),
        readyProvider(providerId),
      )).toEqual({
        kind: "available",
        resume: {
          providerId,
          providerLabel: readyProvider(providerId).label,
          sessionId: sessionIds[providerId],
        },
        reason: null,
      });
    }
  });

  it("explains missing, non-native, unavailable, and unverified Cursor sessions", () => {
    const missing = nativeConversation("codex");
    missing.providerSessionId = null;
    expect(providerTerminalResumeAvailability(
      missing,
      readyProvider("codex"),
    )).toMatchObject({ kind: "unavailable", resume: null });

    const invalid = nativeConversation("codex");
    invalid.providerSessionId = "--continue\nleak";
    expect(providerTerminalResumeAvailability(
      invalid,
      readyProvider("codex"),
    )).toMatchObject({
      kind: "unavailable",
      resume: null,
      reason: expect.stringContaining("invalid or stale"),
    });

    const custom = nativeConversation("claude");
    custom.continuationIdentity = {
      ...custom.continuationIdentity!,
      backendProfileId: "custom:anthropic",
    };
    expect(providerTerminalResumeAvailability(
      custom,
      readyProvider("claude"),
    )).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("native CLI session store"),
    });

    const unavailable = readyProvider("opencode");
    unavailable.canRun = false;
    unavailable.statusMessage = "Sign in required";
    expect(providerTerminalResumeAvailability(
      nativeConversation("opencode"),
      unavailable,
    )).toMatchObject({
      kind: "unavailable",
      reason: "OpenCode cannot resume this session: Sign in required.",
    });

    const oldCursor = readyProvider("cursor");
    oldCursor.version = "2026.07.31";
    expect(providerTerminalResumeAvailability(
      nativeConversation("cursor"),
      oldCursor,
    )).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("not verified"),
    });
    expect(cursorVersionHasVerifiedAcpTerminalResume("2026.08.04-aaa8809")).toBe(true);
    expect(cursorVersionHasVerifiedAcpTerminalResume("2026.08.05-next")).toBe(false);
    expect(cursorVersionHasVerifiedAcpTerminalResume("unknown")).toBe(false);

    const running = nativeConversation("claude");
    running.status = "running";
    expect(providerTerminalResumeAvailability(
      running,
      readyProvider("claude"),
    )).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("Stop the active Claude turn"),
    });
  });
});

describe("ProviderManager terminal resume launch", () => {
  it("rechecks the resolved CLI in the owning cwd before returning a PTY launch", async () => {
    const manager = ProviderManager.createForTests();
    const detect = vi.spyOn(manager, "detect").mockResolvedValue({
      provider: { id: "claude", name: "Claude", command: "claude" },
      available: true,
      version: "2.1.207",
      executable: "/Applications/Claude CLI/claude",
      installState: "installed",
      authState: "authenticated",
      canRun: true,
      cleanupConfirmed: true,
      statusMessage: "Connected",
    });

    await expect(manager.terminalResumeLaunch(
      "claude",
      sessionIds.claude,
      "/workspace/owning chat",
    )).resolves.toMatchObject({
      executable: "/Applications/Claude CLI/claude",
      args: ["--resume", sessionIds.claude],
    });
    expect(detect).toHaveBeenCalledWith("claude", {
      cwd: "/workspace/owning chat",
      refreshEnvironment: true,
    });
  });

  it("rejects a runnable but unverified Cursor CLI version", async () => {
    const manager = ProviderManager.createForTests();
    vi.spyOn(manager, "detect").mockResolvedValue({
      provider: { id: "cursor", name: "Cursor", command: "cursor-agent" },
      available: true,
      version: "2026.07.31",
      executable: "/opt/cursor/agent",
      installState: "installed",
      authState: "authenticated",
      canRun: true,
      cleanupConfirmed: true,
      statusMessage: "Connected",
    });
    await expect(manager.terminalResumeLaunch(
      "cursor",
      sessionIds.cursor,
      "/workspace/cursor",
    )).rejects.toThrow("not verified");
  });
});
