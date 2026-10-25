import type {
  BackendCompatibilityProbeResult,
  BackendProbeFailureCode,
} from "../../../shared/backend-probe";
import type { BackendDiscoveredModel } from "../../../shared/backend-profile-settings";
import { BackendProbeError } from "./backend-compatibility-probe/core";
import { BackendProfileControllerError } from "./backend-profile-types";

const MODEL_LIST_UNAVAILABLE: ReadonlySet<BackendProbeFailureCode> = new Set([
  "missing-model",
  "unsupported-protocol",
  "malformed-response",
]);

export const BACKEND_KEY_CHECK_NEEDS_MODEL_MESSAGE =
  "This backend does not offer a model list. Add a model ID, then check the key again.";
export const BACKEND_KEY_CHECK_INCOMPLETE_MESSAGE =
  "Inertia could not finish checking the key. Try again.";

export type BackendKeyCheckEvidence = "model-list" | "primary-model";

export interface BackendKeyCheckSteps {
  listModels: () => Promise<readonly BackendDiscoveredModel[]>;
  primaryModelId: string | undefined;
  probeModel: (modelId: string) => Promise<BackendCompatibilityProbeResult | null>;
  now: () => Date;
}

export async function verifyBackendKey(
  steps: BackendKeyCheckSteps,
): Promise<BackendKeyCheckEvidence> {
  try {
    if ((await steps.listModels()).length > 0) return "model-list";
  } catch (error) {
    if (!(error instanceof BackendProbeError)) throw error;
    if (!MODEL_LIST_UNAVAILABLE.has(error.code)) {
      throw new BackendProfileControllerError(error.message);
    }
  }
  if (!steps.primaryModelId) {
    throw new BackendProfileControllerError(BACKEND_KEY_CHECK_NEEDS_MODEL_MESSAGE);
  }
  const startedAt = steps.now().getTime();
  const probe = await steps.probeModel(steps.primaryModelId);
  if (!probe || Date.parse(probe.checkedAt) < startedAt) {
    throw new BackendProfileControllerError(BACKEND_KEY_CHECK_INCOMPLETE_MESSAGE);
  }
  if (probe.failure) throw new BackendProfileControllerError(probe.failure.message);
  return "primary-model";
}
