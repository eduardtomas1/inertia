import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Conversation, Project } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type { NewConversationOptions } from "../persistence/types";
import { GitError } from "../git/types";
import { runGitInspection } from "../git/runner";
import { normalizeIdentityPath } from "../project-identity";
import { RuntimeRequestError } from "../runtime-errors";

export { isWithinScratchRoot } from "../scratch-root";

const CHAT_IDENTITY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function releaseClaimedFolder(folder: string, claimed: Stats): void {
  try {
    const current = lstatSync(folder);
    const sameFolder = !current.isSymbolicLink()
      && current.ino === claimed.ino
      && current.dev === claimed.dev
      && current.birthtimeMs === claimed.birthtimeMs;
    if (sameFolder) rmdirSync(folder);
  } catch {
    return;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function hasRepositoryMarker(path: string): boolean {
  for (let directory = realpathSync(path); ; directory = dirname(directory)) {
    try {
      lstatSync(join(directory, ".git"));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
    if (dirname(directory) === directory) return false;
  }
}

function folderWords(title: string): string {
  return title.toLowerCase().match(/[a-z0-9]+/gu)?.slice(0, 5).join("-").slice(0, 48) || "chat";
}

export class ScratchWorkspace {
  constructor(private readonly store: RuntimeStore, private readonly dataDirectory: string) {}

  private verifyRoot(root: string): void {
    const expected = join(realpathSync(this.dataDirectory), "scratch");
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()
      || normalizeIdentityPath(realpathSync(root)) !== normalizeIdentityPath(expected)) {
      throw new RuntimeRequestError("The folder for chats without a project cannot be verified.");
    }
  }

  private isDirectChild(root: string, folder: string): boolean {
    try {
      return dirname(resolve(folder)) === resolve(root)
        && !lstatSync(folder).isSymbolicLink()
        && lstatSync(folder).isDirectory()
        && realpathSync(folder) === join(realpathSync(root), basename(folder));
    } catch {
      return false;
    }
  }

  private chatsOf(projectId: string): Conversation[] {
    return this.store.shellSnapshot().conversations.filter((conversation) => conversation.projectId === projectId);
  }

  private adoptMovedChats(projectId: string, root: string): void {
    const chats = this.chatsOf(projectId);
    const used = new Set(chats.map(({ worktreePath }) => worktreePath).filter((path) => path !== null));
    for (const chat of chats) {
      if (chat.worktreePath === null || dirname(resolve(chat.worktreePath)) === resolve(root)) continue;
      const candidate = join(root, basename(chat.worktreePath));
      if (!basename(candidate).endsWith(`-${chat.id}`) || used.has(candidate)) continue;
      if (!this.isDirectChild(root, candidate)) continue;
      this.store.bindScratchFolder(chat.id, candidate);
      used.add(candidate);
    }
  }

  async ensureProject(): Promise<Project> {
    const root = resolve(this.dataDirectory, "scratch");
    const existing = this.store.shellSnapshot().projects.find((project) => project.workspaceKind === "scratch");
    const rootMissing = !pathExists(root);
    if (existing && !rootMissing && normalizeIdentityPath(existing.path) === normalizeIdentityPath(root)) {
      this.store.projectPath(existing.id);
    } else {
      try { mkdirSync(root, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    this.verifyRoot(root);
    const insideRepository = new RuntimeRequestError(
      "Chats without a project need an Inertia data folder outside a Git repository.",
    );
    try {
      await runGitInspection(root, ["rev-parse", "--is-inside-work-tree"], {
        timeoutMs: 3_000, maxOutputBytes: 4_096,
        failureMessage: "Could not check the folder for chats without a project.",
      });
      throw insideRepository;
    } catch (error) {
      const gitUnavailable = error instanceof GitError && error.code === "git-unavailable";
      if (gitUnavailable && hasRepositoryMarker(root)) throw insideRepository;
      if (!gitUnavailable && !(error instanceof GitError && error.code === "not-repository")) throw error;
    }
    this.verifyRoot(root);
    const current = this.store.shellSnapshot().projects.find((project) => project.workspaceKind === "scratch");
    if (!current) return this.store.createProject("No project", root, { workspaceKind: "scratch", activate: false });
    const moved = rootMissing || normalizeIdentityPath(current.path) !== normalizeIdentityPath(root);
    const project = moved ? this.store.rebindScratchProject(current.id, root) : current;
    this.store.projectPath(project.id);
    this.adoptMovedChats(project.id, root);
    return project;
  }

  async reconcile(): Promise<void> {
    const project = this.store.shellSnapshot().projects.find(({ workspaceKind }) => workspaceKind === "scratch");
    if (!project) return;
    const root = resolve(this.dataDirectory, "scratch");
    const chats = this.chatsOf(project.id);
    const pending = chats.filter(({ worktreePath }) => worktreePath === null);
    const relocated = normalizeIdentityPath(project.path) !== normalizeIdentityPath(root)
      || chats.some(({ worktreePath }) => worktreePath !== null && dirname(resolve(worktreePath)) !== root);
    if (pending.length === 0 && !(relocated && pathExists(root))) return;
    const current = await this.ensureProject();
    if (pending.length === 0) return;
    const projectRoot = this.store.projectPath(current.id);
    const leftovers = new Map(readdirSync(projectRoot).map((name) => [name.slice(-36), name]));
    for (const chat of pending) {
      try {
        this.materializeFolder(current.id, projectRoot, chat, leftovers.get(chat.id));
      } catch {
        continue;
      }
    }
  }

  private materializeFolder(projectId: string, root: string, chat: Conversation, leftover: string | undefined): void {
    const expected = `-${folderWords(chat.title)}-${chat.id}`;
    if (leftover && /^\d{4}-\d{2}-\d{2}-/u.test(leftover) && leftover.endsWith(expected)) {
      const folder = join(root, leftover);
      if (this.isDirectChild(root, folder) && readdirSync(folder).length === 0) {
        this.store.bindScratchFolder(chat.id, folder);
        return;
      }
    }
    const { folder, claimed } = this.claimFolder(projectId, root, chat.id, chat.title);
    try {
      this.store.bindScratchFolder(chat.id, folder);
    } catch (error) {
      releaseClaimedFolder(folder, claimed);
      throw error;
    }
  }

  async createConversation(projectId: string, title: string, options: NewConversationOptions): Promise<Conversation> {
    const project = await this.ensureProject();
    if (project.id !== projectId) throw new RuntimeRequestError("The chat's managed workspace changed.");
    const root = this.store.projectPath(project.id);
    this.verifyRoot(root);
    const id = options.id ?? randomUUID();
    if (!CHAT_IDENTITY.test(id)) {
      throw new RuntimeRequestError("The chat identity is invalid.");
    }
    const { folder, claimed } = this.claimFolder(project.id, root, id, title);
    try {
      return this.store.createConversation(project.id, title, { ...options, id, branch: null, worktreePath: folder });
    } catch (error) {
      releaseClaimedFolder(folder, claimed);
      throw error;
    }
  }

  private claimFolder(projectId: string, root: string, id: string, title: string): { folder: string; claimed: Stats } {
    const folder = join(root, `${new Date().toISOString().slice(0, 10)}-${folderWords(title)}-${id}`);
    mkdirSync(folder, { mode: 0o700 });
    const claimed = lstatSync(folder);
    try {
      this.verifyRoot(root);
      this.store.projectPath(projectId);
      if (!this.isDirectChild(root, folder)) {
        throw new RuntimeRequestError("The chat folder changed before it could be authorized.");
      }
    } catch (error) {
      releaseClaimedFolder(folder, claimed);
      throw error;
    }
    return { folder, claimed };
  }
}
