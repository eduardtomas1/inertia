import { lstat, mkdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { join } from "node:path";
import { runGit } from "./git/runner";
import { RuntimeRequestError } from "./runtime-errors";
import {
  validProjectCloneUrl,
  validProjectDirectoryName,
} from "../shared/project-import";

/** An exclusive destination reservation never writes into an existing checkout. */
export async function cloneProject(
  parentPath: string,
  source: { url: string; directoryName: string },
  signal?: AbortSignal,
): Promise<string> {
  if (
    !validProjectCloneUrl(source.url) ||
    !validProjectDirectoryName(source.directoryName)
  ) {
    throw new RuntimeRequestError(
      "Enter a valid repository URL and a new folder name.",
    );
  }
  const parent = await realpath(parentPath);
  const parentIdentity = await lstat(parent);
  const destination = join(parent, source.directoryName);
  try {
    await mkdir(destination);
  } catch {
    throw new RuntimeRequestError(
      "Choose a new folder name in a writable destination. Existing folders are never overwritten.",
    );
  }
  const identity = await lstat(destination);
  const assertDestination = async (): Promise<void> => {
    const currentParent = await lstat(parent);
    const current = await lstat(destination);
    if (
      currentParent.dev !== parentIdentity.dev ||
      currentParent.ino !== parentIdentity.ino ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.isSymbolicLink() ||
      (await realpath(destination)) !== destination
    ) {
      throw new RuntimeRequestError(
        "The clone destination changed. Add the repository again from its current location.",
      );
    }
  };
  await assertDestination();
  await runGit(
    parent,
    [
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always",
      "-c",
      "protocol.ssh.allow=always",
      "-c",
      `core.hooksPath=${devNull}`,
      "-c",
      "core.fsmonitor=false",
      "clone",
      "--no-recurse-submodules",
      "--template=",
      "--",
      source.url,
      destination,
    ],
    {
      timeoutMs: 120_000,
      maxOutputBytes: 256 * 1024,
      signal,
      failureMessage:
        "The repository could not be cloned. Check the URL, Git authentication, and destination. A partial folder may remain; choose a new folder to retry.",
    },
  );
  await assertDestination();
  return destination;
}
