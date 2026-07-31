import type { OpenProjectPathRequest } from "../shared/desktop";
import type { Conversation, Project } from "../shared/contracts";
import { RuntimeRequestError } from "./runtime-errors";
import { resolveWorkspacePathForOpen, type ResolvedWorkspacePath } from "./workspace";

export interface ProjectPathStore {
  project: (projectId: string) => Project;
  conversation: (conversationId: string) => Conversation;
  projectPath: (projectId: string) => string;
  conversationPath: (conversationId: string) => string;
}

export interface ProjectIdentityAuthority {
  revalidate(projectId: string, projectPath: string): Promise<boolean>;
}

export async function assertProjectIdentityAuthority(
  authority: ProjectIdentityAuthority | undefined,
  projectId: string,
  projectPath: string,
): Promise<void> {
  if (!authority) return;
  if (await authority.revalidate(projectId, projectPath)) return;
  throw new RuntimeRequestError(
    "This project folder is unavailable, so Inertia cannot verify its identity.",
  );
}

export async function resolveAuthoritativeProjectPath(
  store: ProjectPathStore,
  request: OpenProjectPathRequest,
  authority?: ProjectIdentityAuthority,
): Promise<ResolvedWorkspacePath> {
  const project = store.project(request.projectId);
  let root = store.projectPath(project.id);
  await assertProjectIdentityAuthority(authority, project.id, root);
  if (request.conversationId) {
    const conversation = store.conversation(request.conversationId);
    if (conversation.projectId !== project.id) {
      throw new RuntimeRequestError("The thread does not belong to this project.");
    }
    root = store.conversationPath(conversation.id);
  }
  return resolveWorkspacePathForOpen(root, request.relativePath);
}
