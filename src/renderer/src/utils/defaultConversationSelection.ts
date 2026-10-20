import type {
  AppSettings,
  AppSnapshot,
  ModelSelection,
} from "@shared/contracts";
import { clampAccessMode } from "../../../shared/access-modes";
import { effectiveNewChatDefault } from "../../../shared/new-chat-default";
import { initiativeById } from "./initiativeAccess";
import {
  buildNewConversationPayload,
  type NewConversationLocation,
  type NewConversationPayload,
  withNewConversationModelSelection,
} from "../lib/newConversation";

type DefaultsSnapshot = Pick<
  AppSnapshot,
  "backendDefaults" | "backendProfiles" | "providers"
> & Partial<Pick<AppSnapshot, "initiatives" | "projects">>;

export function defaultSelectionForProject(
  snapshot: DefaultsSnapshot,
  settings: AppSettings,
  projectId: string,
  initiativeId: string | null = null,
): ModelSelection {
  return effectiveNewChatDefault(snapshot, settings, projectId, initiativeId).selection;
}

/**
 * A new chat's payload from its defaults: the initiative's model and access
 * mode when it sets them, then the project's, then Settings. The access mode
 * never exceeds the initiative's ceiling.
 */
export function defaultConversationPayloadForProject(
  snapshot: DefaultsSnapshot,
  settings: AppSettings,
  projectId: string,
  location: NewConversationLocation = { kind: "defaults" },
  initiativeId: string | null = null,
): NewConversationPayload {
  const payload = buildNewConversationPayload(snapshot.projects?.find(({ id }) => id === projectId) ?? projectId, settings, location);
  const preferences = initiativeById(snapshot, initiativeId)?.preferences;
  const accessMode = clampAccessMode(
    preferences?.defaultAccessMode ?? payload.accessMode ?? settings.defaultAccessMode,
    preferences?.accessCeiling,
  );
  return withNewConversationModelSelection(
    { ...payload, accessMode },
    defaultSelectionForProject(snapshot, settings, projectId, initiativeId),
  );
}
