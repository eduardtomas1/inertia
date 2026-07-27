import type {
  ChangedFile,
  WorkspaceGitRepositorySnapshot,
  WorkspaceGitSnapshot,
} from "@shared/contracts";

export interface WorkspaceGitFileIdentity {
  repositoryPath: string;
  filePath: string;
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

export interface WorkspaceGitRepositoryPresentation {
  prefix: string;
  suffix: string;
  location: string;
}

export function workspaceGitRepositoryPresentation(
  projectName: string,
  repositoryPath: string,
): WorkspaceGitRepositoryPresentation {
  if (repositoryPath === ".") {
    return { prefix: "", suffix: projectName, location: "project root" };
  }

  const separator = repositoryPath.lastIndexOf("/");
  const leaf = repositoryPath.slice(separator + 1);
  const location = separator >= 0 ? repositoryPath.slice(0, separator) : "nested repository";
  const qualifier = Math.max(leaf.lastIndexOf("."), leaf.lastIndexOf("-"));
  return qualifier > 0 && qualifier < leaf.length - 1
    ? { prefix: leaf.slice(0, qualifier + 1), suffix: leaf.slice(qualifier + 1), location }
    : { prefix: "", suffix: leaf, location };
}

export function firstWorkspaceGitFile(snapshot: WorkspaceGitSnapshot): WorkspaceGitFileIdentity | null {
  for (const repository of snapshot.repositories) {
    const file = repository.files[0];
    if (file) return { repositoryPath: repository.repositoryPath, filePath: file.path };
  }
  return null;
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
