import type { RuntimeStore } from "../database";
import type { OrchestrationEffectRuntime } from "../orchestration-v2/effect-runtime";
import { ownedProviderStopBudgetMs } from "../provider/run-cleanup-settlement";
import type { TurnController } from "./turns/turn-controller";

interface PendingSteerTask {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const pendingSteers = new Map<string, PendingSteerTask>();
const interruptOutcomes = new Map<string, "cancelled" | "ended">();

/**
 * Hands an in-process steer invocation to the `provider.steer` effect handler so
 * raw prompt text and attachments never enter the V2 event log or effect payload (N17),
 * while execution still flows through `OrchestrationEffectDispatcher` in per-thread order.
 * When no `provider.steer` effect runtime is active (e.g. direct unit tests), runs `work` directly.
 */
export async function executeSteerViaEffectRuntime<T>(
  store: RuntimeStore,
  effectId: string | null,
  work: () => Promise<T>,
): Promise<T> {
  if (!effectId || !store.orchestration.runControl.dispatchesViaEffectRuntime("provider.steer")) {
    return await work();
  }
  return await new Promise<T>((resolve, reject) => {
    pendingSteers.set(effectId, {
      run: () => work(),
      resolve: (value) => resolve(value as T),
      reject,
    });
  });
}

export function takeInterruptOutcome(effectId: string): "cancelled" | "ended" | null {
  const outcome = interruptOutcomes.get(effectId) ?? null;
  if (outcome !== null) interruptOutcomes.delete(effectId);
  return outcome;
}

export interface RunControlEffectHandlerDependencies {
  effects: OrchestrationEffectRuntime;
  store: RuntimeStore;
  turns: TurnController;
}

export function registerRunControlEffectHandlers(
  dependencies: RunControlEffectHandlerDependencies,
): () => void {
  const { effects, store, turns } = dependencies;
  const runControl = store.orchestration.runControl;
  runControl.attachEffectRuntime(effects);

  const unregisterInterrupt = effects.register("provider.interrupt", async (payload, context) => {
    const earlierSteers = runControl.unsettledSteersBefore(context.effectId);
    if (earlierSteers.length > 0) {
      await runControl.awaitSettled(earlierSteers, Date.now() + ownedProviderStopBudgetMs());
    }
    let cancelled: boolean;
    try {
      cancelled = turns.cancelExact(context.threadId, {
        runId: payload.runId,
        turnId: payload.turnId,
      });
    } catch (error) {
      runControl.settleInterrupt(payload.runId, "failed");
      throw error;
    }
    interruptOutcomes.set(context.effectId, cancelled ? "cancelled" : "ended");
    if (!cancelled) {
      runControl.settleInterrupt(payload.runId, "settled");
    }
  });

  const unregisterSteer = effects.register("provider.steer", async (_payload, context) => {
    let task = pendingSteers.get(context.effectId);
    if (!task) {
      // Allow a caller that committed `requestSteer` and registered its task synchronously on the next turn to attach.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      task = pendingSteers.get(context.effectId);
    }
    if (!task) {
      // Process-bound steer with no live caller (e.g. interrupted by restart): never replay.
      runControl.settleSteer(context.effectId, "unconfirmed");
      return;
    }
    pendingSteers.delete(context.effectId);
    try {
      const value = await task.run();
      task.resolve(value);
    } catch (error) {
      task.reject(error);
    }
  });

  return () => {
    unregisterInterrupt();
    unregisterSteer();
    runControl.attachEffectRuntime(null);
  };
}
