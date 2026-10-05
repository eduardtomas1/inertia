import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  Conversation,
  ConversationContextPacketSummary,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import type { LimitResetResult } from "../../src/shared/limit-reset";
import { MIXED_PROVIDER_HISTORY_MESSAGE } from "../../src/shared/continuation-policy";
import { providerNativeModelSelection, versionedContinuationIdentityForSelection } from "../../src/shared/model-routing";
import { Composer } from "../../src/renderer/src/components/Composer";
import { LimitResetBanner } from "../../src/renderer/src/components/composer/LimitResetBanner";
import type { LimitResetCommandRunner } from "../../src/renderer/src/components/composer/limitResetClient";
import type { ComposerProps } from "../../src/renderer/src/components/composer/types";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import { composerProps, conversation, provider } from "./composer-fixtures";

const conversationId = "44444444-4444-4444-8444-444444444444";
const failedTurnId = "22222222-2222-4222-8222-222222222222";
const catalogState = {
  freshness: "fresh" as const,
  provenance: "provider" as const,
  updatedAt: "2026-08-01T00:00:00.000Z",
  lastAttemptedAt: "2026-08-01T00:00:00.000Z",
  refreshing: false,
};
const route = (id: string, label: string) => ({
  id,
  label,
  description: label,
  isDefault: true,
  inputModalities: ["text" as const],
  reasoningOptions: [{ value: "high", label: "High", description: "" }],
  defaultReasoningEffort: "high",
});
const providers: ProviderInfo[] = [
  { ...provider, models: [route("codex-route", "Codex Route")], metadataState: { models: catalogState, rateLimits: catalogState } },
  { ...provider, id: "claude", label: "Claude", models: [route("claude-route", "Claude Route")],
    metadataState: { models: catalogState, rateLimits: catalogState } },
];
const codexSelection = providerNativeModelSelection({
  providerId: "codex", modelId: "codex-route", alias: "Codex Route", reasoningEffort: "high",
});

function chat(overrides: Partial<Conversation> = {}): Conversation {
  return {
    ...conversation(conversationId),
    modelSelection: codexSelection,
    model: "codex-route",
    reasoningEffort: "high",
    hasHistory: true,
    ...overrides,
  };
}

function failedTurn(current: Conversation): NonNullable<ComposerProps["latestTurnSummary"]> {
  return {
    id: failedTurnId,
    runId: "run-limited",
    status: "failed",
    providerId: "codex",
    harnessId: current.modelSelection.harnessId,
    backendProfileId: current.modelSelection.backendProfileId,
    modelSelection: current.modelSelection,
    continuationIdentity: versionedContinuationIdentityForSelection(current.modelSelection, null, false, "a".repeat(64)),
    model: current.modelSelection.modelId,
    reasoningEffort: "high",
    requestedAt: current.createdAt,
    startedAt: current.createdAt,
    completedAt: current.updatedAt,
    terminalReason: null,
    updatedAt: current.updatedAt,
  };
}

const limited = (overrides: Partial<LimitResetResult> = {}): LimitResetResult => ({
  kind: "conversation.limit-reset",
  conversationId,
  offer: null,
  plan: null,
  usageLimited: true,
  ...overrides,
});

function renderComposer(current: Conversation, overrides: Partial<ComposerProps> = {}) {
  const onCreateConversationForSelection = vi.fn<NonNullable<ComposerProps["onCreateConversationForSelection"]>>(async () => undefined);
  render(<Composer {...composerProps(current, { providers, onCreateConversationForSelection, ...overrides })} />);
  return onCreateConversationForSelection;
}

async function chooseClaudeRoute(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /Choose model/u }));
  fireEvent.click(await screen.findByRole("button", { name: /^Claude, /u }));
  const claudeRoute = screen.getByTitle("Claude Route").closest("button");
  if (!claudeRoute) throw new Error("Expected the Claude route action.");
  fireEvent.click(claudeRoute);
}

describe("continuing a chat with another model", () => {
  it("offers to continue a chat with history in a new chat that carries it, with focus on Cancel", async () => {
    const create = renderComposer(chat());
    await chooseClaudeRoute();

    const offer = await screen.findByRole("alertdialog", { name: /^Continue in a new chat with .*Claude Route\?$/u });
    const cancel = within(offer).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.click(within(offer).getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]![0]).toMatchObject({
      selection: { harnessId: providerNativeModelSelection({ providerId: "claude" }).harnessId, modelId: "claude-route" },
      configuration: { accessMode: "supervised", interactionMode: "build" },
      sourceConversationId: conversationId,
    });
  });

  it.each([
    ["a chat without history", { hasHistory: false }, {}],
    ["a chat without a project", {}, { scratchWorkspace: true }],
  ] as const)("keeps a plain new chat for %s", async (_label, conversationOverrides, propOverrides) => {
    const create = renderComposer(chat(conversationOverrides), {
      ...propOverrides,
      onSend: vi.fn<ComposerProps["onSend"]>(async () => {
        throw new RuntimeCommandError(MIXED_PROVIDER_HISTORY_MESSAGE, "rejected");
      }),
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Continue." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const offer = await screen.findByRole("alertdialog", { name: /^Open a new chat for /u });
    fireEvent.click(within(offer).getByRole("button", { name: "New chat" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]![0]).not.toHaveProperty("sourceConversationId");
  });

  it("opens the model chooser from the usage-limited row and continues from there", async () => {
    const current = chat();
    const onLimitResetCommand = vi.fn<LimitResetCommandRunner>(async () => limited());
    const create = renderComposer(current, { latestTurnSummary: failedTurn(current), onLimitResetCommand });

    fireEvent.click(await screen.findByRole("button", { name: "Continue with another model" }));

    await waitFor(() => expect(screen.getByRole("combobox", { name: "Search models" })).toHaveFocus());
    fireEvent.click(await screen.findByRole("button", { name: /^Claude, /u }));
    fireEvent.click(screen.getByTitle("Claude Route").closest("button")!);
    const offer = await screen.findByRole("alertdialog", { name: /^Continue in a new chat with .*Claude Route\?$/u });
    fireEvent.click(within(offer).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ sourceConversationId: conversationId })));
  });

  it("leaves the usage-limited row without the offer where no new chat can be created", async () => {
    const current = chat();
    render(<Composer {...composerProps(current, {
      providers,
      latestTurnSummary: failedTurn(current),
      onLimitResetCommand: vi.fn<LimitResetCommandRunner>(async () => limited()),
      onCreateConversationForSelection: undefined,
    })} />);
    expect(await screen.findByRole("group", { name: "Usage limit" })).toHaveTextContent(/^Usage limit reached$/u);
    expect(screen.queryByRole("button", { name: "Continue with another model" })).not.toBeInTheDocument();
  });
});

describe("the usage-limited row's continuation", () => {
  const resetsAt = "2026-10-02T03:16:55.000Z";
  const offer = { failedTurnId, resetsAt, canResume: true, unavailableReason: null };
  const plan = (state: "waiting" | "missed") => ({ id: "33333333-3333-4333-8333-333333333333", conversationId, failedTurnId, resetsAt, state, error: null });
  const row = (result: LimitResetResult, onContinueElsewhere = vi.fn()) => {
    render(<LimitResetBanner conversationId={conversationId} latestTurnId={failedTurnId} snoozedUntil={null}
      disabled={false} providerState="ready" onCommand={vi.fn<LimitResetCommandRunner>(async () => result)}
      onContinueElsewhere={onContinueElsewhere} />);
    return onContinueElsewhere;
  };

  it.each([
    ["no reset time is known", limited()],
    ["a reset time is offered", limited({ offer })],
    ["the resume was missed", limited({ offer, plan: plan("missed") })],
  ])("offers it when %s and keeps it reachable by keyboard", async (_label, result) => {
    const onContinueElsewhere = row(result);
    const action = await screen.findByRole("button", { name: "Continue with another model" });
    action.focus();
    expect(action).toHaveFocus();
    fireEvent.click(action);
    expect(onContinueElsewhere).toHaveBeenCalledOnce();
  });

  it("does not offer it while a resume is scheduled", async () => {
    row(limited({ offer, plan: plan("waiting") }));
    await screen.findByRole("button", { name: "Cancel resume" });
    expect(screen.queryByRole("button", { name: "Continue with another model" })).not.toBeInTheDocument();
  });
});

describe("the continued chat before its first send", () => {
  it("shows the carried chat and previews it from the composer", async () => {
    const continued = chat({ id: "66666666-6666-4666-8666-666666666666", hasHistory: false });
    const packet: ConversationContextPacketSummary = {
      id: "33333333-3333-4333-8333-333333333333",
      sourceConversationId: conversationId,
      targetConversationId: continued.id,
      sourceProjectId: continued.projectId,
      targetProjectId: continued.projectId,
      sourceConversationTitle: "Parser fix",
      sourceProjectName: "Inertia",
      sourceWorkspaceLabel: "Project checkout · main",
      targetWorkspaceLabel: "Project checkout · main",
      workspaceRelation: "same-workspace",
      note: null,
      messageCount: 2,
      characterCount: 36,
      droppedMessageCount: 0,
      createdAt: "2026-08-19T09:30:00.000Z",
      consumedMessageId: null,
      consumedAt: null,
      sourceState: "available",
    };
    const onConversationContextCommand = vi.fn(async (): Promise<ServerEvent> => ({
      type: "request.result",
      requestId: "preview",
      result: { kind: "conversation.context.packet", packet: { ...packet, excerpts: [
        { sourceMessageId: "77777777-7777-4777-8777-777777777777", sourceTurnId: null, role: "user",
          content: "Fix the parser.", truncated: false, createdAt: "2026-08-19T09:29:00.000Z" },
        { sourceMessageId: "88888888-8888-4888-8888-888888888888", sourceTurnId: null, role: "assistant",
          content: "The parser is fixed.", truncated: false, createdAt: "2026-08-19T09:30:00.000Z" },
      ] } },
    }) as ServerEvent);
    render(<Composer {...composerProps(continued, { providers, contextPackets: [packet], onConversationContextCommand })} />);

    const strip = await screen.findByLabelText("Chat context");
    fireEvent.click(within(strip).getByRole("button", { name: /From Parser fix/u }));

    expect(await screen.findByText("The parser is fixed.")).toBeInTheDocument();
    expect(onConversationContextCommand).toHaveBeenCalledWith("conversation.context.load", {
      type: "conversation.context.load",
      payload: { packetId: packet.id, targetConversationId: continued.id },
    });
  });
});
