import { createHash } from "node:crypto";

import type { RuntimeSupervisorSnapshot } from "./runtime-supervisor-types.js";

type RuntimeSupervisorSnapshotState = Omit<
  RuntimeSupervisorSnapshot,
  "runtimeGenerationHash"
>;

/** Keeps the public snapshot projection and generation pseudonym in one leaf. */
export function createRuntimeSupervisorSnapshot(
  state: RuntimeSupervisorSnapshotState,
  runtimeGenerationId: string | null,
): RuntimeSupervisorSnapshot {
  return {
    ...state,
    runtimeGenerationHash: runtimeGenerationId
      ? createHash("sha256")
          .update(runtimeGenerationId)
          .digest("hex")
          .slice(0, 12)
      : null,
  };
}
