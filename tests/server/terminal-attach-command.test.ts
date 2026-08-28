import WebSocket from "ws";

import { describe, expect, it, vi } from "vitest";

import {
  createProjectWorkspaceCommandHandler,
  type ProjectWorkspaceCommandDependencies,
} from "../../src/server/runtime/commands/project-workspace-commands";

const projectId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const terminalId = "33333333-3333-4333-8333-333333333333";

describe("terminal.attach command", () => {
  it("derives the workspace and returns authoritative provider ownership", async () => {
    const workspacePath = vi.fn(() => "/workspace/.inertia/worktrees/owned");
    const attach = vi.fn(() => ({
      terminalId,
      providerResume: {
        providerId: "codex" as const,
        providerLabel: "Codex",
        sessionId: "44444444-4444-4444-8444-444444444444",
      },
      providerResumeConversationId: conversationId,
    }));
    const send = vi.fn();
    const handler = createProjectWorkspaceCommandHandler({
      workspacePath,
      terminals: { attach },
      send,
    } as unknown as ProjectWorkspaceCommandDependencies);
    const socket = { readyState: WebSocket.OPEN } as WebSocket;

    await expect(handler(socket, {
      type: "terminal.attach",
      requestId: "55555555-5555-4555-8555-555555555555",
      payload: {
        projectId,
        conversationId,
        terminalId,
        cols: 91,
        rows: 31,
      },
    })).resolves.toBe("handled");

    expect(workspacePath).toHaveBeenCalledWith(projectId, conversationId);
    expect(attach).toHaveBeenCalledWith(
      socket,
      terminalId,
      "/workspace/.inertia/worktrees/owned",
      { projectId, conversationId },
      91,
      31,
      undefined,
    );
    expect(send).toHaveBeenCalledWith(socket, {
      type: "terminal.created",
      requestId: "55555555-5555-4555-8555-555555555555",
      terminalId,
      providerResume: {
        providerId: "codex",
        providerLabel: "Codex",
        sessionId: "44444444-4444-4444-8444-444444444444",
      },
      providerResumeConversationId: conversationId,
    });
  });

  it("uses a distinct null conversation scope for a project terminal", async () => {
    const attach = vi.fn(() => ({ terminalId }));
    const handler = createProjectWorkspaceCommandHandler({
      workspacePath: vi.fn(() => "/workspace/project"),
      terminals: { attach },
      send: vi.fn(),
    } as unknown as ProjectWorkspaceCommandDependencies);
    const socket = { readyState: WebSocket.OPEN } as WebSocket;

    await handler(socket, {
      type: "terminal.attach",
      requestId: "55555555-5555-4555-8555-555555555555",
      payload: { projectId, terminalId, cols: 80, rows: 24 },
    });

    expect(attach).toHaveBeenCalledWith(
      socket,
      terminalId,
      "/workspace/project",
      { projectId, conversationId: null },
      80,
      24,
      undefined,
    );
  });

  it("requests authoritative replacement reconciliation after ambiguous delivery", async () => {
    const replacementId = "66666666-6666-4666-8666-666666666666";
    const attach = vi.fn(() => ({ terminalId: replacementId }));
    const send = vi.fn();
    const handler = createProjectWorkspaceCommandHandler({
      workspacePath: vi.fn(() => "/workspace/project"),
      terminals: { attach },
      send,
    } as unknown as ProjectWorkspaceCommandDependencies);
    const socket = { readyState: WebSocket.OPEN } as WebSocket;

    await handler(socket, {
      type: "terminal.attach",
      requestId: "55555555-5555-4555-8555-555555555555",
      payload: {
        projectId,
        conversationId,
        terminalId,
        replacementRequestId: "77777777-7777-4777-8777-777777777777",
        cols: 80,
        rows: 24,
      },
    });

    expect(attach).toHaveBeenCalledWith(
      socket,
      terminalId,
      "/workspace/project",
      { projectId, conversationId },
      80,
      24,
      "77777777-7777-4777-8777-777777777777",
    );
    expect(send).toHaveBeenCalledWith(socket, expect.objectContaining({
      type: "terminal.created",
      terminalId: replacementId,
    }));
  });
});
