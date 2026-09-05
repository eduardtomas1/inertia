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
import { productionProviderCapabilityManifests } from "./provider/capability-manifest";

function declaredCapabilityContract(
  providerId: ProviderInfo["id"],
): ProviderInfo["capabilityContract"] {
  const manifest = productionProviderCapabilityManifests().find(
    (candidate) => candidate.providerId === providerId,
  );
  return manifest
    ? {
        schemaVersion: 1,
        harnessId: manifest.harnessId,
        manifestDigest: manifest.digest,
        installationVerified: false,
        installedVersion: null,
        currentlyAvailableCount: 0,
        declaredCapabilityCount: manifest.capabilities.length,
        hostToolBridgeAvailable: false,
      }
    : undefined;
}

function emptyMetadataState(): ProviderInfo["metadataState"] {
  const missing = () => ({ freshness: "unavailable" as const, provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false });
  return { models: missing(), rateLimits: missing() };
}

function agentThreadManagement(
  providerId: ProviderInfo["id"],
  capabilityContract: ProviderInfo["capabilityContract"],
): NonNullable<ProviderInfo["agentThreadManagement"]> {
  const transport = {
    codex: "Codex dynamic tools",
    claude: "Claude's in-process tool server",
    cursor: "Cursor's scoped MCP session",
    gemini: "Gemini's scoped MCP session",
    kimi: "Kimi Code's scoped MCP session",
    opencode: "OpenCode's scoped MCP session",
  }[providerId];
  return capabilityContract?.installationVerified
    && capabilityContract.hostToolBridgeAvailable
    ? {
        state: "supported",
        detail: `${transport} can use approved Inertia tools to create and manage top-level chats in this project.`,
      }
    : {
        state: "unavailable",
        detail: "Top-level chat tools stay unavailable until this exact provider installation and its host-tool bridge are verified.",
      };
}

export function initialProviderSnapshots(
  executionEnabled = true,
  cached: Partial<Record<ProviderInfo["id"], Pick<ProviderInfo, "models" | "rateLimits" | "metadataState">>> = {},
): ProviderInfo[] {
  return PROVIDERS.map((provider) => {
    const capabilityContract = declaredCapabilityContract(provider.id);
    return {
      id: provider.id,
      label: provider.name,
      command: provider.command,
      available: false,
      version: null,
      executable: null,
      installState: "checking" as const,
      authState: "checking" as const,
      canRun: !executionEnabled,
      statusMessage: "Checking installation and connection",
      models: cached[provider.id]?.models ?? [],
      rateLimits: cached[provider.id]?.rateLimits ?? [],
      metadataState: cached[provider.id]?.metadataState ?? emptyMetadataState(),
      capabilityContract,
      agentThreadManagement: agentThreadManagement(
        provider.id,
        capabilityContract,
      ),
    };
  });
}

export function providerSnapshot(
  detection: ProviderDetection,
  metadata: Pick<ProviderInfo, "models" | "rateLimits" | "metadataState"> = { models: [], rateLimits: [], metadataState: emptyMetadataState() },
  capabilityContract: ProviderInfo["capabilityContract"] = declaredCapabilityContract(
    detection.provider.id,
  ),
): ProviderInfo {
  return {
    id: detection.provider.id,
    label: detection.provider.name,
    command: detection.provider.command,
    available: detection.available,
    version: detection.version ?? null,
    executable: detection.executable ?? null,
    installState: detection.installState,
    authState: detection.authState,
    canRun: detection.canRun,
    statusMessage: detection.statusMessage ?? null,
    models: metadata.models,
    rateLimits: metadata.rateLimits,
    metadataState: metadata.metadataState,
    capabilityContract,
    agentThreadManagement: agentThreadManagement(
      detection.provider.id,
      capabilityContract,
    ),
  };
}

export function changedFiles(status: GitRepositoryStatus): ChangedFile[] {
  return status.files.map((file) => ({
    path: file.path,
    status: file.status,
    insertions: file.insertions,
    deletions: file.deletions,
    untracked: file.status === "untracked",
    staged: file.staged,
    unstaged: file.unstaged,
    indexStatus: file.indexStatus,
    worktreeStatus: file.worktreeStatus,
  }));
}

export function gitStatusSnapshot(
  status: GitRepositoryStatus,
  authorityRef?: string,
): GitStatusSnapshot {
  return {
    isRepository: true,
    authorityRef: authorityRef ?? null,
    root: status.root,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    hasRemote: status.hasRemote,
    pullRequest: status.pullRequest,
    files: changedFiles(status),
    insertions: status.insertions,
    deletions: status.deletions,
  };
}

export function emptyGitStatusSnapshot(): GitStatusSnapshot {
  return {
    isRepository: false,
    authorityRef: null,
    root: null,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    hasRemote: false,
    pullRequest: {
      available: false,
      remoteName: null,
      forge: null,
      unavailableReason: "no-remotes",
    },
    files: [],
    insertions: 0,
    deletions: 0,
  };
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
