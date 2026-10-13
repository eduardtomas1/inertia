import type { ClientCommand } from "../../shared/contracts";
import type {
  ProviderMaintenanceOperation,
  ProviderMaintenanceProviderId,
} from "../../shared/provider-maintenance";
import type { UpdateProviderResult, UpdatesRunResult } from "../../shared/updates";
import type { RuntimeStore } from "../database";
import type { ProviderMaintenanceController } from "../provider/maintenance-controller";
import { publicRuntimeError, RuntimeRequestError } from "../runtime-errors";
import { hold, isHeld, release, scheduleSafetyRelease, UPDATE_HOLD_MESSAGE } from "./update-hold";

export type UpdatesRunRequest = Extract<ClientCommand, { type: "updates.run" }>["payload"];

export interface UpdateInterruptionController {
  activeConversationIds(): string[];
  interruptForUpdate(
    conversationIds: readonly string[],
    options: { continues: readonly string[] },
  ): Promise<void>;
}

export interface RestartContinuationPlanner {
  createPlans(conversationIds: readonly string[]): readonly string[];
  arm(): void;
}

export interface UpdateEverythingDependencies {
  store: Pick<RuntimeStore, "conversation">;
  turns: UpdateInterruptionController;
  maintenance: Pick<ProviderMaintenanceController, "current" | "startUpdate" | "settled">;
  restartContinuation: RestartContinuationPlanner;
}

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
): string[] {
  const providerIds = new Set<string>(request.providerIds);
  return dependencies.turns.activeConversationIds().filter((conversationId) => {
    if (request.includeApp) return true;
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
): Promise<UpdatesRunResult> {
  if (isHeld()) throw new RuntimeRequestError(UPDATE_HOLD_MESSAGE);
  const conversationIds = interruptedConversationIds(dependencies, request);
  hold(() => dependencies.restartContinuation.arm());
  let readyForAppInstall = false;
  try {
    const continues = request.continueChats
      ? dependencies.restartContinuation.createPlans(conversationIds)
      : [];
    await dependencies.turns.interruptForUpdate(conversationIds, { continues });
    const providers: UpdateProviderResult[] = [];
    for (const providerId of request.providerIds) {
      providers.push(await updateProvider(dependencies.maintenance, providerId));
    }
    readyForAppInstall = request.includeApp;
    return {
      kind: "updates.run",
      providers,
      interruptedConversationIds: conversationIds,
      readyForAppInstall,
    };
  } finally {
    if (readyForAppInstall) scheduleSafetyRelease();
    else release();
  }
}

export function finishUpdateEverything(installed: boolean): void {
  if (!installed) release();
}
