import type { AgentHarnessRun } from "./agent-harness";
import type { ProviderCapabilityId } from "./capability-manifest";
import { ProviderRuntimeError } from "./contracts";
import { forceTerminationBudgetMs } from "../process-lifecycle";

export type OwnedProviderStopResult =
  | "missing"
  | "identity-mismatch"
  | "settled"
  | "force-detached";

export interface StoppableActiveRun {
  lifecycleSettlement: Promise<void>;
  harnessRun: AgentHarnessRun | null;
  harnessStartInvoked: boolean;
  startFailed: boolean;
  processCleanupConfirmed: boolean;
  settled: boolean;
  detach: () => boolean;
  detachUnconfirmed: () => void;
  escalateStop: (() => void) | null;
  hardKillTimer?: NodeJS.Timeout;
}

const MAX_OWNED_STOP_GRACE_MS = 30_000;

export function isPreSpawnHarnessRefusal(
  error: unknown,
): error is ProviderRuntimeError {
  return error instanceof ProviderRuntimeError && error.code === "invalid_input";
}

export async function runStopLadder(options: {
  active: StoppableActiveRun;
  graceMs: number;
  forceStopBudgetMs?: number;
  cancel: () => void;
  settledResult: () => OwnedProviderStopResult;
  hooks?: { escalated?(): void };
}): Promise<OwnedProviderStopResult> {
  const { active, graceMs, forceStopBudgetMs, cancel, settledResult, hooks } = options;
  const escalated = new Promise<void>((resolve) => {
    active.escalateStop = resolve;
  });
  cancel();
  if (!active.harnessStartInvoked) {
    active.processCleanupConfirmed = true;
    if (!active.detach()) active.detachUnconfirmed();
    return settledResult();
  }
  if (active.startFailed && !active.harnessRun) {
    active.detachUnconfirmed();
    return "force-detached";
  }
  if (await waitForRunSettlement(active, graceMs, escalated)) {
    return settledResult();
  }
  if (active.hardKillTimer) {
    clearTimeout(active.hardKillTimer);
    active.hardKillTimer = undefined;
  }
  hooks?.escalated?.();
  forceCancelHarness(active);
  const forceBudgetMs = forceStopBudgetMs
    ?? forceTerminationBudgetMs(process.platform);
  if (await waitForRunSettlement(active, forceBudgetMs)) {
    return settledResult();
  }
  active.detachUnconfirmed();
  return "force-detached";
}

export async function waitForRunSettlement(
  active: Pick<StoppableActiveRun, "settled" | "lifecycleSettlement">,
  graceMs: number,
  escalated?: Promise<void>,
): Promise<boolean> {
  if (active.settled) return true;
  const boundedGraceMs = Math.max(0, Math.min(graceMs, MAX_OWNED_STOP_GRACE_MS));
  if (boundedGraceMs === 0) return active.settled;
  let timer: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    active.lifecycleSettlement.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), boundedGraceMs);
      timer.unref();
    }),
    ...(escalated ? [escalated.then(() => active.settled)] : []),
  ]);
  if (timer) clearTimeout(timer);
  return settled;
}

export function forceCancelHarness(
  active: Pick<StoppableActiveRun, "harnessRun">,
): void {
  try {
    active.harnessRun?.cancel(true);
  } catch {
    return;
  }
}

export function providerAdmissionRefusal(
  name: string,
  installation: "current" | "changed" | "unverified",
  capabilityId: ProviderCapabilityId,
): string {
  const next = "Open Settings > Agents and choose Refresh all providers, or restart Inertia.";
  if (installation === "changed") {
    return `${name} changed since Inertia last checked it, for example after an update, and Inertia could not verify the new installation. ${next}`;
  }
  if (installation === "unverified") {
    return `Inertia has not verified this ${name} installation yet. ${next}`;
  }
  return `The exact provider installation does not attest '${capabilityId}'.`;
}
