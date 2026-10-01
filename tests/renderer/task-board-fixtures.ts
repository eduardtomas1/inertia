import type { AppSnapshot, Conversation, Project } from "../../src/shared/contracts";
import { defaultSettings } from "../../src/shared/contracts/app";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

export function project(overrides: Partial<Project> & Pick<Project, "id" | "name" | "path">): Project {
  return {
    normalizedPath: overrides.path,
    repositoryIdentity: null,
    repositoryRoot: null,
    repositoryRelativePath: ".",
    groupingMode: null,
    gitRepositoryLimit: 128,
    color: "#000",
    status: "ready",
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
  };
}

export function conversation(overrides: Partial<Conversation> & Pick<Conversation, "id" | "projectId">): Conversation {
  return {
    title: overrides.id,
    providerId: "codex",
    model: "",
    reasoningEffort: "",
    interactionMode: "build",
    accessMode: "supervised",
    status: "idle",
    attentionKind: null,
    branch: null,
    worktreePath: null,
    providerSessionId: null,
    archivedAt: null,
    settledAt: null,
    completedAt: null,
    lastViewedAt: "2026-07-20T10:00:00.000Z",
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
    ...overrides,
    modelSelection: overrides.modelSelection
      ?? providerNativeModelSelection({ providerId: overrides.providerId ?? "codex" }),
    continuationIdentity: overrides.continuationIdentity ?? null,
  };
}

export const boardProject = project({ id: "p", name: "Inertia", path: "/inertia" });
export function snapshot(conversations: Conversation[]): AppSnapshot {
  return { projects: [boardProject], conversations: conversations.map((chat) => ({ ...chat, latestTurn: null, pendingApproval: false, pendingInput: false })), runs: [], providers: [], settings: defaultSettings,
    backendProfiles: [], backendDefaults: [], promptPresets: [], activeProjectId: "p", activeConversationId: null };
}
