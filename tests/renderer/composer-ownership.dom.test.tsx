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
  ProviderInfo,
} from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  nativeModelSelection,
} from "../../src/shared/model-routing";
import { Composer } from "../../src/renderer/src/components/Composer";
import {
  prepareComposerDetachment,
  registerComposerOwnership,
} from "../../src/renderer/src/utils/composerOwnership";

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
    onChooseAttachments: async () => [],
    onImportAttachments: async () => [],
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

    expect(prepareComposerDetachment(current.id)).toEqual({ status: "ready" });
    expect(window.localStorage.getItem(`inertia:draft:${current.id}`))
      .toBe("an exact pending draft");

    view.unmount();
    expect(prepareComposerDetachment(current.id)).toEqual({ status: "ready" });
  });

  it("does not let stale ownership cleanup remove a replacement", () => {
    const firstCleanup = registerComposerOwnership("replacement", () => ({
      status: "blocked",
      blocker: "attachments",
      reason: "first",
    }));
    const secondCleanup = registerComposerOwnership("replacement", () => ({
      status: "blocked",
      blocker: "prompt-context",
      reason: "replacement",
    }));

    firstCleanup();
    expect(prepareComposerDetachment("replacement")).toEqual({
      status: "blocked",
      blocker: "prompt-context",
      reason: "replacement",
    });

    secondCleanup();
    expect(prepareComposerDetachment("replacement")).toEqual({ status: "ready" });
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
    });
    expect(prepareComposerDetachment(previewOwner.id)).toEqual({
      status: "blocked",
      blocker: "preview-context",
      reason: "Remove the selected preview before moving this chat to a window.",
    });
  });

  it("reports attachment and file-reference blockers without losing the text draft", async () => {
    const attachmentOwner = conversation("attachment-owner");
    const referenceOwner = conversation("reference-owner");
    render(
      <>
        <section aria-label="Attachment owner">
          <Composer {...composerProps(attachmentOwner, {
            onChooseAttachments: async () => [attachment("pending")],
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
      name: "Attach images or documents",
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
    });
    expect(window.localStorage.getItem(`inertia:draft:${attachmentOwner.id}`))
      .toBe("Keep this exact attachment draft");
    expect(prepareComposerDetachment(referenceOwner.id)).toEqual({
      status: "blocked",
      blocker: "file-references",
      reason: "Remove file references before moving this chat to a window.",
    });
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
    });

    await act(async () => finishSend());
  });

  it("blocks a pending model-route transfer", async () => {
    const current = conversation("route-owner");
    current.modelSelection = nativeModelSelection({
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
    });
  });
});
