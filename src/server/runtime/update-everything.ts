import type WebSocket from "ws";

import type { ClientCommand } from "../../shared/contracts";
import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
} from "../../shared/provider-maintenance";
import type { UpdateProviderResult, UpdatesRunResult } from "../../shared/updates";
import type { RuntimeStore } from "../database";
import type { ProviderMaintenanceController } from "../provider/maintenance-controller";
import type { RuntimeUpdatePreparationGate } from "../runtime-update-preparation";
import { publicRuntimeError, RuntimeRequestError } from "../runtime-errors";
import { hold, isAwaitingFinish, isHeld, release, scheduleSafetyRelease, UPDATE_HOLD_MESSAGE } from "./update-hold";

export type UpdatesRunRequest = Extract<ClientCommand, { type: "updates.run" }>["payload"];

export interface UpdateInterruptionController {
  activeConversationIds(): string[];
  interruptForUpdate(conversationIds: readonly string[]): Promise<boolean>;
}

export interface RestartContinuationPlanner {
  createPlans(conversationIds: readonly string[]): string[];
  arm(): void;
}

export interface UpdateEverythingDependencies {
  store: Pick<RuntimeStore, "conversation">;
  turns: UpdateInterruptionController;
  maintenance: Pick<ProviderMaintenanceController, "current" | "startUpdate" | "settled">;
  restartContinuation: RestartContinuationPlanner;
  preparation: Pick<RuntimeUpdatePreparationGate, "isAdmissionClosed" | "restartBlockerBesidesAgentTurns">;
}

const RESTART_BLOCKERS: Record<NonNullable<ReturnType<RuntimeUpdatePreparationGate["restartBlockerBesidesAgentTurns"]>>, string> = {
  "database-recovery": "Wait for database recovery to finish before restarting.",
  "agent-work": "Wait for workspace runs to finish before restarting to update.",
  terminal: "Close active terminals before restarting to update.",
};

const OUTCOMES: Record<ProviderMaintenanceOperation["status"], UpdateProviderResult["outcome"]> = {
  queued: "failed",
  running: "failed",
  succeeded: "updated",
  unchanged: "unchanged",
  failed: "failed",
  cancelled: "skipped",
};

function interruptedConversationIds(
  dependencies: UpdateEverythingDependencies,
  request: UpdatesRunRequest,
  appRestarts: boolean,
): string[] {
  const providerIds = new Set<string>(request.providerIds);
  return dependencies.turns.activeConversationIds().filter((conversationId) => {
    if (appRestarts) return true;
    try {
      return providerIds.has(dependencies.store.conversation(conversationId).providerId);
    } catch {
      return false;
    }
  });
}

async function updateProvider(
  maintenance: UpdateEverythingDependencies["maintenance"],
  providerId: ProviderMaintenanceProviderId,
): Promise<UpdateProviderResult> {
  let started: ProviderMaintenanceOperation;
  try {
    started = await maintenance.startUpdate(providerId);
  } catch (error) {
    return {
      providerId,
      outcome: "failed",
      beforeVersion: maintenance.current(providerId)[0]?.installedVersion ?? null,
      afterVersion: null,
      error: publicRuntimeError(error),
    };
  }
  const operation = await maintenance.settled(started.id) ?? started;
  const outcome = OUTCOMES[operation.status];
  return {
    providerId,
    outcome,
    beforeVersion: operation.beforeVersion,
    afterVersion: operation.afterVersion,
    error: outcome === "failed" || outcome === "skipped" ? operation.message : null,
  };
}

export async function runUpdateEverything(
  dependencies: UpdateEverythingDependencies,
  request: UpdatesRunRequest,
  owner: Pick<WebSocket, "readyState" | "once" | "off">,
): Promise<UpdatesRunResult> {
  if (isHeld() && !isAwaitingFinish()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
  const blocker = request.includeApp ? dependencies.preparation.restartBlockerBesidesAgentTurns() : null;
  const conversationIds = interruptedConversationIds(dependencies, request, request.includeApp && !blocker);
  let returned = false;
  let ownerClosed = owner.readyState > 1;
  const closed = (): void => {
    ownerClosed = true;
    if (returned && !dependencies.preparation.isAdmissionClosed()) release(generation);
  };
  const generation = hold(() => {
    owner.off("close", closed);
    dependencies.restartContinuation.arm();
  });
  owner.once("close", closed);
  let readyForAppInstall = false;
  try {
    if (request.continueChats) dependencies.restartContinuation.createPlans(conversationIds);
    await dependencies.turns.interruptForUpdate(conversationIds);
    const providers: UpdateProviderResult[] = [];
    for (const providerId of request.providerIds) {
      providers.push(await updateProvider(dependencies.maintenance, providerId));
    }
    readyForAppInstall = request.includeApp && !blocker;
    return {
      kind: "updates.run",
      providers,
      interruptedConversationIds: conversationIds,
      readyForAppInstall,
      appInstallBlocker: blocker ? RESTART_BLOCKERS[blocker] : null,
    };
  } finally {
    returned = true;
    if (readyForAppInstall && !ownerClosed) scheduleSafetyRelease();
    else release(generation);
  }
}

export function finishUpdateEverything(installed: boolean): void {
  if (!installed) release();
}
