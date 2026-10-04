import type { DatabaseMigrationDefinition } from "./catalog";
export const issueReportPreviewMigration: DatabaseMigrationDefinition = {
  name: "PersistIssueReportPreview",
  up: `UPDATE issue_report_draft
    SET report_json = json_set(report_json, '$.body', CASE
      WHEN json_type(report_json, '$.description') = 'text' AND trim(json_extract(report_json, '$.description')) <> ''
        THEN '## What happened' || char(10, 10) || trim(json_extract(report_json, '$.description')) || char(10, 10)
          || '## Steps to reproduce' || char(10, 10) || 'Not provided.' || char(10, 10)
          || '## Environment' || char(10, 10) || 'Not collected. This report was saved by an earlier version of Inertia.' || char(10, 10)
          || '## Diagnostics' || char(10, 10) || 'Not attached.'
      ELSE '' END)
    WHERE json_valid(report_json) AND json_type(report_json) = 'object'
      AND json_extract(report_json, '$.status') IN ('draft', 'validating', 'cancelled', 'failed', 'preview');
  UPDATE issue_report_draft
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
