import { captureWindowsRuntimeCleanupFailure } from "./windows-runtime-cleanup-diagnostic";
import type { RunningRuntime } from "../../src/server";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

interface RuntimeTestResources {
  runtimes: Array<Pick<RunningRuntime, "close">>;
  directories: string[];
}

export class RuntimeTestCleanup implements RuntimeTestResources {
  readonly runtimes: RuntimeTestResources["runtimes"] = [];
  readonly directories: string[] = [];
  readonly quarantined: Array<RuntimeTestResources & { error: unknown }> = [];

  async close(): Promise<void> {
    const resources = {
      runtimes: this.runtimes.splice(0),
      directories: this.directories.splice(0),
    };
    let runtimesClosed = false;
    try {
      const results = await Promise.allSettled(
        resources.runtimes.map(async (runtime) => { await runtime.close(); }),
      );
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
      runtimesClosed = true;
      for (const directory of resources.directories) {
        await removeTemporaryDirectory(directory);
      }
    } catch (error) {
      captureWindowsRuntimeCleanupFailure(resources.directories, error, runtimesClosed);
      // Keep the failed test's owners and paths together. Later tests must not
      // signal those owners or remove their files after an unconfirmed close.
      this.quarantined.push({ ...resources, error });
      throw error;
    }
  }
}
