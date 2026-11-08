import type Database from "better-sqlite3";
import { OrchestrationConflict } from "./types";

export function assertNativeControlIdle(database: Database.Database, conversationId: string): void {
  if (database.prepare(`SELECT 1 FROM orchestration_v2_entities WHERE kind = 'native-control-lock' AND json_extract(payload_json, '$.resourceId') = ?
    AND json_extract(payload_json, '$.locked') = 1`).get(conversationId)) {
    throw new OrchestrationConflict("cleanup-pending");
  }
}

export function assertNativeProjectIdle(database: Database.Database, projectId: string): void {
  if (database.prepare(`SELECT 1 FROM orchestration_v2_entities WHERE kind = 'native-control' AND project_id = ?
    AND json_extract(payload_json, '$.state') IN ('running','uncertain') LIMIT 1`).get(projectId)) {
    throw new OrchestrationConflict("cleanup-pending");
  }
}
