import { CheckpointError } from "./checkpoints";
import { RecordNotFoundError } from "./database";
import { GitError } from "./git";
import { ConversationWorktreeRemovalError } from "./persistence/conversation-worktree-repository";
import { ProviderRuntimeError } from "./providers";
import { ReviewSummaryError } from "./review-summary";
import { TerminalError } from "./terminal";
import { WorkspaceError } from "./workspace";
import { BackendProfileControllerError } from "./runtime/backends/backend-profile-controller";
import { ProviderMaintenanceError } from "./provider/maintenance-controller";
import { WorkspacePathAuthorityError } from "./workspace-path-authority";

export class RuntimeRequestError extends Error {}

export function publicRuntimeError(error: unknown): string {
  if (
    error instanceof RuntimeRequestError
    || error instanceof RecordNotFoundError
    || error instanceof ConversationWorktreeRemovalError
    || error instanceof TerminalError
    || error instanceof GitError
    || error instanceof WorkspaceError
    || error instanceof CheckpointError
    || error instanceof ProviderRuntimeError
    || error instanceof ReviewSummaryError
    || error instanceof BackendProfileControllerError
    || error instanceof ProviderMaintenanceError
    || error instanceof WorkspacePathAuthorityError
  ) return error.message;
  return "The request could not be completed.";
}
