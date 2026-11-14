import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef } from "react";

import type { Conversation, ServerEvent } from "../../src/shared/contracts";
import { useDraftSkills } from "../../src/renderer/src/hooks/useDraftSkills";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { ComposerSkillsMenu } from "../../src/renderer/src/components/composer/ComposerSkillsMenu";
import { useComposerMenus } from "../../src/renderer/src/components/composer/useComposerMenus";

const draftId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

function draft(providerId: string, harnessId: string, id = draftId, project = projectId): Conversation {
  return {
    id,
    projectId: project,
    providerId,
    modelSelection: { harnessId },
  } as unknown as Conversation;
}

function DraftComposer({
  current,
  request,
}: {
  current: Conversation;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
}): React.JSX.Element {
  const draftSkills = useDraftSkills({ draft: current, status: "online", request });
  const menuController = useComposerMenus();
  const editor = useRef<HTMLTextAreaElement>(null);
  const { setMenuTrigger } = menuController;
  useLayoutEffect(() => {
    setMenuTrigger("skills", editor.current);
    return () => setMenuTrigger("skills", null);
  }, [setMenuTrigger]);
  return <><textarea ref={editor} aria-label="Message" />
    <ComposerSkillsMenu
      skills={draftSkills.skills}
      capability={draftSkills.capability}
      loading={draftSkills.loading}
      error={draftSkills.error}
      completion=""
      listboxId="draft-skills"
      disabled={false}
      running={false}
      menuController={menuController}
      onList={draftSkills.list}
      onInsert={() => undefined}
    /></>;
}

function emptySkillsResult(conversationId: string): ServerEvent {
  const event = skillsResult(conversationId);
  return event.type === "request.result" && event.result.kind === "agent.skills"
    ? { ...event, result: { ...event.result, skills: [] } }
    : event;
}

function skillsResult(conversationId: string, name = "review"): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: {
      kind: "agent.skills",
      conversationId,
      skills: [{
        id: crypto.randomUUID(),
        conversationId,
        name,
        description: "Review this project.",
        shortDescription: null,
        scope: "repo",
        enabled: true,
        source: "codex-native",
      }],
      skillDiscovery: { truncated: false, warningCount: 0, synchronizedAt: "2030-01-01T00:00:00.000Z" },
    },
  } as ServerEvent;
}

describe("useDraftSkills", () => {
  it("lists skills for a draft from its project and harness, with no chat", async () => {
    const request = vi.fn(async (_command: CommandWithoutId) => skillsResult(draftId));
    const { result } = renderHook(() => useDraftSkills({
      draft: draft("codex", "codex-app-server"), status: "online", request,
    }));
    expect(result.current.capability).toEqual({ kind: "codex-native", available: true, label: "Codex skills" });

    await act(async () => { await result.current.list(); });

    expect(request).toHaveBeenCalledExactlyOnceWith({
      type: "agent.skills.preview",
      payload: { draftConversationId: draftId, projectId, harnessId: "codex-app-server", forceReload: false },
    });
    expect(result.current.skills.map(({ name }) => name)).toEqual(["review"]);
    expect(result.current.loading).toBe(false);
  });

  it("reports unavailable routes without contacting the service", async () => {
    const request = vi.fn(async (_command: CommandWithoutId) => skillsResult(draftId));
    const { result } = renderHook(() => useDraftSkills({
      draft: draft("opencode", "opencode-server"), status: "online", request,
    }));

    await act(async () => { await result.current.list(); });

    expect(result.current.capability).toMatchObject({ kind: "unavailable", available: false });
    expect(request).not.toHaveBeenCalled();
  });

  it("drops a stale list when the draft moves to another provider", async () => {
    let resolve!: (event: ServerEvent) => void;
    const request = vi.fn((_command: CommandWithoutId) => new Promise<ServerEvent>((settle) => { resolve = settle; }));
    const { result, rerender } = renderHook(
      ({ current }: { current: Conversation }) => useDraftSkills({ draft: current, status: "online", request }),
      { initialProps: { current: draft("codex", "codex-app-server") } },
    );
    let pending!: Promise<void>;
    act(() => { pending = result.current.list(); });
    await waitFor(() => expect(result.current.loading).toBe(true));

    rerender({ current: draft("claude", "claude-agent-sdk") });
    await act(async () => { resolve(skillsResult(draftId)); await pending; });

    expect(result.current.skills).toEqual([]);
    expect(result.current.capability).toMatchObject({ kind: "claude-native" });
    expect(result.current.loading).toBe(false);
  });

  it("keeps the reason when discovery fails", async () => {
    const request = vi.fn(async (_command: CommandWithoutId): Promise<ServerEvent> => {
      throw new Error("Codex did not return skills for this project.");
    });
    const { result } = renderHook(() => useDraftSkills({
      draft: draft("codex", "codex-app-server"), status: "online", request,
    }));

    await act(async () => { await result.current.list().catch(() => undefined); });

    expect(result.current.error).toBe("Codex did not return skills for this project.");
    expect(result.current.skills).toEqual([]);
  });

  it("lists the new project's skills when an open dollar query follows the draft to another project", async () => {
    const otherProjectId = "33333333-3333-4333-8333-333333333333";
    const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> =>
      command.type === "agent.skills.preview" && command.payload.projectId === otherProjectId
        ? skillsResult(draftId)
        : emptySkillsResult(draftId));
    const view = render(<DraftComposer current={draft("codex", "codex-app-server")} request={request} />);
    expect(await screen.findByText("No enabled skills")).toBeInTheDocument();

    view.rerender(<DraftComposer current={draft("codex", "codex-app-server", draftId, otherProjectId)} request={request} />);

    expect(await screen.findByRole("option", { name: /\$review/u })).toBeInTheDocument();
    expect(request).toHaveBeenLastCalledWith({
      type: "agent.skills.preview",
      payload: { draftConversationId: draftId, projectId: otherProjectId, harnessId: "codex-app-server", forceReload: false },
    });
  });
});
