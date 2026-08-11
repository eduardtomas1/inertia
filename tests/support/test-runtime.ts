import { RuntimeGenerationLeaseJournal } from "../../src/node/runtime-generation-leases";
import {
  startRuntime,
  type RunningRuntime,
  type RuntimeOptions,
} from "../../src/server";

/** Mirrors the main supervisor's required pre-fork generation lease in tests. */
export async function startTestRuntime(options: RuntimeOptions): Promise<RunningRuntime> {
  const leases = new RuntimeGenerationLeaseJournal(options.dataDirectory);
  if (!leases.publish(options.runtimeGenerationId, options.systemBootId)) {
    throw new Error("The test runtime generation lease could not be published.");
  }
  return await startRuntime(options);
}
