import { describe, expect, it, vi } from "vitest";

import { defaultSettings, type Conversation, type Project } from "../../src/shared/contracts";
import { MIXED_PROVIDER_HISTORY_MESSAGE } from "../../src/shared/continuation-policy";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { replacementChatStarter } from "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel";
import {
  buildNewConversationPayload,
  replacementConversationCommand,
  replacementConversationPayload,
  withNewConversationModelSelection,
} from "../../src/renderer/src/lib/newConversation";
import { replacementChatRequest } from "../../src/renderer/src/utils/modelRouteTransition";
import { conversation } from "./composer-fixtures";

const project: Project = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Inertia",
  path: "/workspace/inertia",
  normalizedPath: "/workspace/inertia",
  repositoryIdentity: "git:/workspace/inertia/.git",
  repositoryRoot: "/workspace/inertia",
  repositoryRelativePath: ".",
  groupingMode: null,
  gitRepositoryLimit: 128,
  color: "#5661d8",
  status: "ready",
  createdAt: "2026-07-25T10:00:00.000Z",
  updatedAt: "2026-07-25T10:00:00.000Z",
};
const broadDefaults = { ...defaultSettings, defaultAccessMode: "full" as const, defaultInteractionMode: "build" as const };
const planChat: Conversation = {
  ...conversation("55555555-5555-4555-8555-555555555555"),
  accessMode: "supervised",
  interactionMode: "plan",
};
const claude = providerNativeModelSelection({ providerId: "claude" });

describe("replacement chat request", () => {
  it("carries the replaced chat's access and interaction modes", () => {
    expect(replacementChatRequest(planChat)).toEqual({
      selection: planChat.modelSelection,
      configuration: { accessMode: "supervised", interactionMode: "plan" },
    });
    expect(replacementChatRequest(planChat, { selection: claude, prefillText: "Keep going." })).toEqual({
      selection: claude,
      configuration: { accessMode: "supervised", interactionMode: "plan" },
      prefillText: "Keep going.",
    });
  });

  it("uses a configuration only when the user chose it with the route", () => {
    const chosen = { accessMode: "auto-edit" as const, interactionMode: "build" as const };
    expect(replacementChatRequest(planChat, { selection: claude, configuration: chosen }).configuration).toEqual(chosen);
  });

  it("creates the replacement with the carried settings instead of broader project defaults", () => {
    const payload = replacementConversationPayload(project, broadDefaults, replacementChatRequest(planChat, { selection: claude }));
    expect(payload).toMatchObject({ accessMode: "supervised", interactionMode: "plan", activate: false, providerId: "claude" });
  });

  it("leaves the payload unchanged for a chat on the project defaults", () => {
    const defaultChat = { ...planChat, accessMode: broadDefaults.defaultAccessMode, interactionMode: broadDefaults.defaultInteractionMode };
    expect(replacementConversationPayload(project, broadDefaults, replacementChatRequest(defaultChat, { selection: claude }))).toEqual({
      ...withNewConversationModelSelection(buildNewConversationPayload(project, broadDefaults), claude),
      activate: false,
    });
  });

  it("continues from the replaced chat only when the request names it", () => {
    const request = replacementChatRequest(planChat, { selection: claude });
    expect(replacementConversationCommand(project, broadDefaults, request)).toEqual({
      type: "conversation.create",
      payload: replacementConversationPayload(project, broadDefaults, request),
    });
    expect(replacementConversationCommand(project, broadDefaults, replacementChatRequest(planChat, {
      selection: claude,
      prefillText: "Keep going.",
      sourceConversationId: planChat.id,
    }))).toEqual({
      type: "conversation.continue",
      payload: {
        sourceConversationId: planChat.id,
        modelSelection: claude,
        accessMode: "supervised",
        interactionMode: "plan",
      },
    });
  });

  it("starts the goal panel's replacement chat with the carried settings", () => {
    const create = vi.fn(async () => undefined);
    const onError = vi.fn();
    expect(replacementChatStarter(planChat, null, create, onError)).toBeUndefined();
    replacementChatStarter(planChat, MIXED_PROVIDER_HISTORY_MESSAGE, create, onError)!();
    expect(create).toHaveBeenCalledWith(replacementChatRequest(planChat));
    expect(create.mock.calls[0]).toEqual([{
      selection: planChat.modelSelection,
      configuration: { accessMode: "supervised", interactionMode: "plan" },
    }]);
  });
});
