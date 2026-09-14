import { relative, resolve, sep } from "node:path";

import type { RuntimeSecureFileBroker, SecureFileRootCapability } from "../secure-files";
import { isContained, validatedPaths } from "./paths";
import { GitError } from "./types";

/** Retained project/conversation authority, separate from the containing Git root. */
export interface ReversalWorkspaceScope {
  root: SecureFileRootCapability;
  verifyContext(): Promise<void>;
}

export async function reversalFileLocation(
  secureFiles: RuntimeSecureFileBroker,
  repository: SecureFileRootCapability,
  path: string,
  workspace?: ReversalWorkspaceScope,
): Promise<{ root: SecureFileRootCapability; path: string }> {
  if (!workspace) return { root: repository, path };
  await workspace.verifyContext();
  await secureFiles.verifyRoot(workspace.root);
  await secureFiles.verifyRoot(repository);
  const target = resolve(repository.root, path);
  if (!isContained(repository.root, target) || !isContained(workspace.root.root, target)) {
    throw new GitError("invalid-input", "Selective reversal is available only for files inside the project folder.");
  }
  const [workspacePath] = await validatedPaths(workspace.root.root, [
    relative(workspace.root.root, target).split(sep).join("/"),
  ]);
  return { root: workspace.root, path: workspacePath! };
}
