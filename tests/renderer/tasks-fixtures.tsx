import { render } from "@testing-library/react";
import { vi } from "vitest";

import { TasksView, type TasksViewProps } from "../../src/renderer/src/components/TasksView";
import type { CommandWithoutId } from "../../src/renderer/src/lib/runtimeCommands";
import type {
  AppSnapshot,
  ConversationLatestTurnSummary,
  ConversationShell,
  Project,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import type { Todo } from "../../src/shared/todos";

export const NOW = new Date(2026, 9, 12, 9);
export const stamp = "2026-10-12T07:00:00.000Z";
export const firstProjectId = "11111111-1111-4111-8111-111111111111";
export const secondProjectId = "22222222-2222-4222-8222-222222222222";
export const createdProjectId = "33333333-3333-4333-8333-333333333333";
export const conversationId = "44444444-4444-4444-8444-444444444444";
export const otherConversationId = "55555555-5555-4555-8555-555555555555";
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const firstId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const thirdId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const fourthId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

export function project(id: string, name: string, overrides: Partial<Project> = {}): Project {
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
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

export const provider: ProviderInfo = {
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
    fastMode: { providerValue: "priority", label: "Fast", description: "Faster responses", isDefault: false },
  }],
  rateLimits: [],
  metadataState: {
    models: {
      freshness: "fresh",
      provenance: "provider",
      updatedAt: stamp,
      lastAttemptedAt: stamp,
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

export const settings = {
  ...defaultSettings,
  defaultProvider: "codex" as const,
  defaultModel: "gpt-5.6-sol",
  defaultReasoningEffort: "high",
  confirmDestructiveActions: false,
};

export function todo(id: string, title: string, overrides: Partial<Todo> = {}): Todo {
  return {
    id,
    title,
    note: "",
    priority: null,
    dueDate: null,
    dueTime: null,
    projectId: null,
    completedAt: null,
    conversationId: null,
    linkedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

export function turn(overrides: Partial<ConversationLatestTurnSummary> = {}): ConversationLatestTurnSummary {
  const selection = providerNativeModelSelection({ providerId: "codex" });
  return {
    id: "66666666-6666-4666-8666-666666666666",
    runId: "77777777-7777-4777-8777-777777777777",
    status: "completed",
    providerId: "codex",
    harnessId: selection.harnessId,
    backendProfileId: selection.backendProfileId,
    modelSelection: selection,
    continuationIdentity: null as unknown as ConversationLatestTurnSummary["continuationIdentity"],
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
    requestedAt: stamp,
    startedAt: stamp,
    completedAt: stamp,
    terminalReason: null,
    updatedAt: stamp,
    ...overrides,
  };
}

export function conversation(overrides: Partial<ConversationShell> = {}): ConversationShell {
  return {
    id: conversationId,
    projectId: firstProjectId,
    title: "Clean the downloads folder",
    providerId: "codex",
    modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    continuationIdentity: null,
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "running",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: stamp,
    createdAt: stamp,
    updatedAt: stamp,
    latestTurn: null,
    pendingApproval: false,
    pendingInput: false,
    ...overrides,
  };
}

export function snapshot(todos: Todo[], overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    projects: [project(firstProjectId, "Inertia"), project(secondProjectId, "Companion")],
    conversations: [],
    runs: [],
    providers: [provider],
    backendProfiles: [],
    backendDefaults: [],
    settings,
    todos,
    activeProjectId: firstProjectId,
    activeConversationId: null,
    ...overrides,
  };
}

export const ok = (): ServerEvent => ({ type: "request.ok", requestId: "request" });

export const started = (id = conversationId): ServerEvent => ({
  type: "request.result",
  requestId: "request",
  result: { kind: "todo.started", conversationId: id },
});

type Request = (command: CommandWithoutId, options?: { passive?: boolean }) => Promise<ServerEvent>;

export function harness(initial: AppSnapshot, overrides: Partial<TasksViewProps> = {}) {
  const request = vi.fn<Request>(async () => ok());
  const onOpenConversation = vi.fn();
  const onError = vi.fn();
  let current = initial;
  let extra: Partial<TasksViewProps> = {};
  const props = (): TasksViewProps => ({
    snapshot: current,
    settings,
    status: "online",
    projectScopeId: null,
    request,
    onOpenConversation,
    onError,
    ...overrides,
    ...extra,
  });
  const view = render(<TasksView {...props()} />);
  return {
    ...view,
    request: (overrides.request ?? request) as ReturnType<typeof vi.fn<Request>>,
    onOpenConversation,
    onError,
    update(next: AppSnapshot) {
      current = next;
      view.rerender(<TasksView {...props()} />);
    },
    setProps(next: Partial<TasksViewProps>) {
      extra = { ...extra, ...next };
      view.rerender(<TasksView {...props()} />);
    },
  };
}

type CommandOf<Type extends CommandWithoutId["type"]> = Extract<CommandWithoutId, { type: Type }>;

export function sent<Type extends CommandWithoutId["type"]>(
  request: { mock: { calls: unknown[][] } },
  type: Type,
): CommandOf<Type>[] {
  return request.mock.calls
    .map(([command]) => command as CommandWithoutId)
    .filter((command): command is CommandOf<Type> => command.type === type);
}

export function titleButton(title: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("[data-task-title]")]
    .find((button) => button.querySelector(".task-title-text")?.textContent === title);
  if (!match) throw new Error(`No task row titled ${title}`);
  return match;
}

export function row(title: string): HTMLElement {
  return titleButton(title).closest("li")!;
}

export function check(title: string): HTMLInputElement {
  return row(title).querySelector<HTMLInputElement>(".task-check")!;
}

export function openTitles(): string[] {
  return [...document.querySelectorAll(".tasks-open-list .task-title-text")].map((node) => node.textContent ?? "");
}

export function stubMatchMedia(reduced = false): void {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}
