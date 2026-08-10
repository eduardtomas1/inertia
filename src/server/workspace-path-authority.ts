import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type Database from "better-sqlite3";

import { normalizeIdentityPath } from "./project-identity";
import {
  isWorktreeFilesystemIdentity,
  worktreeFilesystemIdentitiesEqual,
  type WorktreeFilesystemIdentity,
} from "./worktree-filesystem-identity";
import type { ConversationRow, ProjectRow } from "./persistence/rows";

const MAX_AUTHORITY_RECEIPT_BYTES = 20 * 1024;
const MAX_GIT_POINTER_BYTES = 4_096;
const GIT_IDENTITY_PREFIX = "git:";

interface RepositoryDirectoryReceipt {
  checkoutRoot: string;
  checkoutRootIdentity: WorktreeFilesystemIdentity;
  commonDirectory: string;
  commonDirectoryIdentity: WorktreeFilesystemIdentity;
}

export interface WorkspacePathReceipt {
  version: 1;
  canonicalPath: string;
  directoryIdentity: WorktreeFilesystemIdentity;
  repository: RepositoryDirectoryReceipt | null;
}

interface WorkspacePathAuthorityRow {
  path: string;
  receipt_json: string;
}

function exactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every((key) => typeof key === "string" && keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key));
}

function validCanonicalPath(value: unknown): value is string {
  return typeof value === "string"
    && isAbsolute(value)
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 4_096
    && !value.includes("\0");
}

function validRepositoryReceipt(
  value: unknown,
): value is RepositoryDirectoryReceipt {
  return exactKeys(value, [
    "checkoutRoot",
    "checkoutRootIdentity",
    "commonDirectory",
    "commonDirectoryIdentity",
  ])
    && validCanonicalPath(value.checkoutRoot)
    && isWorktreeFilesystemIdentity(value.checkoutRootIdentity)
    && validCanonicalPath(value.commonDirectory)
    && isWorktreeFilesystemIdentity(value.commonDirectoryIdentity);
}

function validWorkspacePathReceipt(value: unknown): value is WorkspacePathReceipt {
  return exactKeys(value, [
    "version",
    "canonicalPath",
    "directoryIdentity",
    "repository",
  ])
    && value.version === 1
    && validCanonicalPath(value.canonicalPath)
    && isWorktreeFilesystemIdentity(value.directoryIdentity)
    && (value.repository === null || validRepositoryReceipt(value.repository));
}

function parseReceipt(value: string): WorkspacePathReceipt | null {
  if (Buffer.byteLength(value, "utf8") > MAX_AUTHORITY_RECEIPT_BYTES) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return validWorkspacePathReceipt(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function serializeReceipt(value: WorkspacePathReceipt): string {
  if (!validWorkspacePathReceipt(value)) {
    throw new Error("The workspace path authority receipt is invalid.");
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_AUTHORITY_RECEIPT_BYTES) {
    throw new Error("The workspace path authority receipt is too large.");
  }
  return serialized;
}

function directoryIdentity(path: string): WorktreeFilesystemIdentity {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("The workspace path is not a direct directory.");
  }
  const identity = {
    device: info.dev.toString(),
    inode: info.ino.toString(),
    birthtimeNs: info.birthtimeNs.toString(),
  };
  if (!isWorktreeFilesystemIdentity(identity)) {
    throw new Error("The workspace filesystem cannot provide a durable identity.");
  }
  return identity;
}

function canonicalDirectory(path: string): {
  canonicalPath: string;
  identity: WorktreeFilesystemIdentity;
} {
  const selectedPath = resolve(path);
  const selectedIdentity = directoryIdentity(selectedPath);
  const canonicalPath = realpathSync.native(selectedPath);
  const identity = directoryIdentity(canonicalPath);
  if (!worktreeFilesystemIdentitiesEqual(selectedIdentity, identity)) {
    throw new Error("The workspace path changed while it was inspected.");
  }
  return { canonicalPath, identity };
}

function smallGitPointer(path: string): string {
  const info = lstatSync(path, { bigint: true });
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || info.size > BigInt(MAX_GIT_POINTER_BYTES)
  ) {
    throw new Error("The Git directory pointer is invalid.");
  }
  const value = readFileSync(path, "utf8");
  if (
    Buffer.byteLength(value, "utf8") > MAX_GIT_POINTER_BYTES
    || value.includes("\0")
  ) {
    throw new Error("The Git directory pointer is invalid.");
  }
  return value;
}

function gitDirectory(checkoutRoot: string): string {
  const marker = resolve(checkoutRoot, ".git");
  const markerInfo = lstatSync(marker, { bigint: true });
  if (markerInfo.isSymbolicLink()) {
    throw new Error("The Git directory marker is an unsafe symbolic link.");
  }
  if (markerInfo.isDirectory()) return realpathSync.native(marker);
  if (!markerInfo.isFile()) {
    throw new Error("The Git directory marker is invalid.");
  }
  const match = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(smallGitPointer(marker));
  if (!match?.[1]) throw new Error("The Git directory pointer is invalid.");
  const target = isAbsolute(match[1])
    ? match[1]
    : resolve(dirname(marker), match[1]);
  return canonicalDirectory(target).canonicalPath;
}

function gitCommonDirectory(checkoutRoot: string): string {
  const directory = gitDirectory(checkoutRoot);
  const commonPointer = resolve(directory, "commondir");
  if (!existsSync(commonPointer)) return directory;
  const value = smallGitPointer(commonPointer);
  if (!value || /[\r\n]/u.test(value.trimEnd())) {
    throw new Error("The Git common-directory pointer is invalid.");
  }
  const relativePath = value.trimEnd();
  if (!relativePath || relativePath.includes("\0")) {
    throw new Error("The Git common-directory pointer is invalid.");
  }
  return canonicalDirectory(
    isAbsolute(relativePath)
      ? relativePath
      : resolve(directory, relativePath),
  ).canonicalPath;
}

function repositoryIdentityPath(identity: string | null): string | null {
  if (!identity?.startsWith(GIT_IDENTITY_PREFIX)) return null;
  const path = identity.slice(GIT_IDENTITY_PREFIX.length);
  return validCanonicalPath(path) ? path : null;
}

function captureReceipt(input: {
  path: string;
  repositoryRoot: string | null;
  repositoryIdentity: string | null;
}): WorkspacePathReceipt {
  const workspace = canonicalDirectory(input.path);
  const expectedCommonDirectory = repositoryIdentityPath(
    input.repositoryIdentity,
  );
  let repository: RepositoryDirectoryReceipt | null = null;
  if (expectedCommonDirectory !== null) {
    if (!input.repositoryRoot) {
      throw new Error("The enrolled Git workspace is missing its checkout root.");
    }
    const checkoutRoot = canonicalDirectory(input.repositoryRoot);
    const commonDirectory = canonicalDirectory(expectedCommonDirectory);
    const reportedCommonDirectory = gitCommonDirectory(
      checkoutRoot.canonicalPath,
    );
    if (
      normalizeIdentityPath(reportedCommonDirectory)
      !== normalizeIdentityPath(commonDirectory.canonicalPath)
    ) {
      throw new Error("The Git common directory does not match the project.");
    }
    repository = {
      checkoutRoot: checkoutRoot.canonicalPath,
      checkoutRootIdentity: checkoutRoot.identity,
      commonDirectory: commonDirectory.canonicalPath,
      commonDirectoryIdentity: commonDirectory.identity,
    };
  }
  return {
    version: 1,
    canonicalPath: workspace.canonicalPath,
    directoryIdentity: workspace.identity,
    repository,
  };
}

function validateReceipt(path: string, receipt: WorkspacePathReceipt): string {
  const before = canonicalDirectory(path);
  if (
    normalizeIdentityPath(before.canonicalPath)
      !== normalizeIdentityPath(receipt.canonicalPath)
    || !worktreeFilesystemIdentitiesEqual(
      before.identity,
      receipt.directoryIdentity,
    )
  ) {
    throw new Error("The workspace directory was replaced.");
  }
  if (receipt.repository) {
    const checkoutRoot = canonicalDirectory(receipt.repository.checkoutRoot);
    if (
      normalizeIdentityPath(checkoutRoot.canonicalPath)
        !== normalizeIdentityPath(receipt.repository.checkoutRoot)
      || !worktreeFilesystemIdentitiesEqual(
        checkoutRoot.identity,
        receipt.repository.checkoutRootIdentity,
      )
    ) {
      throw new Error("The repository checkout root was replaced.");
    }
    const reportedCommonDirectory = gitCommonDirectory(
      checkoutRoot.canonicalPath,
    );
    const commonDirectory = canonicalDirectory(reportedCommonDirectory);
    if (
      normalizeIdentityPath(commonDirectory.canonicalPath)
        !== normalizeIdentityPath(receipt.repository.commonDirectory)
      || !worktreeFilesystemIdentitiesEqual(
        commonDirectory.identity,
        receipt.repository.commonDirectoryIdentity,
      )
    ) {
      throw new Error("The Git common directory was replaced.");
    }
  }
  const after = canonicalDirectory(path);
  if (
    normalizeIdentityPath(after.canonicalPath)
      !== normalizeIdentityPath(before.canonicalPath)
    || !worktreeFilesystemIdentitiesEqual(after.identity, before.identity)
  ) {
    throw new Error("The workspace directory changed during validation.");
  }
  return resolve(path);
}

export class WorkspacePathAuthorityError extends Error {}

function authorityFailure(): WorkspacePathAuthorityError {
  return new WorkspacePathAuthorityError(
    "This workspace folder was replaced or cannot be verified, so its authorization expired. Re-add the project before running privileged operations.",
  );
}

export class WorkspacePathAuthority {
  constructor(private readonly database: Database.Database) {}

  enrollConversationRow(row: ConversationRow): void {
    if (row.worktree_path === null) {
      throw new Error("The conversation does not have a worktree to enroll.");
    }
    this.enrollConversation(row.id, row.project_id, row.worktree_path);
  }

  enrollProject(
    projectId: string,
    path: string,
    repositoryRoot: string | null,
    repositoryIdentity: string | null,
  ): void {
    const receipt = captureReceipt({ path, repositoryRoot, repositoryIdentity });
    this.database.prepare(`
      INSERT INTO project_path_authorities (project_id, path, receipt_json)
      VALUES (?, ?, ?)
    `).run(projectId, resolve(path), serializeReceipt(receipt));
  }

  promoteProjectRepository(
    projectId: string,
    path: string,
    repositoryRoot: string,
    repositoryIdentity: string,
  ): void {
    const authority = this.projectAuthority(projectId);
    if (authority.receipt.repository !== null) {
      throw new Error("The project repository identity is already enrolled.");
    }
    validateReceipt(path, authority.receipt);
    const promoted = captureReceipt({
      path,
      repositoryRoot,
      repositoryIdentity,
    });
    if (
      promoted.repository === null
      || normalizeIdentityPath(promoted.canonicalPath)
        !== normalizeIdentityPath(authority.receipt.canonicalPath)
      || !worktreeFilesystemIdentitiesEqual(
        promoted.directoryIdentity,
        authority.receipt.directoryIdentity,
      )
    ) {
      throw new Error("The project repository identity cannot be enrolled.");
    }
    const result = this.database.prepare(`
      UPDATE project_path_authorities SET receipt_json = ?
      WHERE project_id = ? AND path = ? AND receipt_json = ?
    `).run(
      serializeReceipt(promoted),
      projectId,
      authority.path,
      serializeReceipt(authority.receipt),
    );
    if (result.changes !== 1) {
      throw new Error("The project path authority changed during enrollment.");
    }
  }

  enrollConversation(
    conversationId: string,
    projectId: string,
    path: string,
  ): void {
    const projectAuthority = this.projectAuthority(projectId);
    const repository = projectAuthority.receipt.repository;
    const receipt = captureReceipt({
      path,
      repositoryRoot: repository ? path : null,
      repositoryIdentity: repository
        ? `${GIT_IDENTITY_PREFIX}${repository.commonDirectory}`
        : null,
    });
    this.database.prepare(`
      INSERT INTO conversation_path_authorities (
        conversation_id, path, receipt_json
      ) VALUES (?, ?, ?)
    `).run(conversationId, resolve(path), serializeReceipt(receipt));
  }

  resolveProject(row: ProjectRow): string {
    try {
      const authority = this.projectAuthority(row.id);
      if (normalizeIdentityPath(resolve(row.path)) !== normalizeIdentityPath(authority.path)) {
        throw new Error("The stored project path changed.");
      }
      const currentCommonDirectory = repositoryIdentityPath(
        row.repository_identity,
      );
      const enrolledRepository = authority.receipt.repository;
      if (
        (currentCommonDirectory === null) !== (enrolledRepository === null)
        || (
          currentCommonDirectory
          && enrolledRepository
          && (
            normalizeIdentityPath(currentCommonDirectory)
              !== normalizeIdentityPath(enrolledRepository.commonDirectory)
            || row.repository_root === null
            || normalizeIdentityPath(row.repository_root)
              !== normalizeIdentityPath(enrolledRepository.checkoutRoot)
          )
        )
      ) {
        throw new Error("The stored repository identity changed.");
      }
      return validateReceipt(row.path, authority.receipt);
    } catch {
      throw authorityFailure();
    }
  }

  resolveConversation(row: ConversationRow, project: ProjectRow): string {
    const projectPath = this.resolveProject(project);
    if (row.worktree_path === null) return projectPath;
    try {
      const authority = this.conversationAuthority(row.id);
      if (
        normalizeIdentityPath(resolve(row.worktree_path))
          !== normalizeIdentityPath(authority.path)
      ) {
        throw new Error("The stored conversation path changed.");
      }
      const projectAuthority = this.projectAuthority(project.id);
      const expectedRepository = projectAuthority.receipt.repository;
      const actualRepository = authority.receipt.repository;
      if (
        (expectedRepository === null) !== (actualRepository === null)
        || (
          expectedRepository
          && actualRepository
          && normalizeIdentityPath(expectedRepository.commonDirectory)
            !== normalizeIdentityPath(actualRepository.commonDirectory)
        )
      ) {
        throw new Error("The conversation checkout belongs to another repository.");
      }
      return validateReceipt(row.worktree_path, authority.receipt);
    } catch {
      throw authorityFailure();
    }
  }

  enrollMissing(): void {
    const marker = this.database.prepare(`
      SELECT completed FROM workspace_path_authority_enrollment WHERE id = 1
    `).get() as { completed: number } | undefined;
    if (!marker || marker.completed === 1) return;
    if (marker.completed !== 0) {
      throw new Error("The workspace path enrollment marker is invalid.");
    }
    const projects = this.database.prepare(`
      SELECT projects.* FROM projects
      LEFT JOIN project_path_authorities
        ON project_path_authorities.project_id = projects.id
      WHERE project_path_authorities.project_id IS NULL
    `).all() as ProjectRow[];
    for (const project of projects) {
      try {
        this.enrollProject(
          project.id,
          project.path,
          project.repository_root,
          project.repository_identity,
        );
      } catch {
        // Unavailable legacy paths remain unenrolled and fail closed later.
      }
    }
    const conversations = this.database.prepare(`
      SELECT conversations.* FROM conversations
      LEFT JOIN conversation_path_authorities
        ON conversation_path_authorities.conversation_id = conversations.id
      WHERE conversations.worktree_path IS NOT NULL
        AND conversation_path_authorities.conversation_id IS NULL
    `).all() as ConversationRow[];
    for (const conversation of conversations) {
      try {
        this.enrollConversation(
          conversation.id,
          conversation.project_id,
          conversation.worktree_path!,
        );
      } catch {
        // Unavailable legacy worktrees remain unenrolled and fail closed later.
      }
    }
    const result = this.database.prepare(`
      UPDATE workspace_path_authority_enrollment SET completed = 1
      WHERE id = 1 AND completed = 0
    `).run();
    if (result.changes !== 1) {
      throw new Error("The workspace path enrollment marker changed.");
    }
  }

  private projectAuthority(projectId: string): {
    path: string;
    receipt: WorkspacePathReceipt;
  } {
    const row = this.database.prepare(`
      SELECT path, receipt_json FROM project_path_authorities
      WHERE project_id = ?
    `).get(projectId) as WorkspacePathAuthorityRow | undefined;
    const receipt = row ? parseReceipt(row.receipt_json) : null;
    if (!row || !receipt) throw new Error("The project is not enrolled.");
    return { path: row.path, receipt };
  }

  private conversationAuthority(conversationId: string): {
    path: string;
    receipt: WorkspacePathReceipt;
  } {
    const row = this.database.prepare(`
      SELECT path, receipt_json FROM conversation_path_authorities
      WHERE conversation_id = ?
    `).get(conversationId) as WorkspacePathAuthorityRow | undefined;
    const receipt = row ? parseReceipt(row.receipt_json) : null;
    if (!row || !receipt) throw new Error("The conversation is not enrolled.");
    return { path: row.path, receipt };
  }
}
