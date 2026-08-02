import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  AppSnapshot,
  DuoLaunchSideStatus,
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
import {
  MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
  type MultiSpawnDraft,
} from "../../src/renderer/src/utils/multiSpawn";
import { nativeModelSelection } from "../../src/shared/model-routing";

const firstProjectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";
const firstConversationId = "33333333-3333-4333-8333-333333333333";
const secondConversationId = "44444444-4444-4444-8444-444444444444";
const firstTurnId = "55555555-5555-4555-8555-555555555555";
const secondTurnId = "66666666-6666-4666-8666-666666666666";
const now = "2026-07-29T14:00:00.000Z";
const browserLocalStorage = window.localStorage;

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

function readyCustomProfile(
  configurationRevision: number,
): ModelBackendProfileView {
  return {
    ...probeNeededProfile,
    configurationRevision,
    endpointIdentity: `opaque-team-route-${configurationRevision}`,
    connectionState: "connected",
    compatibility: {
      ...probeNeededProfile.compatibility,
      state: "verified",
      provenance: "probe",
      reasonCode: "responses-probe-verified",
      reason: "The exact Responses route was verified.",
    },
  };
}

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

function pendingLaunchesEvent(
  launchIds: string[] = [],
  hasMore = false,
): ServerEvent {
  return {
    type: "request.result",
    requestId: crypto.randomUUID(),
    result: {
      kind: "duo.pending",
      launchIds,
      hasMore,
    },
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

  afterEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: browserLocalStorage,
    });
    vi.unstubAllGlobals();
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
      name: "Launch a duo",
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
    const result = screen.getByRole("list", { name: "Model results" })
      .querySelector<HTMLElement>(".model-chooser-row-option[data-model-route-key*='gpt-5.5']");
    if (!result) throw new Error("Expected the GPT-5.5 result action.");
    fireEvent.click(result);
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

  it("rebinds open drafts when a backend configuration is revised", async () => {
    const onSubmit = vi.fn(async (_draft: MultiSpawnDraft) => undefined);
    const props = {
      open: true,
      settings,
      submitting: false,
      error: null,
      onClose: vi.fn(),
      onSubmit,
      onOpenProviderSetup: vi.fn(),
      onOpenBackendSetup: vi.fn(),
    };
    const customSnapshot = (revision: number): AppSnapshot => ({
      ...snapshot,
      backendProfiles: [readyCustomProfile(revision)],
      backendDefaults: [{
        scope: "global",
        projectId: null,
        selection: customSelection,
        updatedAt: now,
      }],
    });
    const view = render(
      <MultiSpawnDialog {...props} snapshot={customSnapshot(4)} />,
    );
    fireEvent.change(screen.getByLabelText("Shared prompt"), {
      target: { value: "Compare the revised backend." },
    });
    fireEvent.change(screen.getByLabelText("Chat 1 name"), {
      target: { value: "Keep this title" },
    });

    view.rerender(
      <MultiSpawnDialog {...props} snapshot={customSnapshot(5)} />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Launch duo" })).toBeEnabled());
    expect(screen.getByLabelText("Shared prompt")).toHaveValue(
      "Compare the revised backend.",
    );
    expect(screen.getByLabelText("Chat 1 name")).toHaveValue("Keep this title");
    fireEvent.click(screen.getByRole("button", { name: "Launch duo" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0].sides.map(
      ({ selection }) => selection.backendConfigurationRevision,
    )).toEqual([5, 5]);
  });

  it("restores focus to the launch trigger when the dialog closes", async () => {
    const trigger = document.createElement("button");
    const closeMobileSidebar = vi.fn();
    const mobileSidebarEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeMobileSidebar();
    };
    trigger.textContent = "Launch two chats";
    document.body.append(trigger);
    trigger.focus();
    // The mobile sidebar registers its bubbling listener before the dialog
    // opens. The dialog must still own Escape and preserve its trigger.
    document.addEventListener("keydown", mobileSidebarEscape);
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
    expect(closeMobileSidebar).not.toHaveBeenCalled();
    document.removeEventListener("keydown", mobileSidebarEscape);
    trigger.remove();
  });

  it.each(["Escape", "close button", "Cancel launch"] as const)(
    "routes %s through the same launch-cancellation callback",
    (route) => {
      const onClose = vi.fn();
      render(
        <MultiSpawnDialog
          open
          snapshot={snapshot}
          settings={settings}
          submitting
          error="Checking these projects for previous duo launches."
          onClose={onClose}
          onSubmit={vi.fn(async () => undefined)}
          onOpenProviderSetup={vi.fn()}
          onOpenBackendSetup={vi.fn()}
        />,
      );

      if (route === "Escape") {
        fireEvent.keyDown(document, { key: "Escape" });
      } else if (route === "close button") {
        fireEvent.click(screen.getByRole("button", {
          name: "Close multi-spawn",
        }));
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Cancel launch" }));
      }

      expect(onClose).toHaveBeenCalledTimes(1);
    },
  );

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

  it("renders recovery instructions as inert argv on Windows and metacharacter paths", () => {
    const repositoryPath = "C:\\Users\\Ada $()\\project`name`";
    const worktreePath = `${repositoryPath}\\.inertia\\worktrees\\route\nnext-line`;
    const branch = "inertia/33333333";
    render(
      <MultiSpawnDialog
        open
        snapshot={snapshot}
        settings={settings}
        submitting={false}
        error="Owned worktree cleanup still needs attention."
        recoveryGuidance={[{
          kind: "git-worktree",
          ordinal: 0,
          topology: "owned",
          repositoryPath,
          plannedPath: worktreePath,
          observedPath: worktreePath,
          worktreeId: "route",
          generatedBranch: branch,
          expectedHead: "a".repeat(40),
          observedBranch: branch,
          observedHead: "a".repeat(40),
          actions: [
            {
              label: "Remove retained linked worktree",
              cwd: repositoryPath,
              executable: "git",
              args: ["worktree", "remove", "--", worktreePath],
            },
            {
              label: "Remove generated branch after inspecting it",
              cwd: repositoryPath,
              executable: "git",
              args: ["branch", "-d", "--", branch],
            },
          ],
        }]}
        onClose={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
        onOpenProviderSetup={vi.fn()}
        onOpenBackendSetup={vi.fn()}
      />,
    );

    const guidance = screen.getByRole("region", {
      name: "Manual Git recovery for route 1",
    });
    expect(guidance).toHaveTextContent(
      "These are literal values, not a shell command.",
    );
    expect(guidance).toHaveTextContent(repositoryPath);
    expect(guidance).toHaveTextContent(`Expected commit${"a".repeat(40)}`);
    expect(Array.from(guidance.querySelectorAll("[data-git-argument]"))
      .map((argument) => argument.textContent)).toEqual([
      "worktree",
      "remove",
      "--",
      worktreePath,
      "branch",
      "-d",
      "--",
      branch,
    ]);
    expect(guidance.querySelectorAll("code")).not.toHaveLength(0);
    expect(guidance.textContent).not.toContain(
      `git worktree remove -- ${JSON.stringify(worktreePath)}`,
    );
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

  it("prepares both durable sides when browser recovery storage is unavailable", async () => {
    const unavailableStorage = localStorageStub();
    unavailableStorage.setItem = () => {
      throw new Error("Browser storage is unavailable.");
    };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: unavailableStorage,
    });
    const calls: string[] = [];
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      calls.push(key);
      if (command.type === "duo.pending") {
        expect(command.payload.projectIds).toEqual([
          firstProjectId,
          secondProjectId,
        ]);
        return pendingLaunchesEvent();
      }
      if (command.type === "duo.prepare") {
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "duo.prepared",
            launchId: command.payload.launchId,
            state: "prepared",
            sides: [
              { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId },
              { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId },
            ],
          },
        };
      }
      if (command.type === "duo.dispatch") {
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "duo.status",
            launchId: command.payload.launchId,
            state: "running",
            error: null,
            sides: [
              { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
              { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
            ],
          },
        };
      }
      return {
        type: "request.ok",
        requestId: crypto.randomUUID(),
      };
    });
    const updateSplitConversationId = vi.fn();
    const focusWorkspace = vi.fn();
    const transitionRef = { current: 0 };
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
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

    expect(calls).toEqual([
      "multi-spawn:pending",
      "multi-spawn:prepare",
      "multi-spawn:select",
      "multi-spawn:dispatch",
    ]);
    expect(updateSplitConversationId).toHaveBeenCalledWith(
      secondConversationId,
    );
    const prepare = run.mock.calls.find(([, command]) =>
      command.type === "duo.prepare")?.[1];
    expect(prepare).toMatchObject({
      type: "duo.prepare",
      payload: {
        prompt: "Compare this change.",
        sides: [
          {
            projectId: firstProjectId,
            title: "First perspective",
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
            accessMode: "full",
            interactionMode: "build",
            modelSelection: {
              modelId: "gpt-5.6-sol",
              reasoningEffort: "high",
            },
          },
        ],
      },
    });
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(
      MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
    )).toBeNull();
  });

  it.each([
    { state: "failed", expectedStored: false },
    { state: "cancelled", expectedStored: false },
    { state: "interrupted", expectedStored: false },
    { state: "recovery-required", expectedStored: true },
  ] as const)(
    "retains recovery identity after dispatch: $expectedStored ($state)",
    async ({ state, expectedStored }) => {
      let launchId = "";
      const run = vi.fn(async (
        _key: string,
        command: CommandWithoutId,
      ): Promise<ServerEvent> => {
        if (command.type === "duo.pending") {
          return pendingLaunchesEvent();
        }
        if (command.type === "duo.prepare") {
          launchId = command.payload.launchId;
          return {
            type: "request.result",
            requestId: crypto.randomUUID(),
            result: {
              kind: "duo.prepared",
              launchId: command.payload.launchId,
              state: "prepared",
              sides: [
                { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId },
                { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId },
              ],
            },
          };
        }
        if (command.type === "duo.dispatch") {
          expect(window.localStorage.getItem(
            MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
          )).toBe(command.payload.launchId);
          return {
            type: "request.result",
            requestId: crypto.randomUUID(),
            result: {
              kind: "duo.status",
              launchId: command.payload.launchId,
              state,
              error: `Deterministic ${state} result.`,
              sides: [
                { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "failed" },
                { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "failed" },
              ],
            },
          };
        }
        return { type: "request.ok", requestId: crypto.randomUUID() };
      });
      const hook = renderHook(() => useMultiSpawn({
        snapshot,
        settings,
        run,
        splitSelectionTransitionsRef: { current: 0 },
        updateSplitConversationId: vi.fn(),
        showWorkspace: vi.fn(),
        closeSidebar: vi.fn(),
        focusWorkspace: vi.fn(),
        discardDraftConversation: vi.fn(),
        setActionError: vi.fn(),
      }));

      await act(async () => hook.result.current.submit(multiSpawnDraft()));

      expect(window.localStorage.getItem(
        MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
      )).toBe(expectedStored ? launchId : null);
    },
  );

  it("prompts neither side when atomic preparation rejects the second side", async () => {
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        return pendingLaunchesEvent();
      }
      if (command.type === "duo.prepare") {
        throw new RuntimeCommandError(
          "Chat 2 route is unavailable. Neither chat was launched.",
          "rejected",
        );
      }
      if (command.type === "duo.status") {
        throw new RuntimeCommandError("Duo launch not found.", "rejected");
      }
      return { type: "request.ok", requestId: crypto.randomUUID() };
    });
    const setActionError = vi.fn();
    const updateSplitConversationId = vi.fn();
    const discardDraftConversation = vi.fn();
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId,
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation,
      setActionError,
    }));

    await act(async () => hook.result.current.submit(multiSpawnDraft()));

    expect(run.mock.calls.map(([, command]) => command.type)).toEqual([
      "duo.pending",
      "duo.prepare",
      "duo.status",
    ]);
    expect(updateSplitConversationId).not.toHaveBeenCalled();
    expect(discardDraftConversation).not.toHaveBeenCalled();
    expect(hook.result.current.error).toContain("Neither chat was launched");
    expect(window.localStorage.getItem(
      MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
    )).toBeNull();
  });

  it.each([
    {
      recoveredState: "cancelled",
      recoveredError: null,
      expectedStored: false,
      expectedError: "The duo launch was cancelled before both providers began.",
    },
    {
      recoveredState: "recovery-required",
      recoveredError: "Owned worktree cleanup still needs attention.",
      expectedStored: true,
      expectedError: "Owned worktree cleanup still needs attention.",
    },
  ] as const)(
    "recovers a rejected preparation and leaves identity stored: $expectedStored",
    async ({
      recoveredState,
      recoveredError,
      expectedStored,
      expectedError,
    }) => {
      let launchId = "";
      const firstRecoveryError = "Owned worktree cleanup needs attention: could not remove /workspace/orphaned-duo.";
      const run = vi.fn(async (
        _key: string,
        command: CommandWithoutId,
      ): Promise<ServerEvent> => {
        if (command.type === "duo.pending") {
          return pendingLaunchesEvent();
        }
        if (command.type === "duo.prepare") {
          launchId = command.payload.launchId;
          expect(window.localStorage.getItem(
            MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
          )).toBe(launchId);
          throw new RuntimeCommandError(
            "The second worktree could not be created.",
            "rejected",
          );
        }
        if (command.type === "duo.status") {
          expect(command.payload.launchId).toBe(launchId);
          return {
            type: "request.result",
            requestId: crypto.randomUUID(),
            result: {
              kind: "duo.status",
              launchId,
              state: "recovery-required",
              error: firstRecoveryError,
              sides: [
                { ordinal: 0, conversationId: null, turnId: null, dispatchState: "pending" },
                { ordinal: 1, conversationId: null, turnId: null, dispatchState: "pending" },
              ],
            },
          };
        }
        if (command.type === "duo.cancel") {
          expect(command.payload.launchId).toBe(launchId);
          expect(window.localStorage.getItem(
            MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
          )).toBe(launchId);
          return {
            type: "request.result",
            requestId: crypto.randomUUID(),
            result: {
              kind: "duo.status",
              launchId,
              state: recoveredState,
              error: recoveredError,
              sides: [
                {
                  ordinal: 0,
                  conversationId: null,
                  turnId: null,
                  dispatchState: recoveredState === "cancelled"
                    ? "cancelled"
                    : "pending",
                },
                {
                  ordinal: 1,
                  conversationId: null,
                  turnId: null,
                  dispatchState: recoveredState === "cancelled"
                    ? "cancelled"
                    : "pending",
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected command: ${command.type}`);
      });
      const updateSplitConversationId = vi.fn();
      const discardDraftConversation = vi.fn();
      const hook = renderHook(() => useMultiSpawn({
        snapshot,
        settings,
        run,
        splitSelectionTransitionsRef: { current: 0 },
        updateSplitConversationId,
        showWorkspace: vi.fn(),
        closeSidebar: vi.fn(),
        focusWorkspace: vi.fn(),
        discardDraftConversation,
        setActionError: vi.fn(),
      }));

      await act(async () => hook.result.current.submit(multiSpawnDraft()));

      expect(run.mock.calls.map(([, command]) => command.type)).toEqual([
        "duo.pending",
        "duo.prepare",
        "duo.status",
        "duo.cancel",
      ]);
      expect(window.localStorage.getItem(
        MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
      )).toBe(expectedStored ? launchId : null);
      expect(hook.result.current.error).toBe(expectedError);
      expect(updateSplitConversationId).not.toHaveBeenCalled();
      expect(discardDraftConversation).not.toHaveBeenCalled();
    },
  );

  it("ignores duplicate submission while atomic preparation is pending", async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const run = vi.fn(async (
      key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        return pendingLaunchesEvent();
      }
      if (command.type === "duo.prepare") {
        await preparation;
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "duo.prepared",
            launchId: command.payload.launchId,
            state: "prepared",
            sides: [
              { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId },
              { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId },
            ],
          },
        };
      }
      if (command.type === "duo.dispatch") {
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "duo.status",
            launchId: command.payload.launchId,
            state: "running",
            error: null,
            sides: [
              { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "started" },
              { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "started" },
            ],
          },
        };
      }
      expect(key).toBe("multi-spawn:select");
      return { type: "request.ok", requestId: crypto.randomUUID() };
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
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
      releasePreparation();
      await firstSubmit;
    });

    expect(run.mock.calls.filter(([, command]) =>
      command.type === "duo.prepare")).toHaveLength(1);
    expect(run.mock.calls.filter(([, command]) =>
      command.type === "duo.dispatch")).toHaveLength(1);
  });

  it("honors cancellation while durable pending-launch lookup is unresolved", async () => {
    let releaseLookup!: () => void;
    const lookup = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    let lookupCount = 0;
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type !== "duo.pending") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      lookupCount += 1;
      if (lookupCount === 1) await lookup;
      return pendingLaunchesEvent();
    });
    const focusWorkspace = vi.fn();
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace,
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    let submission!: Promise<void>;
    act(() => {
      submission = hook.result.current.submit(multiSpawnDraft());
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(hook.result.current.submitting).toBe(true);

    act(() => hook.result.current.closeDialog());
    expect(hook.result.current.open).toBe(false);
    expect(hook.result.current.submitting).toBe(false);
    act(() => hook.result.current.openDialog());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(hook.result.current.open).toBe(true);
    expect(hook.result.current.error).toBeNull();
    releaseLookup();
    await act(async () => submission);

    expect(run.mock.calls.map(([, command]) => command.type)).toEqual([
      "duo.pending",
      "duo.pending",
    ]);
    expect(hook.result.current.submitting).toBe(false);
    expect(hook.result.current.open).toBe(true);
    expect(hook.result.current.error).toBeNull();
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
  });

  it("invalidates an unresolved pending lookup when the hook unmounts", async () => {
    let releaseLookup!: () => void;
    const lookup = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type !== "duo.pending") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      await lookup;
      return pendingLaunchesEvent();
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    let submission!: Promise<void>;
    act(() => {
      submission = hook.result.current.submit(multiSpawnDraft());
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    hook.unmount();
    releaseLookup();
    await act(async () => submission);

    expect(run.mock.calls.map(([, command]) => command.type)).toEqual([
      "duo.pending",
    ]);
  });

  it("cancels a launch in progress without dispatching either provider", async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let launchId = "";
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        return pendingLaunchesEvent();
      }
      if (command.type === "duo.prepare") {
        launchId = command.payload.launchId;
        await preparation;
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "duo.prepared",
            launchId,
            state: "prepared",
            sides: [
              { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId },
              { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId },
            ],
          },
        };
      }
      if (command.type === "duo.cancel") {
        expect(command.payload.launchId).toBe(launchId);
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "duo.status",
            launchId,
            state: "cancelled",
            error: null,
            sides: [
              { ordinal: 0, conversationId: null, turnId: null, dispatchState: "cancelled" },
              { ordinal: 1, conversationId: null, turnId: null, dispatchState: "cancelled" },
            ],
          },
        };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const updateSplitConversationId = vi.fn();
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId,
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));
    act(() => hook.result.current.openDialog());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    let submission!: Promise<void>;
    act(() => {
      submission = hook.result.current.submit(multiSpawnDraft());
    });
    await waitFor(() => expect(run.mock.calls.some(([, command]) =>
      command.type === "duo.prepare")).toBe(true));

    act(() => hook.result.current.closeDialog());
    await waitFor(() => expect(run.mock.calls.some(([, command]) =>
      command.type === "duo.cancel")).toBe(true));
    releasePreparation();
    await act(async () => submission);

    expect(run.mock.calls.some(([, command]) =>
      command.type === "duo.dispatch")).toBe(false);
    expect(updateSplitConversationId).not.toHaveBeenCalled();
    expect(hook.result.current.open).toBe(false);
    expect(hook.result.current.submitting).toBe(false);
  });

  it("retains recovery identity when explicit cancellation still needs cleanup", async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    let launchId = "";
    const recoveryError = "Owned worktree cleanup still needs attention.";
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        return pendingLaunchesEvent();
      }
      if (command.type === "duo.prepare") {
        launchId = command.payload.launchId;
        await preparation;
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "duo.prepared",
            launchId,
            state: "prepared",
            sides: [
              { ordinal: 0, conversationId: firstConversationId, turnId: firstTurnId },
              { ordinal: 1, conversationId: secondConversationId, turnId: secondTurnId },
            ],
          },
        };
      }
      if (command.type === "duo.cancel") {
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "duo.status",
            launchId,
            state: "recovery-required",
            error: recoveryError,
            sides: [
              { ordinal: 0, conversationId: null, turnId: null, dispatchState: "pending" },
              { ordinal: 1, conversationId: null, turnId: null, dispatchState: "pending" },
            ],
          },
        };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });
    const setActionError = vi.fn();
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError,
    }));
    act(() => hook.result.current.openDialog());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    let submission!: Promise<void>;
    act(() => {
      submission = hook.result.current.submit(multiSpawnDraft());
    });
    await waitFor(() => expect(run.mock.calls.some(([, command]) =>
      command.type === "duo.prepare")).toBe(true));

    act(() => hook.result.current.closeDialog());
    await waitFor(() => expect(run.mock.calls.some(([, command]) =>
      command.type === "duo.cancel")).toBe(true));
    releasePreparation();
    await act(async () => submission);

    expect(window.localStorage.getItem(
      MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
    )).toBe(launchId);
    expect(setActionError).toHaveBeenCalledWith(recoveryError);
    expect(run.mock.calls.some(([, command]) =>
      command.type === "duo.dispatch")).toBe(false);
  });

  it("retains recovery identity across repeated cleanup failures", async () => {
    const launchId = "77777777-7777-4777-8777-777777777777";
    window.localStorage.setItem(
      MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
      "stale-browser-only-value",
    );
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        expect(command.payload.projectIds).toEqual([firstProjectId]);
        return pendingLaunchesEvent([launchId]);
      }
      if (command.type !== "duo.status" && command.type !== "duo.cancel") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      expect(command.payload.launchId).toBe(launchId);
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId,
          state: "recovery-required",
          error: "Owned worktree cleanup still needs attention.",
          sides: [
            { ordinal: 0, conversationId: null, turnId: null, dispatchState: "pending" },
            { ordinal: 1, conversationId: null, turnId: null, dispatchState: "pending" },
          ],
        },
      };
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    act(() => hook.result.current.openDialog());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));

    await waitFor(() => expect(hook.result.current.error).toBe(
      "Owned worktree cleanup still needs attention.",
    ));
    act(() => hook.result.current.closeDialog());
    act(() => hook.result.current.openDialog());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(6));

    expect(run.mock.calls.map(([, command]) => command.type)).toEqual([
      "duo.pending",
      "duo.status",
      "duo.cancel",
      "duo.pending",
      "duo.status",
      "duo.cancel",
    ]);
    expect(window.localStorage.getItem(
      MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
    )).toBeNull();
    expect(run.mock.calls.some(([, command]) =>
      command.type === "duo.prepare" || command.type === "duo.dispatch"))
      .toBe(false);
  });

  it.each([
    { name: "missing", stored: null },
    { name: "corrupt", stored: "not-a-launch-uuid" },
    {
      name: "stale",
      stored: "99999999-9999-4999-8999-999999999999",
    },
  ])(
    "rediscovers durable recovery with a $name browser key",
    async ({ stored }) => {
      const launchId = "77777777-7777-4777-8777-777777777778";
      if (stored) {
        window.localStorage.setItem(
          MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
          stored,
        );
      }
      const run = vi.fn(async (
        _key: string,
        command: CommandWithoutId,
      ): Promise<ServerEvent> => {
        if (command.type === "duo.pending") {
          expect(command.payload.projectIds).toEqual([firstProjectId]);
          return pendingLaunchesEvent([launchId]);
        }
        if (command.type !== "duo.status" && command.type !== "duo.cancel") {
          throw new Error(`Unexpected command: ${command.type}`);
        }
        expect(command.payload.launchId).toBe(launchId);
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "duo.status",
            launchId,
            state: "recovery-required",
            error: "Authoritative recovery is still required.",
            sides: [
              { ordinal: 0, conversationId: null, turnId: null, dispatchState: "pending" },
              { ordinal: 1, conversationId: null, turnId: null, dispatchState: "pending" },
            ],
          },
        };
      });
      const hook = renderHook(() => useMultiSpawn({
        snapshot,
        settings,
        run,
        splitSelectionTransitionsRef: { current: 0 },
        updateSplitConversationId: vi.fn(),
        showWorkspace: vi.fn(),
        closeSidebar: vi.fn(),
        focusWorkspace: vi.fn(),
        discardDraftConversation: vi.fn(),
        setActionError: vi.fn(),
      }));

      act(() => hook.result.current.openDialog());
      await waitFor(() => expect(run).toHaveBeenCalledTimes(3));

      expect(run.mock.calls.map(([, command]) => command.type)).toEqual([
        "duo.pending",
        "duo.status",
        "duo.cancel",
      ]);
      expect(hook.result.current.error).toBe(
        "Authoritative recovery is still required.",
      );
      expect(window.localStorage.getItem(
        MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
      )).toBeNull();
    },
  );

  it("reconciles every bounded durable blocker instead of selecting one", async () => {
    const launchIds = [
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ];
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        expect(command.payload.projectIds).toEqual([firstProjectId]);
        return pendingLaunchesEvent(launchIds);
      }
      if (command.type !== "duo.status" && command.type !== "duo.cancel") {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      const launchId = command.payload.launchId;
      expect(launchIds).toContain(launchId);
      const ordinal = launchIds.indexOf(launchId) as 0 | 1;
      const plannedPath = `/workspace/retained duo ${ordinal + 1}`;
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId,
          state: "recovery-required",
          error: `Recovery ${ordinal + 1} remains required.`,
          sides: [
            { ordinal: 0, conversationId: null, turnId: null, dispatchState: "pending" },
            { ordinal: 1, conversationId: null, turnId: null, dispatchState: "pending" },
          ],
          recoveryGuidance: [{
            kind: "git-worktree",
            ordinal,
            topology: "owned",
            repositoryPath: "/workspace/repository",
            plannedPath,
            observedPath: plannedPath,
            worktreeId: `worktree-${ordinal + 1}`,
            generatedBranch: `inertia/launch-${ordinal + 1}`,
            expectedHead: `${ordinal + 1}`.repeat(40),
            observedBranch: `inertia/launch-${ordinal + 1}`,
            observedHead: `${ordinal + 1}`.repeat(40),
            actions: [{
              label: "Remove retained linked worktree",
              cwd: "/workspace/repository",
              executable: "git",
              args: ["worktree", "remove", "--", plannedPath],
            }],
          }],
        },
      };
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    act(() => hook.result.current.openDialog());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(5));

    expect(run.mock.calls.map(([, command]) => command.type)).toEqual([
      "duo.pending",
      "duo.status",
      "duo.cancel",
      "duo.status",
      "duo.cancel",
    ]);
    expect(hook.result.current.error).toContain(
      "2 previous duo launches still need recovery.",
    );
    expect(hook.result.current.recoveryGuidance.map(
      ({ plannedPath }) => plannedPath,
    )).toEqual([
      "/workspace/retained duo 1",
      "/workspace/retained duo 2",
    ]);
    expect(run.mock.calls.some(([, command]) =>
      command.type === "duo.prepare" || command.type === "duo.dispatch"))
      .toBe(false);
  });

  it("continues reconciling later blockers when an earlier status is unavailable", async () => {
    const launchIds = [
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ];
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        return pendingLaunchesEvent(launchIds);
      }
      if (command.type === "duo.status") {
        if (command.payload.launchId === launchIds[0]) {
          throw new RuntimeCommandError("Status temporarily unavailable.", "rejected");
        }
        expect(command.payload.launchId).toBe(launchIds[1]);
      } else if (command.type === "duo.cancel") {
        expect(command.payload.launchId).toBe(launchIds[1]);
      } else {
        throw new Error(`Unexpected command: ${command.type}`);
      }
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId: launchIds[1]!,
          state: "recovery-required",
          error: "The second launch still needs recovery.",
          sides: [
            { ordinal: 0, conversationId: null, turnId: null, dispatchState: "pending" },
            { ordinal: 1, conversationId: null, turnId: null, dispatchState: "pending" },
          ],
        },
      };
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    act(() => hook.result.current.openDialog());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(4));

    expect(run.mock.calls.map(([, command]) => command.type)).toEqual([
      "duo.pending",
      "duo.status",
      "duo.status",
      "duo.cancel",
    ]);
    expect(hook.result.current.error).toContain(
      "One or more previous duo launches could not be reconciled yet.",
    );
  });

  it("retains a lost-prepared recovery identity until manual worktree cleanup is confirmed", async () => {
    const launchId = "88888888-8888-4888-8888-888888888888";
    const sides: [DuoLaunchSideStatus, DuoLaunchSideStatus] = [
      { ordinal: 0 as const, conversationId: firstConversationId, turnId: firstTurnId, dispatchState: "pending" as const },
      { ordinal: 1 as const, conversationId: secondConversationId, turnId: secondTurnId, dispatchState: "pending" as const },
    ];
    const worktreePath = "C:\\workspace $()\\.inertia\\worktrees\\33333333`tick`";
    const branch = "inertia/33333333";
    const retainedWorktreeMessage = "Owned worktree cleanup still needs attention. Review the structured recovery details.";
    const recoveryGuidance = [{
      kind: "git-worktree" as const,
      ordinal: 0 as const,
      topology: "owned" as const,
      repositoryPath: "C:\\workspace $()",
      plannedPath: worktreePath,
      observedPath: worktreePath,
      worktreeId: "33333333",
      generatedBranch: branch,
      expectedHead: "b".repeat(40),
      observedBranch: branch,
      observedHead: "b".repeat(40),
      actions: [{
        label: "Remove retained linked worktree",
        cwd: "C:\\workspace $()",
        executable: "git" as const,
        args: ["worktree", "remove", "--", worktreePath],
      }],
    }];
    let recoveryRequired = false;
    let manualCleanupComplete = false;
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        return pendingLaunchesEvent([launchId]);
      }
      if (command.type === "duo.status") {
        return {
          type: "request.result",
          requestId: crypto.randomUUID(),
          result: {
            kind: "duo.status",
            launchId,
            state: recoveryRequired ? "recovery-required" : "prepared",
            error: recoveryRequired ? retainedWorktreeMessage : null,
            sides,
            recoveryGuidance: recoveryRequired ? recoveryGuidance : [],
          },
        };
      }
      expect(command).toEqual({ type: "duo.cancel", payload: { launchId } });
      recoveryRequired = !manualCleanupComplete;
      return {
        type: "request.result",
        requestId: crypto.randomUUID(),
        result: {
          kind: "duo.status",
          launchId,
          state: recoveryRequired ? "recovery-required" : "cancelled",
          error: recoveryRequired ? retainedWorktreeMessage : null,
          recoveryGuidance: recoveryRequired ? recoveryGuidance : [],
          sides: [
            { ...sides[0], dispatchState: recoveryRequired ? "pending" : "cancelled" },
            { ...sides[1], dispatchState: recoveryRequired ? "pending" : "cancelled" },
          ],
        },
      };
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
      splitSelectionTransitionsRef: { current: 0 },
      updateSplitConversationId: vi.fn(),
      showWorkspace: vi.fn(),
      closeSidebar: vi.fn(),
      focusWorkspace: vi.fn(),
      discardDraftConversation: vi.fn(),
      setActionError: vi.fn(),
    }));

    act(() => hook.result.current.openDialog());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(3));

    expect(run.mock.calls.map(([, command]) => command.type)).toEqual([
      "duo.pending",
      "duo.status",
      "duo.cancel",
    ]);
    expect(window.localStorage.getItem(
      MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
    )).toBeNull();
    expect(hook.result.current.error).toBe(
      retainedWorktreeMessage,
    );
    expect(hook.result.current.recoveryGuidance).toEqual(recoveryGuidance);

    manualCleanupComplete = true;
    act(() => hook.result.current.closeDialog());
    act(() => hook.result.current.openDialog());
    await waitFor(() => expect(run).toHaveBeenCalledTimes(6));

    expect(run.mock.calls.map(([, command]) => command.type)).toEqual([
      "duo.pending",
      "duo.status",
      "duo.cancel",
      "duo.pending",
      "duo.status",
      "duo.cancel",
    ]);
    expect(window.localStorage.getItem(
      MULTI_SPAWN_PENDING_LAUNCH_STORAGE_KEY,
    )).toBeNull();
    expect(hook.result.current.error).toBe(
      "The duo launch was cancelled before both providers began.",
    );
    expect(hook.result.current.recoveryGuidance).toEqual([]);
  });

  it("closes for authoritative reconciliation after ambiguous preparation", async () => {
    const setActionError = vi.fn();
    const discardDraftConversation = vi.fn();
    const focusWorkspace = vi.fn();
    const run = vi.fn(async (
      _key: string,
      command: CommandWithoutId,
    ): Promise<ServerEvent> => {
      if (command.type === "duo.pending") {
        return pendingLaunchesEvent();
      }
      throw new RuntimeCommandError("Connection interrupted.", "ambiguous");
    });
    const hook = renderHook(() => useMultiSpawn({
      snapshot,
      settings,
      run,
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
      expect.stringContaining("will not be retried automatically"),
    );
    expect(discardDraftConversation).not.toHaveBeenCalled();
    expect(focusWorkspace).toHaveBeenCalledTimes(1);
  });
});
