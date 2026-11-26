import type {
  Conversation,
  ConversationShell,
  Project,
  ProviderInfo,
} from "@shared/contracts";
import { conversationWorkspaceLabel } from "@shared/conversation-context";
import { providerTerminalResumeAvailability } from "@shared/provider-terminal-resume";

import type { ConversationContextSourceOption } from "../conversation-context/types";
import type { ProviderTerminalResumeOption } from "../providerResumeOptions";
import { compareIsoTextDesc as compareUpdatedAtDesc } from "../../utils/fastCompare";

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
  const projectById = new Map<string, Project>();
  const projectDirectoryById = new Map<string, string>();
  for (const entry of input.projects) {
    projectById.set(entry.id, entry);
    projectDirectoryById.set(entry.id, workspaceDirectoryIdentity(entry.normalizedPath));
  }
  const providerById = new Map<string, ProviderInfo>();
  for (const provider of input.providers) {
    providerById.set(provider.id, provider);
  }
  const targetWorkspaceLabel = conversation
    ? workspaceToolsUnavailable
      ? `New isolated worktree for ${project?.name ?? "this project"}`
      : conversationWorkspaceLabel(conversation)
    : "";

  const list = input.conversations;
  let alreadySorted = true;
  let persistedIndex = -1;
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index]!;
    if (entry.id === input.persistedConversationId) persistedIndex = index;
    if (
      alreadySorted
      && index > 0
      && compareUpdatedAtDesc(list[index - 1]!.updatedAt, entry.updatedAt) > 0
    ) {
      alreadySorted = false;
    }
  }

  const visit = (candidate: ConversationShell): void => {
    const candidateProject = projectById.get(candidate.projectId);
    if (!candidateProject) return;
    const candidateDirectory = candidate.worktreePath
      ? workspaceDirectoryIdentity(candidate.worktreePath)
      : projectDirectoryById.get(candidateProject.id)!;
    const sameWorkspace = candidateDirectory === activeDirectory;
    if (conversation && candidate.id !== conversation.id) {
      contextSources.push({
        conversationId: candidate.id,
        conversationTitle: candidate.title,
        projectName: candidateProject.name,
        workspaceLabel: conversationWorkspaceLabel(candidate),
        targetWorkspaceLabel,
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
          providerById.get(candidate.providerId),
        ),
      });
    }
  };

  if (alreadySorted) {
    if (persistedIndex >= 0) visit(list[persistedIndex]!);
    for (let index = 0; index < list.length; index += 1) {
      if (index !== persistedIndex) visit(list[index]!);
    }
  } else {
    const candidates = [...list].sort((left, right) => {
      if (left.id === input.persistedConversationId) return -1;
      if (right.id === input.persistedConversationId) return 1;
      return compareUpdatedAtDesc(left.updatedAt, right.updatedAt);
    });
    for (const candidate of candidates) visit(candidate);
  }
  return { contextSources, resumeOptions };
}
