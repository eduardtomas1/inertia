import type { DatabaseMigrationDefinition } from "./catalog";
export const issueReportPreviewMigration: DatabaseMigrationDefinition = {
  name: "PersistIssueReportPreview",
  up: `UPDATE issue_report_draft
    SET report_json = json_set(
      json_remove(report_json, '$.selection', '$.answer', '$.evidence', '$.projectId'),
      '$.status', CASE WHEN json_extract(report_json, '$.status') IN ('draft', 'validating', 'cancelled', 'failed') THEN 'preview' ELSE json_extract(report_json, '$.status') END,
      '$.notice', CASE WHEN json_extract(report_json, '$.status') IN ('draft', 'validating', 'cancelled', 'failed') THEN '' ELSE json_extract(report_json, '$.notice') END,
      '$.steps', '',
      '$.providerId', json('null'),
      '$.attachDiagnostics', json('false')
    )
    WHERE json_valid(report_json) AND json_type(report_json) = 'object';`,
};
