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
import { PromptPresetRepositoryError } from "./persistence/prompt-preset-repository";
import {
  ATTACHMENT_RESOLUTION_PUBLIC_ERROR,
  AttachmentResolutionError,
} from "./runtime/attachments/attachment-errors";

export class RuntimeRequestError extends Error {}

export function publicRuntimeError(error: unknown): string {
  if (error instanceof AttachmentResolutionError) {
    return ATTACHMENT_RESOLUTION_PUBLIC_ERROR;
  }
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
    || error instanceof PromptPresetRepositoryError
  ) return error.message;
  return "The request could not be completed.";
}
