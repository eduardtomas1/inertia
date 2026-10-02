import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { Project } from "../../shared/contracts";
import { defaultProjectPreferences, projectPreferencesSchema } from "../../shared/project-preferences";
import { WorkspacePathAuthority } from "../workspace-path-authority";
import { projectFromRow } from "./codecs";
import type { PersistenceContext } from "./context";

const PROJECT_COLORS = ["#6f76d9", "#5b8ca8", "#8a73ba", "#a76c79", "#9a814f", "#687f91"] as const;

type ProjectPersistenceContext = Pick<PersistenceContext, "database" | "requireProject">;
type ProjectIdentityFields = "normalizedPath" | "repositoryIdentity" | "repositoryRoot" | "repositoryRelativePath" | "workspaceKind";

export type NewProjectOptions = Partial<Pick<Project, ProjectIdentityFields>> & {
  activate?: boolean;
  enroll?: boolean;
};

export class ProjectRepository {
  private readonly pathAuthority: WorkspacePathAuthority;

  constructor(private readonly context: ProjectPersistenceContext) {
    this.pathAuthority = new WorkspacePathAuthority(context.database);
  }

  create(
    name: string,
    projectPath: string,
    identity: NewProjectOptions = {},
  ): Project {
    const id = randomUUID();
    const now = new Date().toISOString();
    const projectCount = (this.context.database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count;
    const path = resolve(projectPath);
    const project: Project = {
      ...(identity.workspaceKind ? { workspaceKind: identity.workspaceKind } : {}),
      id,
      name,
      path,
      normalizedPath: identity.normalizedPath ?? path,
      repositoryIdentity: identity.repositoryIdentity ?? null,
      repositoryRoot: identity.repositoryRoot ?? null,
      repositoryRelativePath: identity.repositoryRelativePath ?? ".",
      groupingMode: null,
      preferences: defaultProjectPreferences(),
      gitRepositoryLimit: 16,
      color: PROJECT_COLORS[projectCount % PROJECT_COLORS.length],
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    this.context.database.transaction(() => {
      this.context.database.prepare(`
        INSERT INTO projects (
          id, name, path, normalized_path, repository_identity, repository_root,
          repository_relative_path, grouping_mode, git_repository_limit,
          color, status, created_at, updated_at, workspace_kind
        ) VALUES (
          @id, @name, @path, @normalizedPath, @repositoryIdentity, @repositoryRoot,
          @repositoryRelativePath, @groupingMode, @gitRepositoryLimit,
          @color, @status, @createdAt, @updatedAt, @workspaceKind
        )
      `).run({ ...project, workspaceKind: project.workspaceKind ?? null });
      if (identity.activate !== false) this.context.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = NULL WHERE id = 1").run(project.id);
      if (identity.enroll !== false) {
        this.pathAuthority.enrollProject(
          project.id,
          project.path,
          project.repositoryRoot,
          project.repositoryIdentity,
        );
      }
    })();
    return project;
  }

  update(
    projectId: string,
    update: Partial<Pick<Project, "name" | "groupingMode" | "gitRepositoryLimit" | "normalizedPath" | "repositoryIdentity" | "repositoryRoot" | "repositoryRelativePath" | "preferences">>,
  ): Project {
    const current = projectFromRow(this.context.requireProject(projectId));
    const unchanged = Object.entries(update).every(([key, value]) => current[key as keyof Project] === value);
    if (unchanged) return current;
    const next = { ...current, ...update, updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString() };
    const preferencesJson = JSON.stringify(projectPreferencesSchema.parse(next.preferences));
    this.context.database.transaction(() => {
      const repositoryChanged =
        next.repositoryIdentity !== current.repositoryIdentity
        || next.repositoryRoot !== current.repositoryRoot;
      if (repositoryChanged) {
        if (current.workspaceKind === "scratch") {
          throw new Error("The folder for chats without a project cannot become a Git repository.");
        }
        if (
          current.repositoryIdentity !== null
          || current.repositoryRoot !== null
          || next.repositoryIdentity === null
          || next.repositoryRoot === null
        ) {
          throw new Error("The enrolled project repository identity cannot be changed.");
        }
        this.pathAuthority.promoteProjectRepository(
          projectId,
          current.path,
          next.repositoryRoot,
          next.repositoryIdentity,
        );
      }
      this.context.database.prepare(`
        UPDATE projects SET
          name = @name,
          normalized_path = @normalizedPath,
          repository_identity = @repositoryIdentity,
          repository_root = @repositoryRoot,
          repository_relative_path = @repositoryRelativePath,
          grouping_mode = @groupingMode,
          git_repository_limit = @gitRepositoryLimit,
          preferences_json = @preferencesJson,
          updated_at = @updatedAt
        WHERE id = @id
      `).run({ ...next, preferencesJson });
    })();
    return next;
  }

  rebindScratch(projectId: string, projectPath: string): Project {
    const current = projectFromRow(this.context.requireProject(projectId));
    if (current.workspaceKind !== "scratch" || current.repositoryIdentity !== null || current.repositoryRoot !== null) {
      throw new Error("Only the folder for chats without a project can move.");
    }
    const path = resolve(projectPath);
    const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString();
    const next = { ...current, path, normalizedPath: path, updatedAt };
    this.context.database.transaction(() => {
      this.context.database.prepare("UPDATE projects SET path = ?, normalized_path = ?, updated_at = ? WHERE id = ?")
        .run(next.path, next.normalizedPath, next.updatedAt, projectId);
      this.pathAuthority.reenrollProject(projectId, path);
    })();
    return next;
  }

  remove(projectId: string): void {
    this.context.requireProject(projectId);
    const state = this.context.database.prepare("SELECT active_project_id FROM app_state WHERE id = 1").get() as { active_project_id: string | null } | undefined;
    this.context.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    const activeProjectId = state?.active_project_id ?? null;
    if (activeProjectId !== null && activeProjectId !== projectId) return;
    this.selectRegularProject();
  }

  select(projectId: string): void {
    const project = this.context.requireProject(projectId);
    const conversation = this.context.database.prepare(`SELECT id FROM conversations WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`).get(projectId) as { id: string } | undefined;
    if (!conversation && project.workspace_kind === "scratch") {
      this.selectRegularProject();
      return;
    }
    this.context.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1").run(projectId, conversation?.id ?? null);
  }

  private selectRegularProject(): void {
    const next = this.context.database.prepare(
      "SELECT id FROM projects WHERE workspace_kind IS NULL ORDER BY updated_at DESC LIMIT 1",
    ).get() as { id: string } | undefined;
    if (next) this.select(next.id);
    else this.context.database.prepare("UPDATE app_state SET active_project_id = NULL, active_conversation_id = NULL WHERE id = 1").run();
  }

  get(projectId: string): Project {
    return projectFromRow(this.context.requireProject(projectId));
  }

  path(projectId: string): string {
    return this.pathAuthority.resolveProject(
      this.context.requireProject(projectId),
    );
  }

  enrollMissingPaths(): void {
    this.pathAuthority.enrollMissing();
  }

  touch(projectId: string, timestamp: string): void {
    this.context.database.prepare("UPDATE projects SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(timestamp, projectId);
  }
}
