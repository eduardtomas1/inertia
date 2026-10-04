import type {
  AppSettings,
  AppSnapshot,
  ModelSelection,
} from "@shared/contracts";
import { effectiveNewChatDefault } from "../../../shared/new-chat-default";
import {
  buildNewConversationPayload,
  type NewConversationLocation,
  type NewConversationPayload,
  withNewConversationModelSelection,
} from "../lib/newConversation";

export function defaultSelectionForProject(
  snapshot: Pick<
    AppSnapshot,
    "backendDefaults" | "backendProfiles" | "providers"
  >,
  settings: AppSettings,
  projectId: string,
): ModelSelection {
  return effectiveNewChatDefault(snapshot, settings, projectId).selection;
}

export function defaultConversationPayloadForProject(
  snapshot: Pick<
    AppSnapshot,
    "backendDefaults" | "backendProfiles" | "providers"
  > & Partial<Pick<AppSnapshot, "projects">>,
  settings: AppSettings,
  projectId: string,
  location: NewConversationLocation = { kind: "defaults" },
): NewConversationPayload {
  return withNewConversationModelSelection(
    buildNewConversationPayload(snapshot.projects?.find(({ id }) => id === projectId) ?? projectId, settings, location),
    defaultSelectionForProject(snapshot, settings, projectId),
  );
}
