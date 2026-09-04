import { StrictMode } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ChatAttachment,
  Conversation,
  ConversationContextPacketSummary,
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { Composer } from "../../src/renderer/src/components/Composer";
import {
  composerMediaQueueKey,
  enqueueComposerPrompt,
} from "../../src/renderer/src/components/composer/composerQueuedPrompts";
import {
  prepareComposerDetachment,
  registerComposerOwnership,
} from "../../src/renderer/src/utils/composerOwnership";
import type { ComposerAttachmentImportLease } from "../../src/renderer/src/utils/composerAttachments";

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

function conversation(id: string): Conversation {
  return {
    id,
    projectId: "11111111-1111-4111-8111-111111111111",
    title: id,
    providerId: "codex",
    modelSelection: providerNativeModelSelection({
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
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-20T08:00:00.000Z",
  };
}

function attachment(id: string): ChatAttachment {
  return {
    id,
    name: `${id}.png`,
    path: `/private/tmp/${id}.png`,
    mimeType: "image/png",
    size: 128,
  };
}

function attachmentLease(attachments: ChatAttachment[]): ComposerAttachmentImportLease {
  return {
    attachments,
    commit: async () => undefined,
    cancel: async () => undefined,
  };
}

function contextPacket(
  current: Conversation,
  consumedMessageId: string | null,
): ConversationContextPacketSummary {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    sourceConversationId: "44444444-4444-4444-8444-444444444444",
    targetConversationId: current.id,
    sourceProjectId: "55555555-5555-4555-8555-555555555555",
    targetProjectId: current.projectId,
    sourceConversationTitle: "Reviewed context",
    sourceProjectName: "Inertia",
    sourceWorkspaceLabel: "Project checkout · main",
    targetWorkspaceLabel: "Project checkout · main",
    workspaceRelation: "same-workspace",
    note: null,
    messageCount: 1,
    characterCount: 42,
    createdAt: current.createdAt,
    consumedMessageId,
    consumedAt: consumedMessageId ? current.updatedAt : null,
    sourceState: "available",
  };
}

function composerProps(
  current: Conversation,
  overrides: Partial<React.ComponentProps<typeof Composer>> = {},
): React.ComponentProps<typeof Composer> {
  return {
    conversation: current,
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
    onProbeBackendProfile: async () => undefined,
    onUsageDisplayModeChange: () => undefined,
    onOpenResume: () => undefined,
    onStop: async () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("composer detachment ownership", () => {
  it("flushes the exact pending text and permits a text-only draft in Strict Mode", () => {
    vi.useFakeTimers();
    const current = conversation("text-draft");
    const view = render(
      <StrictMode>
        <Composer {...composerProps(current)} />
      </StrictMode>,
    );
    const input = screen.getByRole("textbox", { name: "Message" });

    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "an exact pending draft" } });
    expect(window.localStorage.getItem(`inertia:draft:${current.id}`)).toBe("a");

    expect(prepareComposerDetachment(current.id)).toEqual({
      status: "ready",
      draft: "an exact pending draft",
    });
    expect(window.localStorage.getItem(`inertia:draft:${current.id}`))
      .toBe("an exact pending draft");

    view.unmount();
    expect(prepareComposerDetachment(current.id)).toEqual({
      status: "ready",
      draft: "an exact pending draft",
    });
  });

  it("returns a persisted draft when its composer is not mounted", () => {
    window.localStorage.setItem(
      "inertia:draft:inactive-chat",
      "draft from an inactive sidebar chat",
    );

    expect(prepareComposerDetachment("inactive-chat")).toEqual({
      status: "ready",
      draft: "draft from an inactive sidebar chat",
    });
  });

  it("does not let stale ownership cleanup remove a replacement", () => {
    const firstCleanup = registerComposerOwnership("replacement", () => ({
      status: "blocked",
      blocker: "attachments",
      reason: "first",
      draft: "first draft",
    }));
    const secondCleanup = registerComposerOwnership("replacement", () => ({
      status: "blocked",
      blocker: "prompt-context",
      reason: "replacement",
      draft: "replacement draft",
    }));

    firstCleanup();
    expect(prepareComposerDetachment("replacement")).toEqual({
      status: "blocked",
      blocker: "prompt-context",
      reason: "replacement",
      draft: "replacement draft",
    });

    secondCleanup();
    expect(prepareComposerDetachment("replacement")).toEqual({ status: "ready", draft: "" });
  });

  it("reports context blockers for the owning conversation", () => {
    const diffOwner = conversation("diff-owner");
    const previewOwner = conversation("preview-owner");
    render(
      <>
        <section aria-label="Diff owner">
          <Composer {...composerProps(diffOwner, {
            promptContext: "Diff selection for src/index.ts",
          })} />
        </section>
        <section aria-label="Preview owner">
          <Composer {...composerProps(previewOwner, {
            previewContextUrl: "http://127.0.0.1:4173/preview",
          })} />
        </section>
      </>,
    );

    fireEvent.click(within(screen.getByRole("region", { name: "Preview owner" }))
      .getByRole("button", { name: /Attach current preview/u }));

    expect(prepareComposerDetachment(diffOwner.id)).toEqual({
      status: "blocked",
      blocker: "prompt-context",
      reason: "Remove the selected diff or review context before moving this chat to a window.",
      draft: "",
    });
    expect(prepareComposerDetachment(previewOwner.id)).toEqual({
      status: "blocked",
      blocker: "preview-context",
      reason: "Remove the selected preview before moving this chat to a window.",
      draft: "",
    });
  });

  it("blocks unsent chat context while allowing consumed provenance to move", () => {
    const draftOwner = conversation("draft-context-owner");
    const historyOwner = conversation("sent-context-owner");
    render(
      <>
        <Composer {...composerProps(draftOwner, {
          contextPackets: [contextPacket(draftOwner, null)],
        })} />
        <Composer {...composerProps(historyOwner, {
          contextPackets: [contextPacket(historyOwner, "sent-message")],
        })} />
      </>,
    );

    expect(prepareComposerDetachment(draftOwner.id)).toEqual({
      status: "blocked",
      blocker: "conversation-context",
      reason: "Send or remove shared chat context before moving this chat to a window.",
      draft: "",
    });
    expect(prepareComposerDetachment(historyOwner.id)).toEqual({ status: "ready", draft: "" });
  });

  it("removes handoff UI and opaque packet submission from chat-only composers", async () => {
    const current = conversation("chat-only-context-owner");
    const onSend = vi.fn(async () => undefined);
    render(<Composer {...composerProps(current, {
      conversationContextHandoffEnabled: false,
      contextPackets: [contextPacket(current, null)],
      contextSources: [{
        conversationId: "44444444-4444-4444-8444-444444444444",
        conversationTitle: "Reviewed context",
        projectName: "Inertia",
        workspaceRelation: "same-workspace",
        archived: false,
      }],
      onConversationContextCommand: vi.fn(async () => ({
        type: "request.ok" as const,
        requestId: crypto.randomUUID(),
      })),
      onSend,
    })} />);

    expect(screen.queryByRole("button", {
      name: "Add context from another chat",
    })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {
      name: /From Reviewed context/u,
    })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Keep this popup scoped to its current chat." },
    });
    expect(prepareComposerDetachment(current.id)).toEqual({
      status: "ready",
      draft: "Keep this popup scoped to its current chat.",
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend).toHaveBeenCalledWith(
      "Keep this popup scoped to its current chat.",
      [],
      undefined,
    );
  });

  it("reports attachment and file-reference blockers without losing the text draft", async () => {
    const attachmentOwner = conversation("attachment-owner");
    const referenceOwner = conversation("reference-owner");
    render(
      <>
        <section aria-label="Attachment owner">
          <Composer {...composerProps(attachmentOwner, {
            onChooseAttachments: async () => attachmentLease([
              attachment("pending"),
            ]),
          })} />
        </section>
        <section aria-label="Reference owner">
          <Composer {...composerProps(referenceOwner, {
            mentionResults: [{ path: "src/index.ts", kind: "file" }],
          })} />
        </section>
      </>,
    );
    const attachmentRegion = screen.getByRole("region", {
      name: "Attachment owner",
    });
    const referenceRegion = screen.getByRole("region", {
      name: "Reference owner",
    });

    fireEvent.change(within(attachmentRegion).getByRole("textbox", {
      name: "Message",
    }), { target: { value: "Keep this exact attachment draft" } });
    fireEvent.click(within(attachmentRegion).getByRole("button", {
      name: "Attach images, documents, or spreadsheets",
    }));
    await within(attachmentRegion).findByText("pending.png");

    fireEvent.change(within(referenceRegion).getByRole("textbox", {
      name: "Message",
    }), { target: { value: "@src" } });
    fireEvent.click(await within(referenceRegion).findByRole("option", {
      name: /src\/index\.ts/u,
    }));

    expect(prepareComposerDetachment(attachmentOwner.id)).toEqual({
      status: "blocked",
      blocker: "attachments",
      reason: "Send or remove attachments before moving this chat to a window.",
      draft: "Keep this exact attachment draft",
    });
    expect(window.localStorage.getItem(`inertia:draft:${attachmentOwner.id}`))
      .toBe("Keep this exact attachment draft");
    expect(prepareComposerDetachment(referenceOwner.id)).toEqual({
      status: "blocked",
      blocker: "file-references",
      reason: "Remove file references before moving this chat to a window.",
      draft: "@src/index.ts ",
    });
  });

  it("blocks detachment while renderer-session queued media owns capabilities", () => {
    const current = conversation("queued-media-owner");
    render(<Composer {...composerProps(current)} />);
    const queuedAttachment: ChatAttachment = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "queued.png",
      path: "11111111-1111-4111-8111-111111111111",
      mimeType: "image/png",
      size: 128,
    };
    expect(enqueueComposerPrompt(
      current.id,
      "Move only after this sends",
      [queuedAttachment],
    )).toBe(true);

    expect(prepareComposerDetachment(current.id)).toEqual({
      status: "blocked",
      blocker: "attachments",
      reason: "Send or remove attachments before moving this chat to a window.",
      draft: "",
    });
  });

  it("queues three provider-wide media turns and admits one per completion", async () => {
    const current = conversation("conversation-three-media-prompts");
    const attachments = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        name: "first.png",
        path: "11111111-1111-4111-8111-111111111111",
        mimeType: "image/png" as const,
        size: 128,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        name: "second.png",
        path: "22222222-2222-4222-8222-222222222222",
        mimeType: "image/png" as const,
        size: 128,
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        name: "third.png",
        path: "33333333-3333-4333-8333-333333333333",
        mimeType: "image/png" as const,
        size: 128,
      },
    ] satisfies ChatAttachment[];
    const onChooseAttachments = vi.fn()
      .mockResolvedValueOnce(attachmentLease([attachments[0]]))
      .mockResolvedValueOnce(attachmentLease([attachments[1]]))
      .mockResolvedValueOnce(attachmentLease([attachments[2]]));
    const onSend = vi.fn(async () => undefined);
    const onReleaseAttachment = vi.fn(async () => undefined);
    const runningTurn = {
      ...({} as NonNullable<React.ComponentProps<typeof Composer>["latestTurn"]>),
      id: "turn-before-media-queue",
      status: "running" as const,
      harnessId: "kimi-acp" as const,
    };
    const runningProps = {
      running: true,
      latestTurn: runningTurn,
      onChooseAttachments,
      onReleaseAttachment,
      onSend,
    };
    const view = render(<Composer {...composerProps(current, runningProps)} />);
    const textbox = screen.getByRole("textbox", { name: "Message" });

    for (const [index, content] of ["A", "B", "C"].entries()) {
      fireEvent.click(screen.getByRole("button", { name: "Attach queued images" }));
      await screen.findByText(attachments[index].name);
      fireEvent.change(textbox, { target: { value: content } });
      fireEvent.keyDown(textbox, { key: "Tab" });
      await waitFor(() => expect(textbox).toHaveValue(""));
    }

    // The queue is persisted synchronously, while its deferred UI chunk can
    // finish loading on a later render under a busy full-shard worker.
    expect(await screen.findByText("1 of 3")).toBeInTheDocument();
    expect(JSON.parse(window.sessionStorage.getItem(
      composerMediaQueueKey(current.id),
    ) ?? "[]")).toHaveLength(3);
    fireEvent.change(textbox, { target: { value: "D stays in the composer" } });
    fireEvent.keyDown(textbox, { key: "Tab" });
    await waitFor(() => expect(textbox).toHaveValue("D stays in the composer"));
    await act(async () => Promise.resolve());

    const completeTurn = async (id: string, callCount: number): Promise<void> => {
      view.rerender(<Composer {...composerProps(current, {
        latestTurn: { ...runningTurn, id, status: "completed" },
        onChooseAttachments,
        onReleaseAttachment,
        onSend,
      })} />);
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(callCount));
      if (callCount < 3) {
        view.rerender(<Composer {...composerProps(current, {
          ...runningProps,
          latestTurn: { ...runningTurn, id: `${id}-active` },
        })} />);
      }
    };

    await completeTurn("turn-completed-a", 1);
    await completeTurn("turn-completed-b", 2);
    await completeTurn("turn-completed-c", 3);
    expect(onSend.mock.calls).toEqual([
      ["A", [attachments[0]], undefined],
      ["B", [attachments[1]], undefined],
      ["C", [attachments[2]], undefined],
    ]);
    expect(onReleaseAttachment).not.toHaveBeenCalled();
    expect(textbox).toHaveValue("D stays in the composer");
    expect(window.sessionStorage.getItem(
      composerMediaQueueKey(current.id),
    )).toBeNull();
  });

  it("queues an attachment-only image with safe fallback content", async () => {
    const current = conversation("conversation-media-only-queue");
    const queuedImage: ChatAttachment = {
      id: "44444444-4444-4444-8444-444444444444",
      name: "inspect.png",
      path: "44444444-4444-4444-8444-444444444444",
      mimeType: "image/png",
      size: 128,
    };
    const onSend = vi.fn(async () => undefined);
    const runningTurn = {
      ...({} as NonNullable<React.ComponentProps<typeof Composer>["latestTurn"]>),
      id: "turn-before-media-only",
      status: "running" as const,
      harnessId: "cursor-acp" as const,
    };
    const view = render(<Composer {...composerProps(current, {
      running: true,
      latestTurn: runningTurn,
      onChooseAttachments: async () => attachmentLease([queuedImage]),
      onSend,
    })} />);

    fireEvent.click(screen.getByRole("button", { name: "Attach queued images" }));
    await screen.findByText(queuedImage.name);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), {
      key: "Tab",
    });
    expect(await screen.findByText("Please inspect the attached image."))
      .toBeInTheDocument();

    view.rerender(<Composer {...composerProps(current, {
      latestTurn: { ...runningTurn, status: "completed" },
      onSend,
    })} />);
    await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith(
      "Please inspect the attached image.",
      [queuedImage],
      undefined,
    ));
  });

  it("blocks while a composer mutation is in flight", async () => {
    let finishSend!: () => void;
    const send = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const current = conversation("sending-owner");
    render(<Composer {...composerProps(current, { onSend: () => send })} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "Send before moving" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(prepareComposerDetachment(current.id)).toEqual({
      status: "blocked",
      blocker: "mutation-in-flight",
      reason: "Wait for the current composer action to finish before moving this chat to a window.",
      draft: "Send before moving",
    });

    await act(async () => finishSend());
  });

  it.each([
    ["detachment", "native selection"],
    ["docking", "drop"],
  ] as const)("blocks %s while a delayed %s import is in flight", async (
    transition,
    source,
  ) => {
    let finishImport!: (value: ComposerAttachmentImportLease) => void;
    const importing = new Promise<ComposerAttachmentImportLease>((resolve) => {
      finishImport = resolve;
    });
    const current = conversation(`${transition}-importing-attachment-owner`);
    render(<Composer {...composerProps(current, source === "native selection"
      ? { onChooseAttachments: () => importing }
      : { onImportAttachments: () => importing })} />);

    if (source === "native selection") {
      fireEvent.click(screen.getByRole("button", {
        name: "Attach images, documents, or spreadsheets",
      }));
    } else {
      fireEvent.drop(screen.getByLabelText("Message composer"), {
        dataTransfer: {
          files: [new File(["image"], "imported.png", { type: "image/png" })],
          types: ["Files"],
        },
      });
    }
    await screen.findByText("Adding attachments…");

    expect(prepareComposerDetachment(current.id)).toEqual({
      status: "blocked",
      blocker: "mutation-in-flight",
      reason: "Wait for the current composer action to finish before moving this chat to a window.",
      draft: "",
    });

    await act(async () => finishImport(attachmentLease([
      attachment("imported"),
    ])));
    expect(prepareComposerDetachment(current.id)).toEqual({
      status: "blocked",
      blocker: "attachments",
      reason: "Send or remove attachments before moving this chat to a window.",
      draft: "",
    });
  });

  it("blocks a pending model-route transfer", async () => {
    const current = conversation("route-owner");
    current.modelSelection = providerNativeModelSelection({
      providerId: "codex",
      modelId: "codex-route",
      alias: "Codex Route",
      reasoningEffort: "high",
    });
    current.model = "codex-route";
    current.reasoningEffort = "high";
    current.continuationIdentity = continuationIdentityForSelection(
      current.modelSelection,
    );
    current.providerSessionId = "codex-session";
    const catalogState = {
      freshness: "fresh" as const,
      provenance: "provider" as const,
      updatedAt: "2026-08-20T08:00:00.000Z",
      lastAttemptedAt: "2026-08-20T08:00:00.000Z",
      refreshing: false,
    };
    const codexProvider: ProviderInfo = {
      ...provider,
      models: [{
        id: "codex-route",
        label: "Codex Route",
        description: "Current route",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [{ value: "high", label: "High", description: "" }],
        defaultReasoningEffort: "high",
      }],
      metadataState: { models: catalogState, rateLimits: catalogState },
    };
    const claudeProvider: ProviderInfo = {
      ...codexProvider,
      id: "claude",
      label: "Claude",
      models: [{
        ...codexProvider.models[0]!,
        id: "claude-route",
        label: "Claude Route",
        description: "Destination route",
      }],
    };
    render(<Composer {...composerProps(current, {
      providers: [codexProvider, claudeProvider],
      latestTurnSummary: {
        id: "turn-source",
        runId: "run-source",
        status: "completed",
        providerId: "codex",
        harnessId: current.modelSelection.harnessId,
        backendProfileId: current.modelSelection.backendProfileId,
        modelSelection: current.modelSelection,
        continuationIdentity: current.continuationIdentity,
        model: current.modelSelection.modelId,
        reasoningEffort: "high",
        requestedAt: current.createdAt,
        startedAt: current.createdAt,
        completedAt: current.updatedAt,
        terminalReason: null,
        updatedAt: current.updatedAt,
      },
    })} />);

    fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
    fireEvent.click(screen.getByRole("button", { name: "Claude, 2 models" }));
    const destination = screen.getByTitle("Claude Route").closest("button");
    if (!destination) throw new Error("Expected the destination model route.");
    fireEvent.click(destination);
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeVisible());

    expect(prepareComposerDetachment(current.id)).toEqual({
      status: "blocked",
      blocker: "pending-model-route",
      reason: "Finish or cancel the pending model change before moving this chat to a window.",
      draft: "",
    });
  });
});
