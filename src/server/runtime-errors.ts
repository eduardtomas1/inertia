import { CheckpointError } from "./checkpoints";
import { RecordNotFoundError } from "./database";
import { GitError } from "./git";
import { ProviderRuntimeError } from "./providers";
import { TerminalError } from "./terminal";
import { WorkspaceError } from "./workspace";

export class RuntimeRequestError extends Error {}

export function publicRuntimeError(error: unknown): string {
  if (
    error instanceof RuntimeRequestError
    || error instanceof RecordNotFoundError
    || error instanceof TerminalError
    || error instanceof GitError
    || error instanceof WorkspaceError
    || error instanceof CheckpointError
    || error instanceof ProviderRuntimeError
  ) return error.message;
  return "The request could not be completed.";
}
