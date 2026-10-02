import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmdirSync, statSync, type BigIntStats, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Conversation, Project } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type { NewConversationOptions } from "../persistence/types";
import { GitError } from "../git/types";
import { runGitInspection } from "../git/runner";
import { normalizeIdentityPath } from "../project-identity";
import { RuntimeRequestError } from "../runtime-errors";

function isSameDirectory(path: string, identity: BigIntStats): boolean {
  try {
    const current = statSync(path, { bigint: true });
    return current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}

export function isWithinScratchRoot(dataDirectory: string, path: string): boolean {
  let root: BigIntStats;
  let candidate: string;
  try {
    root = statSync(join(dataDirectory, "scratch"), { bigint: true });
    candidate = realpathSync.native(path);
  } catch {
    return false;
  }
  for (let current = candidate; ; current = dirname(current)) {
    if (isSameDirectory(current, root)) return true;
    if (dirname(current) === current) return false;
  }
}

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

export class ScratchWorkspace {
  constructor(private readonly store: RuntimeStore, private readonly dataDirectory: string) {}

  private verifyRoot(root: string): void {
    const expected = join(realpathSync(this.dataDirectory), "scratch");
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()
      || normalizeIdentityPath(realpathSync(root)) !== normalizeIdentityPath(expected)) {
      throw new RuntimeRequestError("The folder for chats without a project cannot be verified.");
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
    if (current && (rootMissing || normalizeIdentityPath(current.path) !== normalizeIdentityPath(root))) {
      return this.store.rebindScratchProject(current.id, root);
    }
    if (current) {
      this.store.projectPath(current.id);
      return current;
    }
    return this.store.createProject("No project", root, { workspaceKind: "scratch", activate: false });
  }

  async createConversation(projectId: string, title: string, options: NewConversationOptions): Promise<Conversation> {
    const project = await this.ensureProject();
    if (project.id !== projectId) throw new RuntimeRequestError("The chat's managed workspace changed.");
    const root = this.store.projectPath(project.id);
    this.verifyRoot(root);
    const id = options.id ?? randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
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
    const words = title.toLowerCase().match(/[a-z0-9]+/gu)?.slice(0, 5).join("-").slice(0, 48) || "chat";
    const folder = join(root, `${new Date().toISOString().slice(0, 10)}-${words}-${id}`);
    mkdirSync(folder, { mode: 0o700 });
    const claimed = lstatSync(folder);
    try {
      this.verifyRoot(root);
      this.store.projectPath(projectId);
      const realFolder = realpathSync(folder);
      if (lstatSync(folder).isSymbolicLink() || realFolder !== join(realpathSync(root), basename(folder))) {
        throw new RuntimeRequestError("The chat folder changed before it could be authorized.");
      }
    } catch (error) {
      releaseClaimedFolder(folder, claimed);
      throw error;
    }
    return { folder, claimed };
  }
}
