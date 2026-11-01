export type ScheduledPlanKind = "limit-reset" | "restart-continuation";

export interface ScheduledPlanSettlement {
  kind: ScheduledPlanKind;
  conversationId: string;
  planId: string;
  turnId: string;
  state: "blocked" | "cancelled" | "missed";
}

type SettlementListener = (settlement: ScheduledPlanSettlement) => void;
type LimitResetCancel = (conversationId: string, planId: string) => void;

interface ScheduledPlanRegistry {
  listeners: Set<SettlementListener>;
  cancelLimitReset: LimitResetCancel | null;
}

const registries = new WeakMap<object, ScheduledPlanRegistry>();

function registry(owner: object): ScheduledPlanRegistry {
  let current = registries.get(owner);
  if (!current) {
    current = { listeners: new Set(), cancelLimitReset: null };
    registries.set(owner, current);
  }
  return current;
}

export function onScheduledPlanSettled(owner: object, listener: SettlementListener): () => void {
  const { listeners } = registry(owner);
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function scheduledPlanSettled(owner: object, settlement: ScheduledPlanSettlement): void {
  for (const listener of registry(owner).listeners) {
    try {
      listener(settlement);
    } catch {
      continue;
    }
  }
}

export function provideLimitResetCancel(owner: object, cancel: LimitResetCancel): void {
  registry(owner).cancelLimitReset = cancel;
}

export function limitResetCancel(owner: object): LimitResetCancel | null {
  return registry(owner).cancelLimitReset;
}
