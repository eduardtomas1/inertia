import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppSnapshot,
  ModelBackendProfileView,
  ModelSelection,
  Project,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { MultiSpawnDialog } from "../../src/renderer/src/components/MultiSpawnDialog";
import { useMultiSpawn } from "../../src/renderer/src/hooks/useMultiSpawn";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import { RuntimeCommandError } from "../../src/renderer/src/utils/connectionMessages";
import type { MultiSpawnDraft } from "../../src/renderer/src/utils/multiSpawn";
import { nativeModelSelection } from "../../src/shared/model-routing";

const firstProjectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";
const firstConversationId = "33333333-3333-4333-8333-333333333333";
const secondConversationId = "44444444-4444-4444-8444-444444444444";
const now = "2026-07-29T14:00:00.000Z";

function project(
  id: string,
  name: string,
  overrides: Partial<Project> = {},
): Project {
  return {
    id,
    name,
    path: `/workspace/${name.toLocaleLowerCase("en-US")}`,
    normalizedPath: `/workspace/${name.toLocaleLowerCase("en-US")}`,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: "",
    groupingMode: null,
    gitRepositoryLimit: 64,
    color: "#6366f1",
    status: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

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
  statusMessage: null,
  models: [{
    id: "gpt-5.6-sol",
    label: "GPT-5.6-Sol",
    description: "Test model",
    isDefault: true,
    inputModalities: ["text"],
    reasoningOptions: [
      { value: "high", label: "High", description: "Deep reasoning" },
      { value: "xhigh", label: "Extra high", description: "Maximum reasoning" },
    ],
    defaultReasoningEffort: "high",
  }, {
    id: "gpt-5.5",
    label: "GPT-5.5",
    description: "Alternate test model",
    isDefault: false,
    inputModalities: ["text"],
    reasoningOptions: [
      { value: "medium", label: "Medium", description: "Balanced reasoning" },
      { value: "high", label: "High", description: "Deep reasoning" },
    ],
    defaultReasoningEffort: "medium",
  }],
  rateLimits: [],
  metadataState: {
    models: {
      freshness: "fresh",
      provenance: "provider",
      updatedAt: now,
      lastAttemptedAt: now,
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

const customSelection: ModelSelection = {
  harnessId: "codex-app-server",
  backendProfileId: "custom:team",
  backendProfileDisplayName: "Team gateway",
  modelId: "team-alpha",
  alias: "Team Alpha",
  reasoningEffort: "medium",
  contextWindowOverride: 120_000,
  providerOptions: {},
  capabilities: [],
  backendConfigurationRevision: 4,
};

const probeNeededProfile: ModelBackendProfileView = {
  id: customSelection.backendProfileId,
  displayName: customSelection.backendProfileDisplayName,
  protocol: "openai-responses",
  authenticationMode: "api-key",
  source: "custom",
  enabled: true,
  configurationRevision: customSelection.backendConfigurationRevision,
  endpointIdentity: "opaque-team-route-4",
  harnessId: "codex-app-server",
  preset: "custom",
  allowInsecureLocalhost: false,
  credentialGeneration: null,
  models: [{
    id: customSelection.modelId,
    displayName: customSelection.alias ?? customSelection.modelId,
    contextWindowTokens: 120_000,
    reasoningOptions: [{
      value: "medium",
      label: "Medium",
      description: "Balanced",
    }],
    capabilities: [],
  }],
  routing: {
    mode: "simple",
    primaryModelId: customSelection.modelId,
  },
  capabilityHints: [],
  createdAt: now,
  updatedAt: now,
  endpointHost: "gateway.example.invalid",
  authState: "configured",
  connectionState: "not-tested",
  compatibility: {
    harnessId: "codex-app-server",
    backendProfileId: customSelection.backendProfileId,
    backendProtocol: "openai-responses",
    state: "unknown",
    provenance: "unknown",
    allowsModelSwitchWithinSession: false,
    reasonCode: "probe-required",
    reason: "Run a compatibility probe before using this route.",
  },
  latestProbe: null,
  canDelete: true,
  canDisable: true,
};

const settings = {
  ...defaultSettings,
  defaultProvider: "codex" as const,
  defaultModel: "gpt-5.6-sol",
  defaultReasoningEffort: "high",
};
const snapshot: AppSnapshot = {
  projects: [
    project(firstProjectId, "Inertia"),
    project(secondProjectId, "Companion"),
  ],
  conversations: [],
  providers: [provider],
  backendProfiles: [],
  backendDefaults: [],
  runs: [],
  settings,
  activeProjectId: firstProjectId,
  activeConversationId: null,
};

function localStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function multiSpawnDraft(): MultiSpawnDraft {
  const selection = nativeModelSelection({
    providerId: "codex",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  return {
    prompt: "Compare this change.",
    rememberPreset: false,
    sides: [
      {
        projectId: firstProjectId,
        title: "First perspective",
        selection,
        accessMode: "supervised",
        interactionMode: "build",
      },
      {
        projectId: secondProjectId,
        title: "Second perspective",
        selection,
        accessMode: "full",
        interactionMode: "build",
      },
    ],
  };
}

describe("multi-spawn", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: localStorageStub(),
    });
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
  });

  it("collects one prompt and two independently scoped chat routes", async () => {
    const onSubmit = vi.fn(async (_draft: MultiSpawnDraft) => undefined);
    render(
      <MultiSpawnDialog
        open
        snapshot={snapshot}
        settings={settings}
        submitting={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", {
      name: "Launch two perspectives",
    })).toBeVisible();
    expect(screen.getAllByText("GPT-5.6-Sol")).toHaveLength(2);
    expect(screen.getByText(
      /Both agents will share this project checkout/u,
    )).toBeVisible();
    fireEvent.change(screen.getByLabelText("Shared prompt"), {
      target: { value: "Compare the provider lifecycle." },
    });
    fireEvent.change(screen.getByLabelText("Chat 1 name"), {
      target: { value: "Lifecycle" },
    });
    fireEvent.change(screen.getByLabelText("Chat 2 project"), {
      target: { value: secondProjectId },
    });
    fireEvent.change(screen.getByLabelText("Chat 2 access"), {
      target: { value: "full" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Launch duo" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      prompt: "Compare the provider lifecycle.",
      sides: [
        { projectId: firstProjectId, title: "Lifecycle" },
        { projectId: secondProjectId, accessMode: "full" },
      ],
    });
  });

  it("warns when distinct project records share one local checkout", () => {
    const sharedRoot = "/workspace/shared-repository";
    render(
      <MultiSpawnDialog
        open
        snapshot={{
          ...snapshot,
          projects: [
            project(firstProjectId, "Root", {
              repositoryRoot: sharedRoot,
              repositoryRelativePath: ".",
            }),
            project(secondProjectId, "Module", {
              repositoryRoot: sharedRoot,
              repositoryRelativePath: "modules/a",
            }),
          ],
        }}
        settings={settings}
        submitting={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Chat 2 project"), {
      target: { value: secondProjectId },
    });

    expect(screen.getByText(
      /Both agents will share this project checkout/u,
    )).toBeVisible();
  });

  it("selects each model independently through the existing route chooser", async () => {
    const onSubmit = vi.fn(async (_draft: MultiSpawnDraft) => undefined);
    render(
      <MultiSpawnDialog
        open
        snapshot={snapshot}
        settings={settings}
        submitting={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Shared prompt"), {
      target: { value: "Compare model behavior." },
    });

    fireEvent.click(screen.getAllByRole("button", {
      name: /Choose model\..*GPT-5\.6-Sol/u,
    })[1]!);
    expect(screen.getByRole("dialog", { name: "Choose model" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("option", { name: /GPT-5\.5/u }),
    );
    expect(screen.getAllByText("GPT-5.5")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Launch duo" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].sides[0].selection.modelId)
      .toBe("gpt-5.6-sol");
    expect(onSubmit.mock.calls[0]![0].sides[1].selection.modelId)
      .toBe("gpt-5.5");
  });

  it("resolves an out-of-box provider default to its advertised model", () => {
    render(
      <MultiSpawnDialog
        open
        snapshot={snapshot}
        settings={{
          ...settings,
          defaultModel: "",
          defaultReasoningEffort: "",
        }}
        submitting={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    expect(screen.getAllByText("GPT-5.6-Sol")).toHaveLength(2);
    expect(screen.queryByText("Model route unavailable")).not.toBeInTheDocument();
    const reasoning = screen.getByLabelText("Chat 1 reasoning");
    expect(reasoning).toHaveValue("");
    fireEvent.change(reasoning, { target: { value: "high" } });
    expect(reasoning).toHaveValue("high");
    fireEvent.change(reasoning, { target: { value: "" } });
    expect(reasoning).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Shared prompt"), {
      target: { value: "Compare the default route." },
    });
    expect(screen.getByRole("button", { name: "Launch duo" })).toBeEnabled();
  });

  it("does not reset an open setup when provider metadata refreshes", () => {
    const props = {
      open: true,
      settings,
      submitting: false,
      error: null,
      onClose: vi.fn(),
      onSubmit: vi.fn(async (_draft: MultiSpawnDraft) => undefined),
      onOpenProviderSetup: vi.fn(),
      onOpenBackendSetup: vi.fn(),
    };
    const view = render(
      <MultiSpawnDialog {...props} snapshot={snapshot} />,
    );
    fireEvent.change(screen.getByLabelText("Shared prompt"), {
      target: { value: "Keep this prompt through reconnect." },
    });
    fireEvent.change(screen.getByLabelText("Chat 1 name"), {
      target: { value: "Kept title" },
    });

    view.rerender(
      <MultiSpawnDialog
        {...props}
        snapshot={{
          ...snapshot,
          providers: snapshot.providers.map((entry) => ({ ...entry })),
        }}
      />,
    );

    expect(screen.getByLabelText("Shared prompt")).toHaveValue(
      "Keep this prompt through reconnect.",
    );
    expect(screen.getByLabelText("Chat 1 name")).toHaveValue("Kept title");
  });

  it("restores focus to the launch trigger when the dialog closes", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Launch two chats";
    document.body.append(trigger);
    trigger.focus();
    let view!: ReturnType<typeof render>;
    const renderDialog = (open: boolean): React.JSX.Element => (
      <MultiSpawnDialog
        open={open}
        snapshot={snapshot}
        settings={settings}
        submitting={false}
        error={null}
        onClose={() => view.rerender(renderDialog(false))}
        onSubmit={vi.fn(async () => undefined)}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />
    );
    view = render(renderDialog(true));
    await waitFor(() =>
      expect(screen.getByLabelText("Shared prompt")).toHaveFocus());

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(trigger).toHaveFocus());
    trigger.remove();
  });

  it("keeps launch completion focused in the resulting workspace", async () => {
    const trigger = document.createElement("button");
    const workspace = document.createElement("section");
    trigger.textContent = "Launch two chats";
    workspace.tabIndex = -1;
    document.body.append(trigger, workspace);
    trigger.focus();
    let view!: ReturnType<typeof render>;
    const renderDialog = (open: boolean): React.JSX.Element => (
      <MultiSpawnDialog
        open={open}
        snapshot={snapshot}
        settings={settings}
        submitting={false}
        error={null}
        onClose={() => view.rerender(renderDialog(false))}
        onSubmit={async () => {
          view.rerender(renderDialog(false));
          workspace.focus();
        }}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />
    );
    view = render(renderDialog(true));
    fireEvent.change(screen.getByLabelText("Shared prompt"), {
      target: { value: "Compare focus behavior." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Launch duo" }));

    await waitFor(() => expect(workspace).toHaveFocus());
    expect(trigger).not.toHaveFocus();
    trigger.remove();
    workspace.remove();
  });

  it("requires a stale selected model to be replaced before launch", () => {
    render(
      <MultiSpawnDialog
        open
        snapshot={{
          ...snapshot,
          providers: snapshot.providers.map((entry) => ({
            ...entry,
            models: entry.models.filter(({ id }) => id === "gpt-5.5"),
          })),
        }}
        settings={settings}
        submitting={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Launch duo" })).toBeDisabled();
    expect(screen.getAllByText("Model route unavailable")).toHaveLength(2);
    expect(screen.getAllByText(
      "This saved model route is no longer available.",
    )).toHaveLength(2);
  });

  it("blocks launch and exposes route-specific setup when a route is unavailable", () => {
    render(
      <MultiSpawnDialog
        open
        snapshot={{
          ...snapshot,
          providers: snapshot.providers.map((entry) => ({
            ...entry,
            available: false,
            canRun: false,
            installState: "not-installed",
            statusMessage: "Codex is not installed.",
          })),
        }}
        settings={settings}
        submitting={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Launch duo" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Open setup" }))
      .toHaveLength(2);
    expect(screen.getByText(
      "Choose two ready routes before launching the duo.",
    )).toBeVisible();
  });

  it("keeps setup available for an exact custom route that needs a probe", () => {
    const onOpenBackendSetup = vi.fn();
    render(
      <MultiSpawnDialog
        open
        snapshot={{
          ...snapshot,
          backendProfiles: [probeNeededProfile],
          backendDefaults: [{
            scope: "global",
            projectId: null,
            selection: customSelection,
            updatedAt: now,
          }],
        }}
        settings={settings}
        submitting={false}
        error={null}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={onOpenBackendSetup}
      />,
    );

    expect(screen.getByRole("button", { name: "Launch duo" })).toBeDisabled();
    expect(screen.getAllByText("Team gateway needs a probe")).toHaveLength(2);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Open setup" })[0]!,
    );
    expect(onOpenBackendSetup).toHaveBeenCalledWith("custom:team");
  });

  it("creates both shells before selecting and starting them", async () => {
    const calls: string[] = [];
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      calls.push(key);
      if (command.type === "conversation.create") {
        const conversationId = command.payload.title === "First perspective"
          ? firstConversationId
          : secondConversationId;
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: { kind: "conversation.created", conversationId },
        };
      }
      return {
        type: "request.ok",
        requestId: crypto.randomUUID(),
      };
    });
    const sendMessage = vi.fn(async (conversationId: string) => {
      calls.push(`send:${conversationId}`);
    });
    const updateSplitConversationId = vi.fn();
    const focusWorkspace = vi.fn();
    const transitionRef = { current: 0 };
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      sendMessage,
      splitSelectionTransitionsRef: transitionRef,
      updateSplitConversationId,
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace,
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));
    const draft = multiSpawnDraft();

    await act(async () => hook.result.current.submit(draft));

    expect(calls.slice(0, 2).sort()).toEqual([
      "multi-spawn:create:0",
      "multi-spawn:create:1",
    ]);
    expect(calls[2]).toBe("multi-spawn:select");
    expect(updateSplitConversationId).toHaveBeenCalledWith(
      secondConversationId,
    );
    const creationPayloads = run.mock.calls.flatMap(([, command]) =>
      command.type === "conversation.create" ? [command.payload] : []);
    expect(creationPayloads).toMatchObject([
      {
        projectId: firstProjectId,
        title: "First perspective",
        activate: false,
        accessMode: "supervised",
        interactionMode: "build",
        modelSelection: {
          modelId: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
      {
        projectId: secondProjectId,
        title: "Second perspective",
        activate: false,
        accessMode: "full",
        interactionMode: "build",
        modelSelection: {
          modelId: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      },
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      firstConversationId,
      "Compare this change.",
      [],
      undefined,
      false,
    );
  });

  it("continues a surviving chat and reports a partial creation failure", async () => {
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (key === "multi-spawn:create:1") {
        throw new Error("Claude route unavailable.");
      }
      if (command.type === "conversation.create") {
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.created",
            conversationId: firstConversationId,
          },
        };
      }
      return { type: "request.ok", requestId: crypto.randomUUID() };
    });
    const sendMessage = vi.fn(async () => undefined);
    const setActionError = vi.fn();
    const selection = nativeModelSelection({
      providerId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      sendMessage,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError,
    }));

    await act(async () => hook.result.current.submit({
      prompt: "Review.",
      rememberPreset: false,
      sides: [
        {
          projectId: firstProjectId,
          title: "Survivor",
          selection,
          accessMode: "supervised",
          interactionMode: "build",
        },
        {
          projectId: secondProjectId,
          title: "Unavailable",
          selection,
          accessMode: "supervised",
          interactionMode: "build",
        },
      ],
    }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(setActionError).toHaveBeenLastCalledWith(
      expect.stringContaining("Claude route unavailable."),
    );
  });

  it("ignores duplicate submission while the first duo is being created", async () => {
    let releaseFirstCreation!: () => void;
    const firstCreation = new Promise<void>((resolve) => {
      releaseFirstCreation = resolve;
    });
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (key === "multi-spawn:create:0") await firstCreation;
      if (command.type === "conversation.create") {
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "conversation.created",
            conversationId: key.endsWith(":0")
              ? firstConversationId
              : secondConversationId,
          },
        };
      }
      return { type: "request.ok", requestId: crypto.randomUUID() };
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      sendMessage: vi.fn(async () => undefined),
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));
    const firstSubmit = hook.result.current.submit(multiSpawnDraft());
    const duplicateSubmit = hook.result.current.submit(multiSpawnDraft());

    await act(async () => {
      await duplicateSubmit;
      expect(run).toHaveBeenCalledTimes(1);
      releaseFirstCreation();
      await firstSubmit;
    });

    expect(run.mock.calls.filter(([, command]) =>
      command.type === "conversation.create")).toHaveLength(2);
  });

  it("closes for authoritative reconciliation after ambiguous creation", async () => {
    const setActionError = vi.fn();
    const discardDraftConversation = vi.fn();
    const focusWorkspace = vi.fn();
    const run = vi.fn(async (): Promise<ServerEvent> => {
      throw new RuntimeCommandError("Connection interrupted.", "ambiguous");
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      sendMessage: vi.fn(async () => undefined),
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace,
      discardDraftConversation,
      setActionError,
    }));
    act(() => hook.result.current.openDialog());
    expect(hook.result.current.open).toBe(true);

    await act(async () => hook.result.current.submit(multiSpawnDraft()));

    expect(hook.result.current.open).toBe(false);
    expect(setActionError).toHaveBeenLastCalledWith(
      expect.stringContaining("Refresh before trying again"),
    );
    expect(discardDraftConversation).not.toHaveBeenCalled();
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
  });
});
