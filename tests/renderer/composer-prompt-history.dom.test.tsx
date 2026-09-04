import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../../src/renderer/src/components/Composer";
import type {
  AgentTurn,
  ChatAttachment,
  Conversation,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import type { ComposerAttachmentImportLease } from "../../src/renderer/src/utils/composerAttachments";
import { notifyComposerStopRestore } from "../../src/renderer/src/utils/composerStopRestore";

const provider: ProviderInfo = {
  id: "codex",
  label: "Codex",
  command: "codex",
  available: true,
  version: "1.0.0",
  executable: "/opt/bin/codex",
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

function conversation(id = "conversation-history"): Conversation {
  return {
    id,
    projectId: "11111111-1111-4111-8111-111111111111",
    title: "History",
    providerId: "codex",
    modelSelection: nativeModelSelection({
      providerId: "codex",
      modelId: "provider-default",
      reasoningEffort: null,
    }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: "main",
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: null,
    createdAt: "2026-09-04T08:00:00.000Z",
    updatedAt: "2026-09-04T08:00:00.000Z",
  };
}

function turn(update: Partial<AgentTurn> = {}): AgentTurn {
  const modelSelection = nativeModelSelection({
    providerId: "codex",
    modelId: "provider-default",
    reasoningEffort: null,
  });
  return {
    id: "turn-latest",
    conversationId: "conversation-history",
    runId: "run-latest",
    userMessageId: "message-latest",
    terminalAssistantMessageId: null,
    providerId: "codex",
    modelSelection,
    continuationIdentity: continuationIdentityForSelection(modelSelection),
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "provider-default",
    modelAlias: null,
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: "2026-09-04T08:00:00.000Z",
    startedAt: "2026-09-04T08:00:01.000Z",
    completedAt: null,
    status: "running",
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 0,
    association: "authoritative",
    createdAt: "2026-09-04T08:00:00.000Z",
    updatedAt: "2026-09-04T08:00:01.000Z",
    ...update,
  };
}

function attachment(): ChatAttachment {
  return {
    id: "attachment-current",
    name: "current.png",
    path: "/private/tmp/current.png",
    mimeType: "image/png",
    size: 128,
  };
}

function props(
  overrides: Partial<React.ComponentProps<typeof Composer>> = {},
): React.ComponentProps<typeof Composer> {
  return {
    conversation: conversation(),
    providers: [provider],
    actions: [],
    disabled: false,
    sending: false,
    running: false,
    mentionResults: [],
    usage: null,
    usageDisplayMode: "compact",
    skills: [],
    skillsCapability: null,
    skillsLoading: false,
    skillsError: null,
    promptHistory: [
      { id: "message-oldest", content: "Oldest prompt" },
      { id: "message-middle", content: "Middle prompt" },
      { id: "message-latest", content: "Latest prompt" },
    ],
    onSend: async () => undefined,
    onListSkills: async () => undefined,
    onUpdateConversation: async () => undefined,
    onCreateConversationForSelection: async () => undefined,
    onChooseAttachments: async () => null,
    onImportAttachments: async () => null,
    onReleaseAttachment: async () => undefined,
    onRunAction: () => undefined,
    onMentionQuery: () => undefined,
    onConnectProvider: () => undefined,
    onRefreshProvider: () => undefined,
    onOpenProviderSetup: () => undefined,
    onOpenBackendSetup: () => undefined,
    onOpenResume: () => undefined,
    onProbeBackendProfile: async () => undefined,
    onUsageDisplayModeChange: () => undefined,
    onStop: async () => undefined,
    ...overrides,
  };
}

function press(input: HTMLElement, key: "ArrowUp" | "ArrowDown"): void {
  fireEvent.keyDown(input, {
    key,
    code: key,
    keyCode: key === "ArrowUp" ? 38 : 40,
  });
}

afterEach(() => {
  window.localStorage.clear();
});

describe("composer prompt history", () => {
  it("walks older and newer prompts without losing the scratch draft", () => {
    render(<Composer {...props({ conversation: conversation("history-walk") })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Unsent scratch" } });

    press(input, "ArrowUp");
    expect(input).toHaveValue("Latest prompt");
    press(input, "ArrowUp");
    expect(input).toHaveValue("Middle prompt");
    press(input, "ArrowUp");
    expect(input).toHaveValue("Oldest prompt");
    press(input, "ArrowUp");
    expect(input).toHaveValue("Oldest prompt");
    press(input, "ArrowDown");
    expect(input).toHaveValue("Middle prompt");
    press(input, "ArrowDown");
    expect(input).toHaveValue("Latest prompt");
    press(input, "ArrowDown");
    expect(input).toHaveValue("Unsent scratch");
  });

  it("keeps edits to recalled prompts while browsing the same history", () => {
    render(<Composer {...props({ conversation: conversation("history-edits") })} />);
    const input = screen.getByRole("textbox", { name: "Message" });

    press(input, "ArrowUp");
    fireEvent.change(input, { target: { value: "Edited latest prompt" } });
    press(input, "ArrowUp");
    expect(input).toHaveValue("Middle prompt");
    press(input, "ArrowDown");
    expect(input).toHaveValue("Edited latest prompt");
  });

  it("recalls a newly sent history edit after the composer clears", async () => {
    const current = conversation("history-resend");
    const onSend = vi.fn(async () => undefined);
    const baseProps = props({ conversation: current, onSend });
    const view = render(<Composer {...baseProps} />);
    const input = screen.getByRole("textbox", { name: "Message" });

    press(input, "ArrowUp");
    fireEvent.change(input, { target: { value: "Edited and resent prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith(
      "Edited and resent prompt",
      [],
      undefined,
    ));
    await waitFor(() => expect(input).toHaveValue(""));

    const appendedHistory = [
      ...(baseProps.promptHistory ?? []),
      { id: "message-resent", content: "Edited and resent prompt" },
    ];
    view.rerender(<Composer
      {...baseProps}
      running
      promptHistory={appendedHistory}
    />);
    view.rerender(<Composer
      {...baseProps}
      promptHistory={appendedHistory}
    />);
    press(input, "ArrowUp");
    expect(input).toHaveValue("Edited and resent prompt");
    press(input, "ArrowDown");
    expect(input).toHaveValue("");
  });

  it("does not navigate history while a submission owns the editor", async () => {
    let accept!: () => void;
    const onSend = vi.fn(() => new Promise<void>((resolve) => {
      accept = resolve;
    }));
    render(<Composer {...props({
      conversation: conversation("history-submitting"),
      onSend,
    })} />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Submitting draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());

    press(input, "ArrowUp");
    expect(input).toHaveValue("Submitting draft");
    await act(async () => accept());
    expect(input).toHaveValue("");
  });

  it("preserves current attachments when recalling text", async () => {
    const lease: ComposerAttachmentImportLease = {
      attachments: [attachment()],
      commit: async () => undefined,
      cancel: async () => undefined,
    };
    render(<Composer {...props({
      conversation: conversation("history-attachments"),
      onChooseAttachments: async () => lease,
    })} />);
    fireEvent.click(screen.getByRole("button", {
      name: "Attach images, documents, or spreadsheets",
    }));
    await screen.findByText("current.png");

    press(screen.getByRole("textbox", { name: "Message" }), "ArrowUp");
    expect(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Latest prompt");
    expect(screen.getByText("current.png")).toBeVisible();
  });

  it("restores the exact root prompt only after its turn is cancelled", async () => {
    const current = conversation("cancel-restore");
    const runningTurn = turn({ conversationId: current.id });
    const onStop = vi.fn(async () => {
      notifyComposerStopRestore({
        phase: "start",
        requestId: "stop-1",
        conversationId: runningTurn.conversationId,
        turnId: runningTurn.id,
        messageId: runningTurn.userMessageId,
        text: "Latest prompt",
      });
    });
    const view = render(<Composer {...props({
      running: true,
      conversation: current,
      latestTurn: runningTurn,
      onStop,
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    await waitFor(() => expect(onStop).toHaveBeenCalledOnce());
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");

    view.rerender(<Composer {...props({
      running: false,
      conversation: current,
      latestTurn: turn({ status: "cancelled" }),
      onStop,
    })} />);
    await waitFor(() => expect(
      screen.getByRole("textbox", { name: "Message" }),
    ).toHaveValue("Latest prompt"));
    expect(window.localStorage.getItem(
      `inertia:draft:${runningTurn.conversationId}`,
    )).toBe("Latest prompt");
  });

  it("never overwrites a newer edit while cancellation settles", async () => {
    const current = conversation("cancel-race");
    const runningTurn = turn({ conversationId: current.id });
    const onStop = vi.fn(async () => {
      notifyComposerStopRestore({
        phase: "start",
        requestId: "stop-2",
        conversationId: runningTurn.conversationId,
        turnId: runningTurn.id,
        messageId: runningTurn.userMessageId,
        text: "Latest prompt",
      });
    });
    const view = render(<Composer {...props({
      running: true,
      conversation: current,
      latestTurn: runningTurn,
      onStop,
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    await waitFor(() => expect(onStop).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Keep this newer edit" },
    });
    view.rerender(<Composer {...props({
      running: false,
      conversation: current,
      latestTurn: turn({ status: "cancelled" }),
      onStop,
    })} />);

    await act(async () => undefined);
    expect(screen.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Keep this newer edit");
  });

  it("discards a restoration claim when Stop fails", async () => {
    const current = conversation("cancel-failed");
    const runningTurn = turn({ conversationId: current.id });
    const detail = {
      requestId: "stop-failed",
      conversationId: current.id,
      turnId: runningTurn.id,
      messageId: runningTurn.userMessageId,
      text: "Latest prompt",
    };
    const onStop = vi.fn(async () => {
      notifyComposerStopRestore({ ...detail, phase: "start" });
      notifyComposerStopRestore({ ...detail, phase: "failed" });
      throw new Error("Stop failed");
    });
    const view = render(<Composer {...props({
      conversation: current,
      running: true,
      latestTurn: runningTurn,
      onStop,
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
    await waitFor(() => expect(onStop).toHaveBeenCalledOnce());
    view.rerender(<Composer {...props({
      conversation: current,
      running: false,
      latestTurn: turn({
        conversationId: current.id,
        status: "cancelled",
      }),
      onStop,
    })} />);

    await act(async () => undefined);
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  });
});
