import { statSync } from "node:fs";

import {
  activateRuntimeOwnedProcessRegistry,
  RuntimeOwnedProcessJournal,
} from "../../src/node/runtime-owned-processes";

export function activatePreparedRuntimeOwnedProcessRegistry(
  ...args: Parameters<typeof activateRuntimeOwnedProcessRegistry>
): ReturnType<typeof activateRuntimeOwnedProcessRegistry> {
  const [dataDirectory, runtimeGenerationId, systemBootId, options] = args;
  const journal = new RuntimeOwnedProcessJournal(dataDirectory, {
    ...(options?.platform ? { platform: options.platform } : {}),
    ...(options?.darwinGuardianPath
      ? { darwinGuardianPath: options.darwinGuardianPath }
      : {}),
    ...(options?.readDarwinIdentity
      ? { readDarwinIdentity: options.readDarwinIdentity }
      : {}),
    ...(options?.readDarwinGuardianReady
      ? { readDarwinGuardianReady: options.readDarwinGuardianReady }
      : {}),
  });
  if (!journal.startSession(runtimeGenerationId, systemBootId)) {
    throw new Error("The test runtime process ownership session could not be prepared.");
  }
  if ((options?.platform ?? process.platform) === "linux"
    && options?.darwinGuardianPath) {
    const executable = statSync(options.darwinGuardianPath, { bigint: true });
    return activateRuntimeOwnedProcessRegistry(
      dataDirectory,
      runtimeGenerationId,
      systemBootId,
      {
        ...options,
        linuxGuardianExecutable: options.linuxGuardianExecutable ?? {
          guardianExecutableDevice: String(executable.dev),
          guardianExecutableInode: String(executable.ino),
        },
      },
    );
  }
  return activateRuntimeOwnedProcessRegistry(...args);
}
