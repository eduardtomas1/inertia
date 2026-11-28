import type { RuntimeStore } from "../database";
import type { OrchestrationEffectRuntime } from "../orchestration-v2/effect-runtime";
import { ownedProviderStopBudgetMs } from "../provider/run-cleanup-settlement";
import type { TurnController } from "./turns/turn-controller";

interface PendingSteerTask {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface RunControlState {
  pendingSteers: Map<string, PendingSteerTask>;
  pendingSteerWaiters: Map<string, (task: PendingSteerTask | null) => void>;
}

const STEER_ATTACH_WAIT_MS = 50;
const stateByStore = new WeakMap<RuntimeStore, RunControlState>();
const interruptOutcomes = new Map<string, "cancelled" | "ended">();

function stateForStore(store: RuntimeStore): RunControlState {
  let state = stateByStore.get(store);
  if (!state) {
    state = {
      pendingSteers: new Map(),
      pendingSteerWaiters: new Map(),
    };
    stateByStore.set(store, state);
  }
  return state;
}

export async function executeSteerViaEffectRuntime<T>(
  store: RuntimeStore,
  effectId: string | null,
  work: () => Promise<T>,
): Promise<T> {
  if (!effectId || !store.orchestration.runControl.dispatchesViaEffectRuntime("provider.steer")) {
    return await work();
  }
  const steer = store.orchestration.runControl.steer(effectId);
  const effect = store.orchestration.effects.get(effectId);
  if (
    steer?.state === "settled"
    || (effect !== null && effect.state !== "pending" && effect.state !== "running")
  ) {
    throw new Error("The steer effect was already settled before execution attached.");
  }
  const state = stateForStore(store);
  return await new Promise<T>((resolve, reject) => {
    const task: PendingSteerTask = {
      run: () => work(),
      resolve: (value) => resolve(value as T),
      reject,
    };
    const waiter = state.pendingSteerWaiters.get(effectId);
    if (waiter) {
      state.pendingSteerWaiters.delete(effectId);
      waiter(task);
      return;
    }
    state.pendingSteers.set(effectId, task);
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
  const state = stateForStore(store);
  const recordedInterruptEffects = new Set<string>();
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
    recordedInterruptEffects.add(context.effectId);
    if (!cancelled) {
      runControl.settleInterrupt(payload.runId, "settled");
    }
  });

  const unregisterSteer = effects.register("provider.steer", async (_payload, context) => {
    let task = state.pendingSteers.get(context.effectId);
    if (task) {
      state.pendingSteers.delete(context.effectId);
    } else if (!context.signal.aborted) {
      task = await new Promise<PendingSteerTask | undefined>((resolve) => {
        let done = false;
        const finish = (attached: PendingSteerTask | null): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          context.signal.removeEventListener("abort", onAbort);
          if (state.pendingSteerWaiters.get(context.effectId) === finish) {
            state.pendingSteerWaiters.delete(context.effectId);
          }
          resolve(attached ?? undefined);
        };
        const onAbort = (): void => finish(null);
        const timer = setTimeout(() => finish(null), STEER_ATTACH_WAIT_MS);
        timer.unref?.();
        context.signal.addEventListener("abort", onAbort, { once: true });
        state.pendingSteerWaiters.set(context.effectId, finish);
      });
    }
    if (!task) {
      runControl.settleSteer(context.effectId, "unconfirmed");
      return;
    }
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
    for (const waiter of state.pendingSteerWaiters.values()) waiter(null);
    state.pendingSteerWaiters.clear();
    const stopped = new Error("The orchestration effect runtime was stopped before the steer executed.");
    for (const pending of state.pendingSteers.values()) pending.reject(stopped);
    state.pendingSteers.clear();
    for (const effectId of recordedInterruptEffects) interruptOutcomes.delete(effectId);
    recordedInterruptEffects.clear();
  };
}
