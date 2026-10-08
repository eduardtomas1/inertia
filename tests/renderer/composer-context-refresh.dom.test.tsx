import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationContextPacketSummary, ServerEvent } from "../../src/shared/contracts";
import { useComposerConversationContext } from "../../src/renderer/src/components/composer/useComposerConversationContext";
import type { ConversationContextSourceOption } from "../../src/renderer/src/components/conversation-context/types";
import { deferred } from "./composer-fixtures";

const target = "66666666-6666-4666-8666-666666666666";
const copiedAt = "2026-10-08T10:00:00.000Z";

const source: ConversationContextSourceOption = {
  conversationId: "44444444-4444-4444-8444-444444444444",
  conversationTitle: "Architecture decisions",
  projectName: "Inertia",
  workspaceLabel: "Project checkout · main",
  targetWorkspaceLabel: "Project checkout · main",
  workspaceRelation: "same-workspace",
  archived: false,
  latestTurnCompletedAt: null,
};

function draft(overrides: Partial<ConversationContextPacketSummary> = {}): ConversationContextPacketSummary {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    sourceConversationId: source.conversationId,
    targetConversationId: target,
    sourceProjectId: "77777777-7777-4777-8777-777777777777",
    targetProjectId: "77777777-7777-4777-8777-777777777777",
    sourceConversationTitle: source.conversationTitle,
    sourceProjectName: source.projectName,
    sourceWorkspaceLabel: "Project checkout · main",
    targetWorkspaceLabel: "Project checkout · main",
    workspaceRelation: "same-workspace",
    note: null,
    messageCount: 3,
    characterCount: 300,
    droppedMessageCount: 0,
    createdAt: copiedAt,
    consumedMessageId: null,
    consumedAt: null,
    sourceState: "available",
    ...overrides,
  };
}

function created(packet: ConversationContextPacketSummary): ServerEvent {
  return {
    type: "request.result",
    requestId: "create",
    result: { kind: "conversation.context.packet", packet: { ...packet, excerpts: [] } },
  } as unknown as ServerEvent;
}

type Props = Parameters<typeof useComposerConversationContext>[0];

function setup(initial: Partial<Props>, onCommand: NonNullable<Props["onCommand"]>) {
  const props: Props = {
    conversationId: target,
    workspaceKey: "workspace",
    conversationTitle: "Provider boundary review",
    contextSources: [source],
    contextPackets: [draft()],
    hasVisibleHistory: true,
    enabled: true,
    latestTurnCompletedAt: null,
    paused: false,
    onCommand,
    ...initial,
  };
  const view = renderHook((current: Props) => useComposerConversationContext(current), { initialProps: props });
  return { props, view };
}

describe("stale chat reference drafts", () => {
  it("recopies a reference whose source turn finished after it was copied, holding sends until it is back", async () => {
    const refreshed = draft({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", createdAt: "2026-10-08T10:05:01.000Z", messageCount: 5 });
    const creation = deferred<ServerEvent>();
    const onCommand = vi.fn(async (type: string) => type === "conversation.context.create"
      ? creation.promise
      : { type: "request.ok", requestId: "remove" } as ServerEvent);
    const { props, view } = setup({}, onCommand);
    expect(onCommand).not.toHaveBeenCalled();

    const finished = { ...props, contextSources: [{ ...source, latestTurnCompletedAt: "2026-10-08T10:05:00.000Z" }] };
    view.rerender(finished);
    await act(async () => {});
    expect(view.result.current.referencing).toBe(true);
    expect(view.result.current.isReferencing()).toBe(true);
    expect(onCommand.mock.calls.map(([type]) => type)).toEqual(["conversation.context.remove", "conversation.context.create"]);
    expect(onCommand).toHaveBeenNthCalledWith(1, "conversation.context.remove", {
      type: "conversation.context.remove",
      payload: { packetId: draft().id, targetConversationId: target },
    });
    expect(onCommand).toHaveBeenNthCalledWith(2, "conversation.context.create", {
      type: "conversation.context.create",
      payload: { sourceConversationId: source.conversationId, targetConversationId: target, acknowledgedWorkspaceDifference: false },
    });

    view.rerender({ ...finished, contextPackets: [] });
    expect(view.result.current.referencing).toBe(true);
    await act(async () => creation.resolve(created(refreshed)));
    view.rerender({ ...finished, contextPackets: [refreshed] });
    await act(async () => {});
    expect(view.result.current.referencing).toBe(false);
    expect(view.result.current.contextPacketIds).toEqual([refreshed.id]);
    expect(view.result.current.confirmation).toBeNull();
    expect(onCommand).toHaveBeenCalledTimes(2);
  });

  it("leaves a reference alone when the source turn finished before the copy", async () => {
    const onCommand = vi.fn();
    const { props, view } = setup({}, onCommand);
    view.rerender({ ...props, contextSources: [{ ...source, latestTurnCompletedAt: "2026-10-08T09:59:59.000Z" }] });
    await act(async () => {});
    expect(onCommand).not.toHaveBeenCalled();
  });

  it("waits while the message is being sent or this chat is still running", async () => {
    const onCommand = vi.fn(async (type: string) => type === "conversation.context.create"
      ? created(draft({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", createdAt: "2026-10-08T10:05:01.000Z" }))
      : { type: "request.ok", requestId: "remove" } as ServerEvent);
    const { props, view } = setup({ paused: true }, onCommand);
    const finished = { ...props, contextSources: [{ ...source, latestTurnCompletedAt: "2026-10-08T10:05:00.000Z" }] };
    view.rerender(finished);
    await act(async () => {});
    expect(onCommand).not.toHaveBeenCalled();
    view.rerender({ ...finished, paused: false });
    await act(async () => {});
    expect(onCommand.mock.calls.map(([type]) => type)).toEqual(["conversation.context.remove", "conversation.context.create"]);
  });

  it("recopies this chat's earlier messages once its own running turn finishes", async () => {
    const own = draft({ sourceConversationId: target, sourceConversationTitle: "Provider boundary review" });
    const onCommand = vi.fn(async (type: string) => type === "conversation.context.create"
      ? created({ ...own, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", createdAt: "2026-10-08T10:05:01.000Z" })
      : { type: "request.ok", requestId: "remove" } as ServerEvent);
    const { props, view } = setup({ contextPackets: [own], paused: true }, onCommand);
    view.rerender({ ...props, paused: false, latestTurnCompletedAt: "2026-10-08T10:05:00.000Z" });
    await act(async () => {});
    expect(onCommand).toHaveBeenLastCalledWith("conversation.context.create", {
      type: "conversation.context.create",
      payload: { sourceConversationId: target, targetConversationId: target, acknowledgedWorkspaceDifference: false },
    });
  });

  it("keeps the earlier workspace consent when it recopies a cross-workspace reference", async () => {
    const other = { ...source, workspaceRelation: "different-workspace" as const };
    const onCommand = vi.fn(async (type: string) => type === "conversation.context.create"
      ? created(draft({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspaceRelation: "different-workspace", createdAt: "2026-10-08T10:05:01.000Z" }))
      : { type: "request.ok", requestId: "remove" } as ServerEvent);
    const { props, view } = setup({
      contextSources: [other],
      contextPackets: [draft({ workspaceRelation: "different-workspace" })],
    }, onCommand);
    view.rerender({ ...props, contextSources: [{ ...other, latestTurnCompletedAt: "2026-10-08T10:05:00.000Z" }] });
    await act(async () => {});
    expect(view.result.current.confirmation).toBeNull();
    expect(onCommand).toHaveBeenLastCalledWith("conversation.context.create", expect.objectContaining({
      payload: expect.objectContaining({ acknowledgedWorkspaceDifference: true }),
    }));
  });

  it("does not recreate a reference it could not remove", async () => {
    const onCommand = vi.fn(async (_type: string): Promise<ServerEvent> => { throw new Error("already sent"); });
    const { props, view } = setup({}, onCommand);
    view.rerender({ ...props, contextSources: [{ ...source, latestTurnCompletedAt: "2026-10-08T10:05:00.000Z" }] });
    await act(async () => {});
    expect(onCommand.mock.calls.map(([type]) => type)).toEqual(["conversation.context.remove"]);
    expect(view.result.current.referencing).toBe(false);
  });
});
