import type { DatabaseMigrationDefinition } from "./catalog";
export const issueReportsMigration: DatabaseMigrationDefinition = {
  name: "PersistGuidedIssueReport",
  up: `CREATE TABLE IF NOT EXISTS issue_report_draft (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    report_json TEXT NOT NULL CHECK (length(report_json) <= 100000)
  );`,
};
