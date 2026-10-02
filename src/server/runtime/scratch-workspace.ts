import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Conversation, Project } from "../../shared/contracts";
import type { RuntimeStore } from "../database";
import type { NewConversationOptions } from "../persistence/types";
import { GitError } from "../git/types";
import { isContained } from "../git/paths";
import { runGitInspection } from "../git/runner";
import { normalizeIdentityPath } from "../project-identity";
import { RuntimeRequestError } from "../runtime-errors";

export function isWithinScratchRoot(dataDirectory: string, path: string): boolean {
  let root: string;
  let candidate: string;
  try {
    root = normalizeIdentityPath(realpathSync(join(dataDirectory, "scratch")));
    candidate = normalizeIdentityPath(realpathSync(path));
  } catch {
    return false;
  }
  return isContained(root, candidate);
}

/** A real project identity owns Scratch; each chat owns a separate plain folder. */
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
    if (existing && normalizeIdentityPath(existing.path) === normalizeIdentityPath(root)) {
      this.store.projectPath(existing.id);
    } else {
      try { mkdirSync(root, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    this.verifyRoot(root);
    // A data directory inside a checkout must not lend that repository to Scratch.
    try {
      await runGitInspection(root, ["rev-parse", "--is-inside-work-tree"], {
        timeoutMs: 3_000, maxOutputBytes: 4_096,
        failureMessage: "Could not check the folder for chats without a project.",
      });
      throw new RuntimeRequestError("Chats without a project need an Inertia data folder outside a Git repository.");
    } catch (error) {
      if (!(error instanceof GitError && error.code === "not-repository")) throw error;
    }
    this.verifyRoot(root);
    // No await between this lookup and insert: concurrent requests share one container.
    const current = this.store.shellSnapshot().projects.find((project) => project.workspaceKind === "scratch");
    if (current && normalizeIdentityPath(current.path) !== normalizeIdentityPath(root)) {
      return this.store.updateProject(current.id, { path: root, normalizedPath: root });
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
    const words = title.toLowerCase().match(/[a-z0-9]+/gu)?.slice(0, 5).join("-").slice(0, 48) || "chat";
    // The full UUID avoids short-prefix collisions. Never reuse an existing leaf.
    const folder = join(root, `${new Date().toISOString().slice(0, 10)}-${words}-${id}`);
    mkdirSync(folder, { mode: 0o700 });
    const claimed = lstatSync(folder);
    try {
      this.verifyRoot(root);
      this.store.projectPath(project.id);
      if (lstatSync(folder).isSymbolicLink() || realpathSync(folder) !== join(realpathSync(root), folder.slice(root.length + 1))) {
        throw new RuntimeRequestError("The chat folder changed before it could be authorized.");
      }
      return this.store.createConversation(project.id, title, { ...options, id, branch: null, worktreePath: folder });
    } catch (error) {
      // Only remove the empty directory claimed by this attempt; never remove user files.
      try {
        this.verifyRoot(root);
        this.store.projectPath(project.id);
        const current = lstatSync(folder);
        if (!current.isSymbolicLink() && current.ino === claimed.ino && current.dev === claimed.dev && current.birthtimeMs === claimed.birthtimeMs) rmdirSync(folder);
      } catch { /* Preserve anything we cannot safely remove. */ }
      throw error;
    }
  }
}
