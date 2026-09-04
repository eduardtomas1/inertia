import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  Conversation,
  Project,
  ServerEvent,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import {
  useWorkspaceMentions,
} from "../../src/renderer/src/hooks/workspace-tools/useWorkspaceMentions";
import { Composer } from "../../src/renderer/src/components/Composer";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Workspace",
  path: "/workspace",
  normalizedPath: "/workspace",
  repositoryIdentity: null,
  repositoryRoot: null,
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 64,
  color: "#5555ff",
  status: "ready",
  createdAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:00.000Z",
};

function conversation(
  id: string,
  owner: Project,
  worktreePath: string,
): Conversation {
  return {
    id,
    projectId: owner.id,
    title: id,
    providerId: "codex",
    modelSelection: providerNativeModelSelection({
      providerId: "codex",
      modelId: "default",
      reasoningEffort: "medium",
    }),
    continuationIdentity: null,
    model: "default",
    reasoningEffort: "medium",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: "main",
    worktreePath,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
  };
}

describe("useWorkspaceMentions", () => {
  it("keeps simultaneous pane searches scoped to their conversation IDs", async () => {
    const primary = conversation(
      "22222222-2222-4222-8222-222222222222",
      project,
      "/workspace-primary",
    );
    const secondaryProject = {
      ...project,
      id: "55555555-5555-4555-8555-555555555555",
      name: "Secondary",
      path: "/secondary",
      normalizedPath: "/secondary",
    };
    const secondary = conversation(
      "33333333-3333-4333-8333-333333333333",
      secondaryProject,
      "/workspace-secondary",
    );
    const request = vi.fn(async (command): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: "44444444-4444-4444-8444-444444444444",
      result: {
        kind: "workspace.entries",
        entries: [{
          path: `${command.payload.conversationId}/result.ts`,
          kind: "file",
        }],
        truncated: false,
        directory: "",
      },
    }));
    const primaryHook = renderHook(() => useWorkspaceMentions({
      enabled: true,
      project,
      conversation: primary,
      request,
    }));
    const secondaryHook = renderHook(() => useWorkspaceMentions({
      enabled: true,
      project: secondaryProject,
      conversation: secondary,
      request,
    }));

    act(() => {
      primaryHook.result.current.searchMentions("result");
      secondaryHook.result.current.searchMentions("result");
    });

    await waitFor(() => {
      expect(primaryHook.result.current.mentionResults[0]?.path)
        .toContain(primary.id);
      expect(secondaryHook.result.current.mentionResults[0]?.path)
        .toContain(secondary.id);
    });
    expect(request.mock.calls.map(([command]) => ({
      projectId: command.payload.projectId,
      conversationId: command.payload.conversationId,
    }))).toEqual([
      { projectId: project.id, conversationId: primary.id },
      {
        projectId: secondaryProject.id,
        conversationId: secondary.id,
      },
    ]);
  });

  it("does not request workspace entries when a disabled draft types @foo", async () => {
    const storedValues = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => storedValues.clear(),
        getItem: (key: string) => storedValues.get(key) ?? null,
        key: (index: number) => [...storedValues.keys()][index] ?? null,
        get length() {
          return storedValues.size;
        },
        removeItem: (key: string) => storedValues.delete(key),
        setItem: (key: string, value: string) => storedValues.set(key, value),
      } satisfies Storage,
    });
    const draftConversation = conversation(
      "66666666-6666-4666-8666-666666666666",
      project,
      "/workspace-draft",
    );
    const request = vi.fn(async (): Promise<ServerEvent> => {
      throw new Error("Draft mentions must not reach the runtime.");
    });
    const releaseAttachment = async (): Promise<void> => undefined;

    function DisabledDraftComposer(): React.JSX.Element {
      const mentions = useWorkspaceMentions({
        enabled: false,
        project,
        conversation: draftConversation,
        request,
      });
      return (
        <Composer
          conversation={draftConversation}
          providers={[]}
          actions={[]}
          disabled={false}
          sending={false}
          running={false}
          mentionResults={mentions.mentionResults}
          usage={null}
          usageDisplayMode="compact"
          skills={[]}
          skillsCapability={null}
          skillsLoading={false}
          skillsError={null}
          onSend={async () => undefined}
          onListSkills={async () => undefined}
          onUpdateConversation={() => Promise.resolve()}
          onCreateConversationForSelection={async () => undefined}
          onChooseAttachments={async () => null}
          onImportAttachments={async () => null}
          onReleaseAttachment={releaseAttachment}
          onRunAction={() => undefined}
          onMentionQuery={mentions.searchMentions}
          onConnectProvider={() => undefined}
          onRefreshProvider={() => undefined}
          onOpenProviderSetup={() => undefined}
          onOpenBackendSetup={() => undefined}
          onOpenResume={() => undefined}
          onProbeBackendProfile={async () => undefined}
          onUsageDisplayModeChange={() => undefined}
          onStop={async () => undefined}
        />
      );
    }

    render(<DisabledDraftComposer />);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "@foo" },
    });
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Message" }))
        .toHaveValue("@foo");
    });
    expect(request).not.toHaveBeenCalled();
  });
});
