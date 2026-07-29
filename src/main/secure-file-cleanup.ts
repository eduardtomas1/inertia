import { constants as fsConstants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";

import type { SecureFileIdentity } from "../node/secure-file-protocol.js";
import {
  errorCode,
  identity,
  sameIdentity,
  SecureFileOperationError,
} from "./secure-file-io.js";

interface SecureFileCleanupHooks {
  beforeQuarantine?(name: string): Promise<void> | void;
  afterQuarantine?(
    name: string,
    quarantineName: string,
  ): Promise<void> | void;
}

export async function syncCurrentDirectory(): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(".", fsConstants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function removeExact(
  name: string,
  expectedIdentity: SecureFileIdentity,
  hooks?: SecureFileCleanupHooks,
  quarantineName = `${name}.quarantine`,
): Promise<void> {
  const quarantined = await quarantineExact(
    name,
    expectedIdentity,
    hooks,
    quarantineName,
  );
  if (!quarantined) return;
  await unlink(quarantineName);
}

export async function quarantineExact(
  name: string,
  expectedIdentity: SecureFileIdentity,
  hooks?: SecureFileCleanupHooks,
  quarantineName = `${name}.quarantine`,
): Promise<boolean> {
  await hooks?.beforeQuarantine?.(name);
  try {
    await rename(name, quarantineName);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
  await hooks?.afterQuarantine?.(name, quarantineName);
  const quarantinedInfo = await lstat(quarantineName, { bigint: true })
    .catch((error) => {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    });
  if (
    !quarantinedInfo
    || !sameIdentity(identity(quarantinedInfo), expectedIdentity)
  ) {
    if (quarantinedInfo) {
      try {
        await rename(quarantineName, name);
        await syncCurrentDirectory();
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    throw new SecureFileOperationError(
      "unsafe",
      "A secure save transaction file was replaced unexpectedly.",
    );
  }
  return true;
}
