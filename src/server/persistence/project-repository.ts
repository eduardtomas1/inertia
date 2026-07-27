import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { Project } from "../../shared/contracts";
import { projectFromRow } from "./codecs";
import type { PersistenceContext } from "./context";

const PROJECT_COLORS = ["#6f76d9", "#5b8ca8", "#8a73ba", "#a76c79", "#9a814f", "#687f91"] as const;

type ProjectPersistenceContext = Pick<PersistenceContext, "database" | "requireProject">;

export class ProjectRepository {
  constructor(private readonly context: ProjectPersistenceContext) {}

  create(
    name: string,
    projectPath: string,
    identity: Partial<Pick<Project, "normalizedPath" | "repositoryIdentity" | "repositoryRoot" | "repositoryRelativePath">> = {},
  ): Project {
    const id = randomUUID();
    const now = new Date().toISOString();
    const projectCount = (this.context.database.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number }).count;
    const path = resolve(projectPath);
    const project: Project = {
      id,
      name,
      path,
      normalizedPath: identity.normalizedPath ?? path,
      repositoryIdentity: identity.repositoryIdentity ?? null,
      repositoryRoot: identity.repositoryRoot ?? null,
      repositoryRelativePath: identity.repositoryRelativePath ?? ".",
      groupingMode: null,
      color: PROJECT_COLORS[projectCount % PROJECT_COLORS.length],
      status: "ready",
      createdAt: now,
      updatedAt: now,
    };
    this.context.database.transaction(() => {
      this.context.database.prepare(`
        INSERT INTO projects (
          id, name, path, normalized_path, repository_identity, repository_root,
          repository_relative_path, grouping_mode, color, status, created_at, updated_at
        ) VALUES (
          @id, @name, @path, @normalizedPath, @repositoryIdentity, @repositoryRoot,
          @repositoryRelativePath, @groupingMode, @color, @status, @createdAt, @updatedAt
        )
      `).run(project);
      this.context.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = NULL WHERE id = 1").run(project.id);
    })();
    return project;
  }

  update(
    projectId: string,
    update: Partial<Pick<Project, "name" | "groupingMode" | "normalizedPath" | "repositoryIdentity" | "repositoryRoot" | "repositoryRelativePath">>,
  ): Project {
    const current = projectFromRow(this.context.requireProject(projectId));
    const unchanged = Object.entries(update).every(([key, value]) => current[key as keyof Project] === value);
    if (unchanged) return current;
    const next = { ...current, ...update, updatedAt: new Date().toISOString() };
    this.context.database.prepare(`
      UPDATE projects SET
        name = @name,
        normalized_path = @normalizedPath,
        repository_identity = @repositoryIdentity,
        repository_root = @repositoryRoot,
        repository_relative_path = @repositoryRelativePath,
        grouping_mode = @groupingMode,
        updated_at = @updatedAt
      WHERE id = @id
    `).run(next);
    return next;
  }

  remove(projectId: string): void {
    this.context.requireProject(projectId);
    this.context.database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    const next = this.context.database.prepare("SELECT id FROM projects ORDER BY updated_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (next) this.select(next.id);
  }

  select(projectId: string): void {
    this.context.requireProject(projectId);
    const conversation = this.context.database.prepare(`SELECT id FROM conversations WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 1`).get(projectId) as { id: string } | undefined;
    this.context.database.prepare("UPDATE app_state SET active_project_id = ?, active_conversation_id = ? WHERE id = 1").run(projectId, conversation?.id ?? null);
  }

  get(projectId: string): Project {
    return projectFromRow(this.context.requireProject(projectId));
  }

  path(projectId: string): string {
    return this.context.requireProject(projectId).path;
  }

  touch(projectId: string, timestamp: string): void {
    this.context.database.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(timestamp, projectId);
  }
}
