import type {
  Conversation,
  ConversationShell,
  Project,
  ProviderInfo,
} from "@shared/contracts";
import { providerTerminalResumeAvailability } from "@shared/provider-terminal-resume";

import type { ConversationContextSourceOption } from "../conversation-context/types";
import type { ProviderTerminalResumeOption } from "../providerResumeOptions";

export function workspaceDirectoryIdentity(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return /^[a-z]:\//iu.test(normalized) || normalized.startsWith("//")
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

export function terminalResumeDirectory(
  conversation: Pick<Conversation, "worktreePath"> | null,
  project: Pick<Project, "normalizedPath"> | null,
): string | null {
  if (!conversation || !project) return null;
  return workspaceDirectoryIdentity(
    conversation.worktreePath ?? project.normalizedPath,
  );
}

export function visibleWorkspaceConversation(
  persisted: Conversation | null,
  draft: Conversation | null,
): Conversation | null {
  return draft ?? persisted;
}

export interface ConversationWorkspaceOptions {
  contextSources: readonly ConversationContextSourceOption[];
  resumeOptions: readonly ProviderTerminalResumeOption[];
}

export function conversationWorkspaceOptions(input: {
  conversations: readonly ConversationShell[];
  projects: readonly Project[];
  providers: readonly ProviderInfo[];
  persistedConversationId: string | null;
  conversation: Conversation | null;
  project: Project | null;
  workspaceToolsUnavailable: boolean;
}): ConversationWorkspaceOptions {
  const { conversation, project, workspaceToolsUnavailable } = input;
  const contextSources: ConversationContextSourceOption[] = [];
  const resumeOptions: ProviderTerminalResumeOption[] = [];
  const activeDirectory = terminalResumeDirectory(conversation, project);
  if (!activeDirectory) return { contextSources, resumeOptions };
  const projectById = new Map(input.projects.map((entry) => [entry.id, entry]));
  const candidates = [...input.conversations].sort((left, right) => {
    if (left.id === input.persistedConversationId) return -1;
    if (right.id === input.persistedConversationId) return 1;
    return right.updatedAt.localeCompare(left.updatedAt, "en");
  });
  for (const candidate of candidates) {
    const candidateProject = projectById.get(candidate.projectId);
    if (!candidateProject) continue;
    const sameWorkspace = workspaceDirectoryIdentity(
      candidate.worktreePath ?? candidateProject.normalizedPath,
    ) === activeDirectory;
    if (conversation && candidate.id !== conversation.id) {
      contextSources.push({
        conversationId: candidate.id,
        conversationTitle: candidate.title,
        projectName: candidateProject.name,
        workspaceLabel: candidate.worktreePath ?? candidateProject.path,
        targetWorkspaceLabel: workspaceToolsUnavailable
          ? `New isolated worktree for ${project?.name ?? "this project"}`
          : conversation.worktreePath ?? project?.path ?? activeDirectory,
        workspaceRelation: sameWorkspace && !workspaceToolsUnavailable
          ? "same-workspace"
          : "different-workspace",
        archived: candidate.archivedAt !== null,
        latestTurnCompletedAt: candidate.latestTurn?.completedAt ?? null,
      });
    }
    if (sameWorkspace) {
      resumeOptions.push({
        projectId: candidateProject.id,
        projectName: candidateProject.name,
        conversationId: candidate.id,
        conversationTitle: candidate.title,
        availability: providerTerminalResumeAvailability(
          candidate,
          input.providers.find(({ id }) => id === candidate.providerId),
        ),
      });
    }
  }
  return { contextSources, resumeOptions };
}
