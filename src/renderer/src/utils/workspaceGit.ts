import type {
  ChangedFile,
  GitStatusSnapshot,
  Project,
  WorkspaceGitRepositorySnapshot,
  WorkspaceGitSnapshot,
} from "@shared/contracts";

export interface RootGitMutationScope {
  repositoryPath: ".";
  authorityRef: string;
}

export function rootGitMutationScope(
  status: GitStatusSnapshot | null,
): RootGitMutationScope | null {
  return status?.isRepository && status.authorityRef
    ? { repositoryPath: ".", authorityRef: status.authorityRef }
    : null;
}

export function workspaceGitRefreshIdentity(project: Project | null): string {
  return project ? `${project.id}:${project.gitRepositoryLimit}` : "";
}

export interface WorkspaceGitFileIdentity {
  repositoryPath: string;
  filePath: string;
}

export type WorkspaceChangesRequestedAction = "review" | "commit" | "push";

export interface WorkspaceChangesRequest {
  repositoryPath: string;
  action: WorkspaceChangesRequestedAction;
  revision: number;
}

export function workspaceGitIdentity(identity: WorkspaceGitFileIdentity): string {
  return `${identity.repositoryPath.length}:${identity.repositoryPath}${identity.filePath}`;
}

export function parseWorkspaceGitIdentity(
  value: string,
  snapshot: WorkspaceGitSnapshot,
): WorkspaceGitFileIdentity | null {
  const separator = value.indexOf(":");
  const repositoryLength = Number(value.slice(0, separator));
  if (separator < 1 || !Number.isSafeInteger(repositoryLength) || repositoryLength < 1) return null;
  const repositoryPath = value.slice(separator + 1, separator + 1 + repositoryLength);
  const filePath = value.slice(separator + 1 + repositoryLength);
  const repository = snapshot.repositories.find((candidate) => candidate.repositoryPath === repositoryPath);
  return repository?.files.some((file) => file.path === filePath)
    ? { repositoryPath, filePath }
    : null;
}

export function workspaceGitFilePath(identity: WorkspaceGitFileIdentity): string {
  return identity.repositoryPath === "."
    ? identity.filePath
    : `${identity.repositoryPath}/${identity.filePath}`;
}

export function workspaceGitRepositoryLabel(projectName: string, repositoryPath: string): string {
  return repositoryPath === "." ? projectName : repositoryPath;
}

export function workspaceGitFile(
  snapshot: WorkspaceGitSnapshot,
  identity: WorkspaceGitFileIdentity | null,
): { repository: WorkspaceGitRepositorySnapshot; file: ChangedFile } | null {
  if (!identity) return null;
  const repository = snapshot.repositories.find(
    (candidate) => candidate.repositoryPath === identity.repositoryPath,
  );
  const file = repository?.files.find((candidate) => candidate.path === identity.filePath);
  return repository && file ? { repository, file } : null;
}
