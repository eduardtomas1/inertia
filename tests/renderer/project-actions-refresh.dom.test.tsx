import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project, ServerEvent } from "../../src/shared/contracts";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import { useWorkspaceFiles } from "../../src/renderer/src/hooks/workspace-tools/useWorkspaceFiles";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { conversation } from "./composer-fixtures";

const alphaChat = conversation("22222222-2222-4222-8222-222222222222");
const alpha: Project = {
  id: alphaChat.projectId, name: "Alpha", path: "/workspace/alpha", normalizedPath: "/workspace/alpha",
  repositoryIdentity: null, repositoryRoot: null, repositoryRelativePath: ".", groupingMode: null,
  gitRepositoryLimit: 64, color: "#5555ff", status: "ready", createdAt: alphaChat.createdAt, updatedAt: alphaChat.updatedAt,
};
function result(value: Extract<ServerEvent, { type: "request.result" }>["result"]): ServerEvent {
  return { type: "request.result", requestId: crypto.randomUUID(), result: value };
}

describe("project action refresh", () => {
  it("refreshes saved actions for the same project without requiring a chat switch or reloading files", async () => {
    const action = { id: crypto.randomUUID(), name: "Check", executable: "node", args: ["--version"] };
    const listed = { id: `custom:${action.id}`, label: "Check", command: "node --version", preview: false };
    const request = vi.fn(async (_command: CommandWithoutId): Promise<ServerEvent> => result({ kind: "project.actions", actions: [] }));
    const hook = renderHook(({ project }: { project: Project }) => useWorkspaceFiles({
      project, conversation: alphaChat, enabled: true, loadOnMount: false, online: true, request, setActionError: vi.fn(),
    }), { initialProps: { project: alpha } });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    request.mockResolvedValue(result({ kind: "project.actions", actions: [listed] }));
    const updated = { ...alpha, preferences: { ...defaultProjectPreferences(), actions: [action] } };
    hook.rerender({ project: updated });
    await waitFor(() => expect(hook.result.current.projectActions).toEqual([listed]));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([command]) => command.type)).toEqual(["project.actions", "project.actions"]);
    hook.rerender({ project: { ...updated, name: "Renamed", preferences: { ...updated.preferences, actions: [{ ...action }] } } });
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(2);
  });
});
