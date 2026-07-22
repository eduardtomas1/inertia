import type {
  AgentActivity,
  ChangedFile,
  GitStatusSnapshot,
  ProviderInfo,
} from "../shared/contracts";
import type { GitRepositoryStatus } from "./git";
import {
  PROVIDERS,
  type ProviderActivityEvent,
  type ProviderDetection,
} from "./providers";

function emptyMetadataState(): ProviderInfo["metadataState"] {
  const missing = () => ({ freshness: "unavailable" as const, provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false });
  return { models: missing(), rateLimits: missing() };
}

export function initialProviderSnapshots(
  executionEnabled = true,
  cached: Partial<Record<ProviderInfo["id"], Pick<ProviderInfo, "models" | "rateLimits" | "metadataState">>> = {},
): ProviderInfo[] {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.name,
    command: provider.command,
    available: false,
    version: null,
    installState: "checking",
    authState: "checking",
    canRun: !executionEnabled,
    statusMessage: "Checking installation and connection",
    models: cached[provider.id]?.models ?? [],
    rateLimits: cached[provider.id]?.rateLimits ?? [],
    metadataState: cached[provider.id]?.metadataState ?? emptyMetadataState(),
  }));
}

export function providerSnapshot(
  detection: ProviderDetection,
  metadata: Pick<ProviderInfo, "models" | "rateLimits" | "metadataState"> = { models: [], rateLimits: [], metadataState: emptyMetadataState() },
): ProviderInfo {
  return {
    id: detection.provider.id,
    label: detection.provider.name,
    command: detection.provider.command,
    available: detection.available,
    version: detection.version ?? null,
    installState: detection.installState,
    authState: detection.authState,
    canRun: detection.canRun,
    statusMessage: detection.statusMessage ?? null,
    models: metadata.models,
    rateLimits: metadata.rateLimits,
    metadataState: metadata.metadataState,
  };
}

export function changedFiles(status: GitRepositoryStatus): ChangedFile[] {
  return status.files.map((file) => ({
    path: file.path,
    status: file.status,
    insertions: file.insertions,
    deletions: file.deletions,
    untracked: file.status === "untracked",
  }));
}

export function gitStatusSnapshot(status: GitRepositoryStatus): GitStatusSnapshot {
  return {
    isRepository: true,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    hasRemote: status.upstream !== null,
    files: changedFiles(status),
    insertions: status.insertions,
    deletions: status.deletions,
  };
}

export function emptyGitStatusSnapshot(): GitStatusSnapshot {
  return { isRepository: false, branch: null, upstream: null, ahead: 0, behind: 0, hasRemote: false, files: [], insertions: 0, deletions: 0 };
}

export function agentActivityKind(event: ProviderActivityEvent): AgentActivity["kind"] {
  if (event.kind === "command") return "command";
  if (event.kind === "reasoning") return "reasoning";
  if (event.kind === "tool") return "tool";
  return "status";
}

export function agentActivityStatus(event: ProviderActivityEvent): AgentActivity["status"] {
  if (event.phase === "failed") return "failed";
  if (event.phase === "completed" || event.phase === "info") return "completed";
  return "running";
}
