import type { ProviderCapabilityContractView } from "@shared/contracts";
import {
  supportsActiveParentFollowUp,
  supportsSteerAttachments,
  supportsSteerDuringCompaction,
} from "@shared/follow-up-steer";

export type ComposerPrimaryActionState =
  | "send-disabled"
  | "send-ready"
  | "submitting"
  | "stop-ready"
  | "stop-and-send"
  | "stop-pending"
  | "resume-ready"
  | "resume-pending";

export type ComposerFollowUpState =
  | "hidden"
  | "unavailable"
  | "stop-and-send"
  | "ready"
  | "pending";

export interface ResolvedSteeringCapabilities {
  readonly canSteer: boolean;
  readonly canInterrupt: boolean;
  readonly steerAcceptsAttachments: boolean;
  readonly steerDuringCompaction: boolean;
}

export { supportsActiveParentFollowUp };

function contractCapabilityState(
  contract: ProviderCapabilityContractView | undefined,
  harnessId: string | null,
  capabilityId: string,
): "available" | "other" | null {
  if (!contract?.capabilities) return null;
  if (harnessId && contract.harnessId !== harnessId) return null;
  const match = contract.capabilities.find(({ id }) => id === capabilityId);
  if (!match) return null;
  return match.state === "available" ? "available" : "other";
}

export function resolveHarnessSteeringCapabilities(
  harnessId: string | null,
  capabilityContract?: ProviderCapabilityContractView,
  overrides?: Partial<ResolvedSteeringCapabilities>,
): ResolvedSteeringCapabilities {
  const steerContract = contractCapabilityState(capabilityContract, harnessId, "follow-up-steer");
  const interruptContract = contractCapabilityState(capabilityContract, harnessId, "cancellation");
  const attachContract = contractCapabilityState(capabilityContract, harnessId, "steer-accepts-attachments");
  const compactContract = contractCapabilityState(capabilityContract, harnessId, "steer-during-compaction");
  return {
    canSteer: overrides?.canSteer ?? (
      steerContract !== null ? steerContract === "available" : supportsActiveParentFollowUp(harnessId)
    ),
    canInterrupt: overrides?.canInterrupt ?? (
      interruptContract !== null ? interruptContract === "available" : true
    ),
    steerAcceptsAttachments: overrides?.steerAcceptsAttachments ?? (
      attachContract !== null ? attachContract === "available" : supportsSteerAttachments(harnessId)
    ),
    steerDuringCompaction: overrides?.steerDuringCompaction ?? (
      compactContract !== null ? compactContract === "available" : supportsSteerDuringCompaction(harnessId)
    ),
  };
}

export function composerFollowUpState({
  running,
  stopping,
  harnessId,
  hasDraft,
  textOnly,
  submitting,
  sending,
  capabilityContract,
  capabilities,
  hasAttachments = false,
  compacting = false,
}: {
  running: boolean;
  stopping: boolean;
  harnessId: string | null;
  hasDraft: boolean;
  textOnly: boolean;
  submitting: boolean;
  sending: boolean;
  capabilityContract?: ProviderCapabilityContractView;
  capabilities?: Partial<ResolvedSteeringCapabilities>;
  hasAttachments?: boolean;
  compacting?: boolean;
}): ComposerFollowUpState {
  if (!running || !hasDraft) return "hidden";
  if (stopping || !textOnly) return "unavailable";
  const resolved = resolveHarnessSteeringCapabilities(harnessId, capabilityContract, capabilities);
  const steerSupportedNow = resolved.canSteer
    && (!hasAttachments || resolved.steerAcceptsAttachments)
    && (!compacting || resolved.steerDuringCompaction);
  if (!steerSupportedNow) {
    return !resolved.canInterrupt || submitting || sending ? "unavailable" : "stop-and-send";
  }
  return submitting || sending ? "pending" : "ready";
}

// The provider-backed runtime normally projects `running` immediately after it
// accepts a turn. Keep the local latch long enough to bridge a loaded renderer
// while still recovering in test/offline routes that accept without a turn.
export const COMPOSER_ACTION_STALE_FALLBACK_MS = 3_000;
export const STOP_REPEAT_LATCH_MS = 1_000;

export function composerPrimaryActionState({
  sendEligible,
  submitting,
  sending,
  running,
  stopping,
  resuming = false,
  resumeEligible = false,
}: {
  sendEligible: boolean;
  submitting: boolean;
  sending: boolean;
  running: boolean;
  stopping: boolean;
  resuming?: boolean;
  resumeEligible?: boolean;
}): ComposerPrimaryActionState {
  if (running) return stopping ? "stop-pending" : "stop-ready";
  if (resuming) return "resume-pending";
  if (submitting || sending) return "submitting";
  if (sendEligible) return "send-ready";
  if (resumeEligible) return "resume-ready";
  return "send-disabled";
}
