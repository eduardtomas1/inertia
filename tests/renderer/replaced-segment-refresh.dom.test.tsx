import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerEvent } from "../../src/shared/contracts";
import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { StreamingResponseTimeline } from "../../src/renderer/src/components/response-timeline/streaming-timeline";
import { useConversationProjection } from "../../src/renderer/src/hooks/useConversationProjection";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import {
  cleanupTurnControllerTestDirectories, createTurnControllerTestRuntime, turnControllerTestIdentity,
  type TurnControllerTestRuntime,
} from "../support/turn-controller-runtime";

afterEach(async () => { cleanup(); await cleanupTurnControllerTestDirectories(); });

/**
 * A real turn controller streams into the real renderer projection: its broadcasts are the renderer's events and
 * its store answers the renderer's detail loads, so a detail refresh happens only when the runtime asks for one.
 */
async function connected() {
  const listeners = new Set<(event: ServerEvent) => void>();
  const runtime: TurnControllerTestRuntime = await createTurnControllerTestRuntime({
    broadcast: (event) => { act(() => { for (const listener of listeners) listener(event as ServerEvent); }); },
  });
  const queued = runtime.controller.queue({ conversationId: runtime.conversationId, content: "Inspect the parser." });
  runtime.controller.start(queued.turn.id);
  const identity = turnControllerTestIdentity(runtime);
  const request = vi.fn(async (command: CommandWithoutId): Promise<ServerEvent> => {
    if (command.type !== "conversation.detail.load") return { type: "request.ok", requestId: crypto.randomUUID() } as ServerEvent;
    const detail = runtime.store.conversationHistory(runtime.conversationId, command.payload.history);
    return { type: "request.result", requestId: crypto.randomUUID(),
      result: { kind: "conversation.detail", conversationId: runtime.conversationId, state: "ready", detail } } as unknown as ServerEvent;
  });
  const subscribe = (listener: (event: ServerEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const flush = () => act(() => {
    for (const [id, callback] of runtime.scheduler.callbacks) {
      if ((runtime.scheduler.delays.get(id) ?? Infinity) < 1_000) { runtime.scheduler.clearTimeout(id); callback(); }
    }
  });
  const emit = (event: Record<string, unknown>) => act(() => { runtime.provider.emit({ ...identity, ...event } as never); });
  return { runtime, request, subscribe, flush, emit };
}

function Transcript({ connection }: { connection: Awaited<ReturnType<typeof connected>> }): React.JSX.Element {
  const snapshot = { ...connection.runtime.store.shellSnapshot(), activeConversationId: connection.runtime.conversationId };
  const projection = useConversationProjection({ snapshot, status: "online", request: connection.request,
    subscribe: connection.subscribe, enabled: true, autoOpenPlan: false, onOpenPlan: () => undefined, onTerminal: () => undefined });
  const noop = (): void => undefined;
  const respond = async (): Promise<void> => undefined;
  return (
    <StreamingResponseTimeline ResponseTimeline={ResponseTimeline} streaming={projection.streaming}
      onStreamingContent={() => undefined} turns={projection.turns} messages={projection.messages}
      activities={projection.activities} reasonings={projection.reasonings} plans={projection.plans}
      checkpoints={projection.checkpoints} projectRoot="/workspace" projectId="project"
      conversationId={connection.runtime.conversationId} approvals={[]} inputRequests={[]} showTimestamps={false}
      showThinking={false} defaultCodeWrap={false} autoCollapseWorkLog={false} showChangedFileSummaries={false}
      checkpointRestoreDisabled={false} onRespondToApproval={respond} onRespondToInput={respond} onRevertCheckpoint={noop}
      onOpenTurnDiff={noop} onCompareTurnArtifacts={noop} onOpenTurnFile={noop} onStop={noop} />
  );
}

const rows = () => [...document.querySelectorAll(".turn-commentary-row")].map((row) => row.textContent?.trim() ?? "");

describe("a segment the provider replaces while the transcript holds its persisted text", () => {
  async function streamedAbandonedSegment() {
    const connection = await connected();
    connection.emit({ type: "status", status: "running" });
    connection.emit({ type: "text", text: "Checked the parser." });
    connection.emit({ type: "activity", kind: "tool", phase: "completed", label: "read", activityId: "t-1" });
    connection.emit({ type: "text", text: "Abandoned attempt." });
    connection.flush();
    // The transcript opens now, so its detail holds the open segment's persisted, soon abandoned, text.
    render(<Transcript connection={connection} />);
    await waitFor(() => expect(rows().some((row) => row.includes("Abandoned attempt."))).toBe(true));
    return connection;
  }

  it("drops the abandoned text once the runtime's replacement reaches it", async () => {
    const connection = await streamedAbandonedSegment();
    connection.emit({ type: "text-snapshot", itemId: "pi:2:text", text: "Replacement.", scope: "segment" });
    await waitFor(() => expect(rows().some((row) => row.includes("Abandoned attempt."))).toBe(false));
    expect(rows().filter((row) => row.includes("Replacement."))).toHaveLength(1);
    connection.runtime.store.close();
  });

  it("shows no empty entry while an emptied segment waits for more text", async () => {
    const connection = await streamedAbandonedSegment();
    connection.emit({ type: "text-snapshot", itemId: "pi:2:text", text: "", scope: "segment" });
    await waitFor(() => expect(rows().some((row) => row.includes("Abandoned attempt."))).toBe(false));
    expect(rows()).toEqual(["Checked the parser."]);
    connection.emit({ type: "text", text: "Fresh text." });
    connection.flush();
    await waitFor(() => expect(rows()).toEqual(["Checked the parser.", "Fresh text."]));
    connection.runtime.store.close();
  });
});
