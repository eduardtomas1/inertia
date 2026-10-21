import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResponseTimeline } from "../../src/renderer/src/components/ResponseTimeline";
import { TOOLTIP_DELAY_MS } from "../../src/renderer/src/components/Tooltip";
import { WatcherWakeRequest } from "../../src/renderer/src/components/response-timeline/WatcherWakeRequest";
import type { ResponseTurn } from "../../src/renderer/src/utils/response-timeline/model";
import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import type { WatcherNoteAttribution, WatcherWakeSummary } from "../../src/shared/watcher";
import { providerNativeBackendProfile } from "../../src/shared/model-routing";
import { LINK_ID, WATCHER_ID, wakeId } from "./watcher-fixtures";

const conversationId = "99999999-9999-4999-8999-999999999999";

afterEach(() => {
  vi.useRealTimers();
});

function turn(id: string, requestedAt: string): AgentTurn {
  const backendProfileId = providerNativeBackendProfile("codex").id;
  return {
    id,
    conversationId,
    runId: `run-${id}`,
    userMessageId: `user-${id}`,
    terminalAssistantMessageId: `assistant-${id}`,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId,
      backendProfileDisplayName: providerNativeBackendProfile("codex").displayName,
      modelId: "fixture-model",
      alias: null,
      reasoningEffort: null,
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
      backendConfigurationRevision: 1,
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId,
      backendConfigurationRevision: 1,
      modelIdentity: "fixture-model",
      endpointIdentity: null,
    },
    harnessId: "codex-app-server",
    backendProfileId,
    model: "fixture-model",
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "auto-edit",
    providerSessionBefore: null,
    providerSessionAfter: `session-${id}`,
    requestedAt,
    startedAt: requestedAt,
    completedAt: requestedAt,
    status: "completed",
    terminalReason: "provider-completed",
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: requestedAt,
    updatedAt: requestedAt,
  };
}

const note: WatcherNoteAttribution = {
  linkId: LINK_ID,
  wakeId: wakeId(4),
  watcherConversationId: WATCHER_ID,
  preset: "reviewer",
  watcherLabel: "Team Codex fixture-model",
  delivery: "queue",
};

function messages(agentTurn: AgentTurn, request: string, extra: Partial<ChatMessage> = {}): ChatMessage[] {
  return [
    { id: agentTurn.userMessageId, conversationId, turnId: agentTurn.id, role: "user", content: request, attachments: [], createdAt: agentTurn.requestedAt, ...extra },
    { id: agentTurn.terminalAssistantMessageId!, conversationId, turnId: agentTurn.id, role: "assistant", content: `Answer ${agentTurn.id}`, attachments: [], createdAt: agentTurn.completedAt! },
  ];
}

function timeline(turns: AgentTurn[], allMessages: ChatMessage[], watcherWakes?: WatcherWakeSummary[]) {
  return render(<ResponseTimeline
    turns={turns}
    messages={allMessages}
    watcherWakes={watcherWakes}
    activities={[]}
    reasonings={[]}
    plans={[]}
    checkpoints={[]}
    projectRoot="/workspace"
    projectId="project-watcher-note"
    conversationId={conversationId}
    streamingText=""
    streamingReasoning=""
    streamingChannel={null}
    approvals={[]}
    inputRequests={[]}
    showTimestamps={false}
    showThinking
    defaultCodeWrap={false}
    autoCollapseWorkLog
    showChangedFileSummaries={false}
    checkpointRestoreDisabled
    onRespondToApproval={async () => undefined}
    onRespondToInput={async () => undefined}
    onRevertCheckpoint={() => undefined}
    onOpenTurnDiff={() => undefined}
    onCompareTurnArtifacts={() => undefined}
    onOpenTurnFile={() => undefined}
    onStop={() => undefined}
  />);
}

describe("watcher note divider", () => {
  const first = turn("turn-a", "2026-10-19T10:00:00.000Z");
  const forwarded = turn("turn-b", "2026-10-19T10:05:00.000Z");

  it("marks the turn a forwarded note started with the preset and the watcher's agent", () => {
    const { container } = timeline([first, forwarded], [
      ...messages(first, "Refactor the parser"),
      ...messages(forwarded, "The rename misses two call sites.", { watcherNote: note }),
    ]);
    const separator = screen.getByRole("separator", { name: "Note from watcher · Reviewer · Team Codex fixture-model" });
    const row = separator.closest<HTMLElement>("section.watcher-note-row")!;
    expect(row).toHaveAttribute("data-response-row-id", "watcher-note:turn-b");
    expect(row).toHaveAttribute("tabindex", "-1");
    expect(row.querySelector(".provider-handoff-marker")).toHaveAttribute("aria-hidden", "true");
    const before = container.querySelector('[data-turn-id="turn-a"]')!;
    const after = container.querySelector('[data-turn-id="turn-b"]')!;
    expect(before.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the watcher's provider mark beside its agent, like the handoff divider", () => {
    timeline([forwarded], messages(forwarded, "The rename misses two call sites.", { watcherNote: { ...note, providerId: "codex" } }));
    const separator = screen.getByRole("separator", { name: "Note from watcher · Reviewer · Team Codex fixture-model" });
    const route = separator.querySelector<HTMLElement>(".provider-handoff-route")!;
    expect(route).toHaveTextContent(/^Team Codex fixture-model$/u);
    const mark = route.querySelector<HTMLElement>(".provider-brand-icon")!;
    expect(route.firstElementChild).toBe(mark);
    expect(mark).toHaveAttribute("data-provider-id", "codex");
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark.style.getPropertyValue("--provider-icon-size")).toBe("14px");
  });

  it("keeps the agent as plain text when the note names no provider", () => {
    timeline([forwarded], messages(forwarded, "The rename misses two call sites.", { watcherNote: note }));
    const separator = screen.getByRole("separator", { name: "Note from watcher · Reviewer · Team Codex fixture-model" });
    expect(separator.querySelector(".provider-brand-icon")).toBeNull();
    expect(separator.querySelector(".provider-handoff-marker")).toHaveTextContent("Note from watcher·Reviewer·Team Codex fixture-model");
  });

  it("never presents the note as the user's own words", () => {
    timeline([forwarded], messages(forwarded, "The rename misses two call sites.", { watcherNote: note }));
    const request = document.querySelector<HTMLElement>('[data-turn-id="turn-b"] [data-turn-layer="user-request"]')!;
    expect(request).toHaveAttribute("aria-label", "Note from watcher");
    expect(within(request).getByText("From watcher")).toBeInTheDocument();
    expect(within(request).queryByText(/Note from watcher ·/u)).not.toBeInTheDocument();
  });

  it.each([
    [false, "Forwarded by the watcher (Reviewer · Team Codex fixture-model) when you chose Send"],
    [true, "Sent automatically by the watcher (Reviewer · Team Codex fixture-model)"],
  ])("says who sent the note in its origin tooltip when automatic is %s", (automatic, expected) => {
    vi.useFakeTimers();
    const attribution: WatcherNoteAttribution = { ...note, delivery: "queue", automatic };
    timeline([forwarded], messages(forwarded, "The rename misses two call sites.", { watcherNote: attribution }));
    fireEvent.pointerEnter(screen.getByText("From watcher"), { pointerType: "mouse" });
    act(() => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent(expected);
  });

  it("draws no divider for ordinary turns", () => {
    timeline([first], messages(first, "Refactor the parser"));
    expect(screen.queryByRole("separator", { name: /Note from watcher/u })).not.toBeInTheDocument();
    expect(document.querySelector('[data-turn-layer="user-request"]')).toHaveAttribute("aria-label", "Your request");
  });
});

describe("watcher check rows", () => {
  it("shows each check as Check N · K events with the digest behind a disclosure", () => {
    const check = turn("turn-check", "2026-10-19T10:10:00.000Z");
    timeline([check], messages(check, "Check 4 for 'Refactor parser' · digest body"), [{
      wakeId: wakeId(4),
      turnId: "turn-check",
      sequence: 4,
      trigger: "turn-end",
      outcome: "silent",
      eventsCovered: 9,
      itemsTruncated: 1,
      itemsOmitted: 0,
      guardState: "clean",
    }]);
    const row = screen.getByRole("article", { name: "Check 4 · 9 events" });
    expect(row).toHaveTextContent("Final check");
    expect(row).toHaveTextContent(/Nothing to report(?!\.)/u);
    expect(row).toHaveTextContent("1 shortened");
    const summary = within(row).getByText("What the watcher was shown");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(within(details).getByText("Check 4 for 'Refactor parser' · digest body")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Your request" })).not.toBeInTheDocument();
  });

  it("keeps the transcript anchored while the digest opens", async () => {
    const before = vi.fn();
    const after = vi.fn();
    const check = {
      id: "turn-check",
      userMessage: { id: "user-turn-check", content: "digest body" },
      watcherWake: { sequence: 4, trigger: "turn-end", outcome: "silent", eventsCovered: 9, itemsTruncated: 0, itemsOmitted: 0 },
    } as unknown as ResponseTurn;
    render(<WatcherWakeRequest turn={check} onBeforeToggle={before} onAfterToggle={after} />);
    fireEvent.click(screen.getByText("What the watcher was shown"));
    expect(before).toHaveBeenCalledOnce();
    await waitFor(() => expect(after).toHaveBeenCalledOnce());
  });
});
