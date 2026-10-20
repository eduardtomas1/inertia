import type { AppSettings, AppSnapshot, Conversation, Initiative, Project } from "@shared/contracts";
import { effectiveNewChatDefault, type NewChatDefaultSnapshot } from "@shared/new-chat-default";

import { initiativeById } from "./initiativeAccess";

/**
 * The project a chat started from this initiative pre-fills, while that
 * project still exists; otherwise the picker keeps its current project.
 */
export function initiativeDefaultProject(
  snapshot: Pick<AppSnapshot, "projects"> & Partial<Pick<AppSnapshot, "initiatives">> | null | undefined,
  initiativeId: string | null,
): Project | null {
  const projectId = initiativeById(snapshot, initiativeId)?.preferences.defaultProjectId;
  return projectId ? snapshot?.projects.find(({ id }) => id === projectId) ?? null : null;
}

/**
 * "From initiative “Checkout”" while a new chat's model is the one its
 * initiative supplies; undefined once the user picks another model or when
 * the initiative's model is unavailable and a later layer supplied it.
 */
export function initiativeModelSourceLabel(
  snapshot: NewChatDefaultSnapshot,
  settings: Pick<AppSettings, "defaultProvider" | "defaultModel" | "defaultReasoningEffort">,
  conversation: Pick<Conversation, "projectId" | "modelSelection">,
  initiative: Pick<Initiative, "id" | "name"> | null | undefined,
): string | undefined {
  if (!initiative) return undefined;
  const resolved = effectiveNewChatDefault(snapshot, settings, conversation.projectId, initiative.id);
  const selection = conversation.modelSelection;
  return resolved.source === "initiative"
    && selection.harnessId === resolved.selection.harnessId
    && selection.backendProfileId === resolved.selection.backendProfileId
    && selection.modelId === resolved.selection.modelId
    ? `From initiative “${initiative.name}”`
    : undefined;
}
