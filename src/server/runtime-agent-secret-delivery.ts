import type {
  RuntimeAgentSecretDeliverCommand,
  RuntimeAgentSecretEvent,
  RuntimeAgentSecretReconcileCommand,
} from "../node/runtime-agent-secret-protocol.js";
import type {
  AgentSecretDelivery,
  AgentSecretDeliveryOutcome,
} from "./runtime/agent-secrets/agent-secret-service.js";

export interface RuntimeAgentSecretDeliverer {
  deliverAgentSecret(delivery: AgentSecretDelivery): Promise<AgentSecretDeliveryOutcome>;
  orphanedAgentSecrets(requestIds: readonly string[]): string[];
}

export function answerRuntimeAgentSecretReconcile(
  runtime: Pick<RuntimeAgentSecretDeliverer, "orphanedAgentSecrets"> | null,
  command: RuntimeAgentSecretReconcileCommand,
): Extract<RuntimeAgentSecretEvent, { type: "runtime.agent-secret-reconciled" }> {
  let orphaned: string[] = [];
  try {
    const requested = new Set(command.requestIds);
    orphaned = [...new Set(runtime?.orphanedAgentSecrets(command.requestIds) ?? [])].filter((requestId) => requested.has(requestId));
  } catch {
    orphaned = [];
  }
  return { type: "runtime.agent-secret-reconciled", transportId: command.transportId, orphaned };
}

export async function answerRuntimeAgentSecretDelivery(
  runtime: Pick<RuntimeAgentSecretDeliverer, "deliverAgentSecret"> | null,
  command: RuntimeAgentSecretDeliverCommand,
): Promise<RuntimeAgentSecretEvent> {
  const { transportId } = command;
  if (!runtime) return { type: "runtime.agent-secret-rejected", transportId, reason: "ended" };
  let outcome: AgentSecretDeliveryOutcome;
  try {
    outcome = await runtime.deliverAgentSecret({
      conversationId: command.conversationId,
      requestId: command.requestId,
      secret: command.secret,
      vaulted: command.vaulted,
    });
  } catch {
    return { type: "runtime.agent-secret-rejected", transportId, reason: "file-failed" };
  }
  return outcome.status === "delivered"
    ? { type: "runtime.agent-secret-delivered", transportId, expiresAt: outcome.expiresAt, storage: outcome.storage }
    : { type: "runtime.agent-secret-rejected", transportId, reason: outcome.reason };
}
