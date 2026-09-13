import type { PrivateConnectResponse } from "../../shared/private-connect/protocol";
import type { PrivateConnectRuntimeResponse, PrivateConnectRuntimeConversation } from "../../shared/private-connect/runtime-contract";
import { presetForScopes } from "../../shared/private-connect/scopes";
import type { PrivateConnectDevice } from "./store";

export function adaptPrivateConnectRuntimeResponse(
  response: PrivateConnectRuntimeResponse,
  device: PrivateConnectDevice,
): PrivateConnectResponse {
  if (!response.ok) return response;
  const capabilities = {
    scopes: [...device.scopes],
    preset: presetForScopes(device.scopes),
    expiresAt: device.expiresAt,
  };
  if (response.result.kind === "state") {
    return {
      ...response,
      result: {
        kind: "state",
        ...(response.result.validator === undefined
          ? {}
          : { validator: response.result.validator }),
        state: {
          generatedAt: response.result.state.generatedAt,
          projects: response.result.state.projects,
          conversations: response.result.state.conversations.map((conversation) => publicConversation(conversation)),
          capabilities,
        },
      },
    };
  }
  if (response.result.kind === "conversation") {
    const detail = response.result.detail;
    return {
      ...response,
      result: {
        kind: "conversation",
        ...(response.result.validator === undefined
          ? {}
          : { validator: response.result.validator }),
        detail: {
          generatedAt: detail.generatedAt,
          conversation: publicConversation(detail.conversation, detail.waitingForLocalAction),
          messages: detail.messages,
          activities: detail.activities,
          subagents: detail.subagents,
          plan: detail.plan ?? null,
          questions: detail.questions ?? [],
          inputRequestId: detail.inputRequestId ?? null,
          waitingForLocalAction: detail.waitingForLocalAction,
        },
      },
    };
  }
  return response;
}

function publicConversation(
  conversation: PrivateConnectRuntimeConversation,
  pendingLocalAction = false,
): Pick<PrivateConnectRuntimeConversation, "id" | "projectId" | "title" | "providerLabel" | "runId" | "status" | "pendingLocalApproval" | "updatedAt"> & { pendingLocalAction: boolean } {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: conversation.title,
    providerLabel: conversation.providerLabel,
    runId: conversation.runId,
    status: conversation.status,
    pendingLocalApproval: conversation.pendingLocalApproval,
    pendingLocalAction: pendingLocalAction || conversation.pendingLocalApproval || conversation.status === "needs-input",
    updatedAt: conversation.updatedAt,
  };
}

