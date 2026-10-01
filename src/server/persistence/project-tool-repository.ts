import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { MAX_PROJECT_TOOLS, projectToolDraftSchema, projectToolSchema, type ProjectTool, type ProjectToolDraft } from "../../shared/project-tools";
import { ProjectToolRepositoryError } from "./errors";

export class ProjectToolRepository {
  constructor(private readonly database: Database.Database) {}

  list(projectId: string): ProjectTool[] {
    const rows = this.database.prepare("SELECT id, project_id, revision, config_json FROM project_tools WHERE project_id = ? ORDER BY rowid")
      .all(projectId) as { id: string; project_id: string; revision: number; config_json: string }[];
    return rows.map((row) => projectToolSchema.parse({
      ...JSON.parse(row.config_json), id: row.id, projectId: row.project_id, revision: row.revision,
    }));
  }

  save(projectId: string, input: ProjectToolDraft, id?: string, revision?: number): void {
    const parsed = projectToolDraftSchema.safeParse(input);
    if (!parsed.success) throw new ProjectToolRepositoryError("Invalid tool connection. Use a Streamable HTTP URL and environment-variable names only.");
    this.database.transaction(() => {
      const current = this.list(projectId);
      if (id) {
        const result = this.database.prepare("UPDATE project_tools SET config_json = ?, revision = revision + 1 WHERE project_id = ? AND id = ? AND revision = ?")
          .run(JSON.stringify(parsed.data), projectId, id, revision ?? -1);
        if (!result.changes) throw new ProjectToolRepositoryError("This connection changed. Refresh Tools before saving again.");
      } else {
        if (current.length >= MAX_PROJECT_TOOLS) throw new ProjectToolRepositoryError(`A project can have up to ${MAX_PROJECT_TOOLS} tool connections.`);
        this.database.prepare("INSERT INTO project_tools (id, project_id, revision, config_json) VALUES (?, ?, 1, ?)")
          .run(randomUUID(), projectId, JSON.stringify(parsed.data));
      }
    })();
  }

  remove(projectId: string, id: string, revision: number): void {
    const result = this.database.prepare("DELETE FROM project_tools WHERE project_id = ? AND id = ? AND revision = ?")
      .run(projectId, id, revision);
    if (!result.changes) throw new ProjectToolRepositoryError("This connection changed. Refresh Tools before removing it.");
  }
}
