import { isAgentTurnTerminalStatus } from "../../../shared/contracts";
import { RecordNotFoundError, type RuntimeStore } from "../../database";
import type { TurnController } from "../turns/turn-controller";

type StoredLaunch = ReturnType<RuntimeStore["pairedLaunch"]>;

function hasActiveExactTurnRun(store: RuntimeStore, runId: string): boolean {
  try {
    const run = store.workspaceRun(runId);
    return run.status === "running" || run.status === "waiting";
  } catch (error) {
    if (error instanceof RecordNotFoundError) return false;
    throw error;
  }
}

export async function reconcileInactiveDuoLaunchTurns(
  store: RuntimeStore,
  turns: TurnController,
  launch: StoredLaunch,
  options: {
    comparisonOnly?: boolean;
    providerRunOwnershipConfirmedTurnIds?: ReadonlySet<string>;
    allowProviderStop?: boolean;
    authorizedCheckoutReservationIds?: readonly string[];
  } = {},
): Promise<boolean> {
  const candidates: Array<{ conversationId: string; turnId: string }> = [];
  try {
    if (!options.comparisonOnly) {
      for (const side of launch.sides) {
        if (side.conversationId && side.turnId) {
          const turn = store.agentTurn(side.turnId);
          if (
            !isAgentTurnTerminalStatus(turn.status)
            || hasActiveExactTurnRun(store, turn.runId)
            || turns.isActive(side.conversationId)
          ) {
            candidates.push({
              conversationId: side.conversationId,
              turnId: side.turnId,
            });
          }
          continue;
        }
        if (
          launch.state === "prepared"
          || launch.state === "dispatching"
          || launch.state === "running"
        ) return false;
      }
    }
    const comparison = launch.comparison;
    if (comparison?.conversationId && comparison.turnId) {
      const turn = store.agentTurn(comparison.turnId);
      if (
        !isAgentTurnTerminalStatus(turn.status)
        || hasActiveExactTurnRun(store, turn.runId)
        || turns.isActive(comparison.conversationId)
      ) {
        candidates.push({
          conversationId: comparison.conversationId,
          turnId: comparison.turnId,
        });
      }
    } else if (
      comparison?.state === "dispatching"
      || comparison?.state === "running"
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const confirmed = options.providerRunOwnershipConfirmedTurnIds ?? new Set();
  const results = await Promise.all(candidates.map(({ conversationId, turnId }) =>
    turns.reconcileInactiveDuoTurn(
      launch.launchId,
      conversationId,
      turnId,
      {
        providerRunOwnershipConfirmed: confirmed.has(turnId),
        allowProviderStop: options.allowProviderStop ?? true,
        authorizedCheckoutReservationIds:
          options.authorizedCheckoutReservationIds,
      },
    )));
  return results.every(Boolean);
}

export async function reconcileDuoDeletionLaunches(
  store: RuntimeStore,
  turns: TurnController,
  related: { launchIds: string[]; hasMore: boolean },
  authorizedCheckoutReservationIds: readonly string[] = [],
): Promise<boolean> {
  for (const launchId of related.launchIds) {
    let launch: StoredLaunch;
    try {
      launch = store.pairedLaunch(launchId);
      const comparisonSettled = !launch.comparison || (
        launch.comparison.state === "cancelled"
        || launch.comparison.state === "completed"
      );
      const settledIntent = comparisonSettled && (
        launch.state === "cancelled"
        || launch.state === "failed"
        || launch.state === "running"
      );
      if (!settledIntent) continue;
    } catch {
      return false;
    }
    if (!await reconcileInactiveDuoLaunchTurns(store, turns, launch, {
      allowProviderStop: false,
      authorizedCheckoutReservationIds,
    })) return false;
  }
  return !related.hasMore;
}
