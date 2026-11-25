import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import type { OpenProjectPathRequest } from "../shared/desktop";
import type { AppSettings, Conversation, Project } from "../shared/contracts";
import { RuntimeRequestError } from "./runtime-errors";
import { resolveWorkspacePathForOpen, type ResolvedWorkspacePath } from "./workspace";

export interface ProjectPathStore {
  project: (projectId: string) => Project;
  conversation: (conversationId: string) => Conversation;
  projectPath: (projectId: string) => string;
  conversationPath: (conversationId: string) => string;
}

export interface AuthorizedEditorPathStore extends ProjectPathStore {
  projects: () => readonly Project[];
  projectConversations: (projectId: string) => readonly Pick<Conversation, "id" | "projectId" | "worktreePath">[];
}

export interface EditorContextStore extends AuthorizedEditorPathStore {
  settings: () => Pick<AppSettings, "preferredEditor">;
}

export async function resolveEditorContext(
  store: EditorContextStore,
  filePath: string | undefined,
  authority: ProjectIdentityAuthority | undefined,
  locked: boolean,
  conversationId?: string,
): Promise<{ preferredEditor: AppSettings["preferredEditor"]; authorizedPath?: string; projectRoot?: string }> {
  const preferredEditor = store.settings().preferredEditor;
  if (!filePath || locked) return { preferredEditor };
  const authorized = await resolveAuthorizedEditorFile(store, filePath, authority, conversationId);
  return authorized
    ? { preferredEditor, authorizedPath: authorized.absolute, projectRoot: authorized.projectRoot }
    : { preferredEditor };
}

export interface AuthorizedEditorFile {
  absolute: string;
  projectRoot: string;
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
  if (project.workspaceKind === "scratch" && !request.conversationId) {
    throw new RuntimeRequestError("Choose a chat to open its own folder.");
  }
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

export async function resolveAuthorizedEditorFile(
  store: AuthorizedEditorPathStore,
  filePath: string,
  authority?: ProjectIdentityAuthority,
  conversationId?: string,
): Promise<AuthorizedEditorFile | null> {
  if (!filePath || !isAbsolute(filePath)) return null;
  let linkCheck;
  try {
    linkCheck = await lstat(filePath);
  } catch {
    return null;
  }
  if (linkCheck.isSymbolicLink()) return null;
  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(filePath);
  } catch {
    return null;
  }
  const candidates: Array<{ projectId: string; projectRoot: string; root: string }> = [];
  if (conversationId) {
    try {
      const conversation = store.conversation(conversationId);
      const project = store.project(conversation.projectId);
      if (project.workspaceKind === "scratch") return null;
      const projectRoot = store.projectPath(project.id);
      const root = store.conversationPath(conversation.id);
      candidates.push({ projectId: project.id, projectRoot, root });
    } catch {
      return null;
    }
  } else {
    const projects = store.projects();
    for (const project of projects) {
      if (project.workspaceKind === "scratch") continue;
      try {
        const root = store.projectPath(project.id);
        candidates.push({ projectId: project.id, projectRoot: root, root });
      } catch {
        continue;
      }
    }
    for (const conversation of projects.flatMap((project) => store.projectConversations(project.id))) {
      if (!conversation.worktreePath) continue;
      try {
        const projectRoot = store.projectPath(conversation.projectId);
        const root = store.conversationPath(conversation.id);
        candidates.push({ projectId: conversation.projectId, projectRoot, root });
      } catch {
        continue;
      }
    }
  }
  candidates.sort((left, right) => right.root.length - left.root.length);
  for (const candidate of candidates) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(candidate.root);
    } catch {
      continue;
    }
    const rel = relative(canonicalRoot, canonicalTarget);
    if (rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) {
      continue;
    }
    try {
      await assertProjectIdentityAuthority(authority, candidate.projectId, candidate.projectRoot);
      const resolved = await resolveWorkspacePathForOpen(
        canonicalRoot,
        rel ? (process.platform === "win32" ? rel.replaceAll("\\", "/") : rel) : ".",
      );
      return { absolute: resolved.absolute, projectRoot: canonicalRoot };
    } catch {
      continue;
    }
  }
  return null;
}
