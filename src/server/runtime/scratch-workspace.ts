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
import { WorkspacePathAuthorityError } from "../workspace-path-authority";

export { isWithinScratchRoot } from "../scratch-root";

export const SCRATCH_PROVISIONING_CHUNK = 100;

const LEFTOVER_FOLDER = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const setupQueues = new WeakMap<RuntimeStore, Promise<void>>();

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
      const metadata = lstatSync(folder);
      return dirname(resolve(folder)) === resolve(root)
        && !metadata.isSymbolicLink()
        && metadata.isDirectory()
        && metadata.dev === lstatSync(root).dev
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

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = setupQueues.get(this.store) ?? Promise.resolve();
    const next = previous.then(work, work);
    setupQueues.set(this.store, next.then(() => undefined, () => undefined));
    return next;
  }

  ensureProject(): Promise<Project> {
    return this.serialized(() => this.ensureProjectNow());
  }

  private async ensureProjectNow(): Promise<Project> {
    const root = resolve(this.dataDirectory, "scratch");
    let created: Stats | null = null;
    try {
      mkdirSync(root, { mode: 0o700 });
      created = lstatSync(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    try {
      await this.checkRoot(root);
    } catch (error) {
      if (created) releaseClaimedFolder(root, created);
      throw error;
    }
    const current = this.store.shellSnapshot().projects.find((project) => project.workspaceKind === "scratch");
    if (!current) return this.store.createProject("No project", root, { workspaceKind: "scratch", activate: false });
    const bound = normalizeIdentityPath(current.path) === normalizeIdentityPath(root) && this.hasValidReceipt(current.id);
    const project = bound ? current : this.store.rebindScratchProject(current.id, root);
    this.store.projectPath(project.id);
    this.adoptMovedChats(project.id, root);
    return project;
  }

  private hasValidReceipt(projectId: string): boolean {
    try {
      this.store.projectPath(projectId);
      return true;
    } catch (error) {
      if (error instanceof WorkspacePathAuthorityError) return false;
      throw error;
    }
  }

  private async checkRoot(root: string): Promise<void> {
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
  }

  reconcile(): Promise<void> {
    return this.serialized(() => this.reconcileNow());
  }

  private async reconcileNow(): Promise<void> {
    const project = this.store.shellSnapshot().projects.find(({ workspaceKind }) => workspaceKind === "scratch");
    if (!project) return;
    const root = resolve(this.dataDirectory, "scratch");
    const chats = this.chatsOf(project.id);
    const hasPending = chats.some(({ worktreePath }) => worktreePath === null);
    const relocated = normalizeIdentityPath(project.path) !== normalizeIdentityPath(root)
      || chats.some(({ worktreePath }) => worktreePath !== null && dirname(resolve(worktreePath)) !== root);
    if (!hasPending && !(relocated && pathExists(root))) return;
    const current = await this.ensureProjectNow();
    const projectRoot = this.store.projectPath(current.id);
    const leftovers = new Map(readdirSync(projectRoot).map((name) => [name.slice(-36), name]));
    const pending = this.chatsOf(current.id).filter(({ worktreePath }) => worktreePath === null);
    for (let start = 0; start < pending.length; start += SCRATCH_PROVISIONING_CHUNK) {
      if (start > 0) await new Promise<void>((resume) => setImmediate(resume));
      for (const chat of pending.slice(start, start + SCRATCH_PROVISIONING_CHUNK)) {
        if (this.store.conversation(chat.id).worktreePath !== null) continue;
        try {
          this.materializeFolder(current.id, projectRoot, chat, leftovers.get(chat.id));
        } catch {
          continue;
        }
      }
    }
  }

  private materializeFolder(projectId: string, root: string, chat: Conversation, leftover: string | undefined): void {
    if (leftover && LEFTOVER_FOLDER.test(leftover) && leftover.endsWith(`-${chat.id}`)) {
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
