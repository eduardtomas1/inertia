import type { GitScanRequest, GitScanScope } from "../../git/scan-contracts";
import {
  getRepositoryStatus,
  getUnifiedDiff,
  type GitRepositoryStatus,
  type GitUnifiedDiff,
} from "../../git";
import {
  gitScanCoordinator,
  validatedGitScanIdentity,
} from "../../git/scan-coordinator";
import type {
  RuntimeSecureFileBroker,
  SecureFileRootCapability,
} from "../../secure-files";
import { settleSourceControlInspections } from "./source-control-deadline";

export function sourceControlScanAuthorityGeneration(
  projectId: string,
  conversationId: string | undefined,
  workspaceRoot: string,
): string {
  return JSON.stringify([projectId, conversationId ?? "", workspaceRoot]);
}

export function sourceControlStatusScan(
  projectId: string,
  conversationId: string | undefined,
  workspaceRoot: string,
  repositoryRoot: string,
  metadataMarkerIdentity: string,
  scope: GitScanScope,
): Omit<GitScanRequest, "deadlineAt" | "optionsKey" | "signal"> {
  const identity = validatedGitScanIdentity(
    repositoryRoot,
    metadataMarkerIdentity,
  );
  return {
    authorityGeneration: sourceControlScanAuthorityGeneration(
      projectId,
      conversationId,
      workspaceRoot,
    ),
    identity,
    invalidation: gitScanCoordinator.currentInvalidation(identity),
    scope,
  };
}

export function sourceControlMutationInvalidation(
  repositoryRoot: string,
  metadataMarkerIdentity: string | null,
): {
  onMutationSettled?: () => void;
  onMutationStarting?: () => void;
} {
  if (!metadataMarkerIdentity) return {};
  const identity = validatedGitScanIdentity(
    repositoryRoot,
    metadataMarkerIdentity,
  );
  return {
    onMutationSettled: () => {
      gitScanCoordinator.invalidate(identity);
    },
    onMutationStarting: () => {
      gitScanCoordinator.invalidate(identity);
    },
  };
}

export async function readSourceControlStatus(input: {
  conversationId?: string;
  deadlineAt: number;
  metadataMarkerIdentity: string;
  projectId: string;
  repositoryRoot: string;
  workspaceRoot: string;
}): Promise<GitRepositoryStatus> {
  return await getRepositoryStatus(input.repositoryRoot, {
    deadlineAt: input.deadlineAt,
    scan: sourceControlStatusScan(
      input.projectId,
      input.conversationId,
      input.workspaceRoot,
      input.repositoryRoot,
      input.metadataMarkerIdentity,
      "status",
    ),
  });
}

export async function readSourceControlDiffAndStatus(input: {
  conversationId?: string;
  deadlineAt: number;
  filePath?: string;
  ignoreWhitespace?: boolean;
  metadataMarkerIdentity: string;
  projectId: string;
  recordTriggeringFailure: (reason: unknown) => void;
  repositoryRoot: string;
  secureFiles: RuntimeSecureFileBroker;
  secureRoot: SecureFileRootCapability;
  signal: AbortSignal;
  workspaceRoot: string;
}): Promise<[GitUnifiedDiff, GitRepositoryStatus]> {
  const statusScan = sourceControlStatusScan(
    input.projectId,
    input.conversationId,
    input.workspaceRoot,
    input.repositoryRoot,
    input.metadataMarkerIdentity,
    "workspace",
  );
  return await settleSourceControlInspections(
    input.signal,
    async (signal) => await getUnifiedDiff(
      input.repositoryRoot,
      {
        deadlineAt: input.deadlineAt,
        signal,
        ...(input.filePath ? { paths: [input.filePath] } : {}),
        ignoreWhitespace: input.ignoreWhitespace,
        statusScan,
      },
      undefined,
      input.secureFiles,
      input.secureRoot,
    ),
    (signal) => getRepositoryStatus(input.repositoryRoot, {
      deadlineAt: input.deadlineAt,
      scan: statusScan,
      signal,
    }),
    input.recordTriggeringFailure,
  );
}
