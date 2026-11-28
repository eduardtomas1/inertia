import type { AgentActivity } from "../../shared/contracts";
import type { ActivityRow } from "./rows";

export const ACTIVITY_DETAIL_PREVIEW_CHARS = 2_048;
export const ACTIVITY_DETAIL_ERROR_EXCERPT_CHARS = 4_096;

const OMISSION = (count: number) => `\n… [${count} or more characters omitted] …\n`;

const ASCII_PREVIEW_INNER_SQL = `
  activities.id,
  activities.conversation_id,
  activities.run_id,
  activities.turn_id,
  activities.kind,
  activities.title,
  activities.detail,
  activities.status,
  activities.created_at,
  octet_length(activities.detail) AS detail_bytes,
  CASE
    WHEN activities.detail IS NOT NULL
      AND activities.kind NOT IN ('error', 'command', 'tool', 'file')
      AND octet_length(activities.detail) > ${ACTIVITY_DETAIL_PREVIEW_CHARS}
      AND octet_length(substr(activities.detail, 1, ${ACTIVITY_DETAIL_PREVIEW_CHARS + 1})) = ${ACTIVITY_DETAIL_PREVIEW_CHARS + 1}
      AND length(substr(activities.detail, 1, ${ACTIVITY_DETAIL_PREVIEW_CHARS + 1})) = ${ACTIVITY_DETAIL_PREVIEW_CHARS + 1}
      THEN 1
    ELSE 0
  END AS detail_projected
`;

/**
 * Builds a single-pass SQLite query that projects long non-error-excerpt
 * activity rows inside SQLite without reading overflow pages into V8, while
 * returning O(1) `octet_length(detail)` for every row so JavaScript never
 * needs to re-encode details to measure UTF-8 byte lengths. Command/tool/file
 * rows pass through to JavaScript's SIMD `indexOf` error-section scanner so
 * embedded NUL bytes and UTF-16 surrogates always match `activityDetailPreview`
 * identically without paying SQLite's slow UTF-8 `instr()` scan.
 */
export function buildActivityPreviewQuery(whereSql: string, orderSql: string): string {
  return `
    SELECT
      id,
      conversation_id,
      run_id,
      turn_id,
      kind,
      title,
      CASE
        WHEN detail_projected = 1 THEN substr(detail, 1, ${ACTIVITY_DETAIL_PREVIEW_CHARS})
        ELSE detail
      END AS detail,
      detail_bytes,
      detail_projected,
      status,
      created_at
    FROM (
      SELECT ${ASCII_PREVIEW_INNER_SQL}
      FROM activities
      WHERE ${whereSql}
      ORDER BY ${orderSql}
    )
  `;
}

export interface ProjectedActivityRow extends ActivityRow {
  detail_bytes: number | null;
  detail_projected: number;
}

function headLength(value: string, limit: number): number {
  const code = value.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

function findErrorSectionStart(detail: string): number {
  if (detail.startsWith("Error:\n")) return 0;
  return detail.indexOf("\nError:\n");
}

function buildActivityDetailPreview(
  activity: Pick<AgentActivity, "kind" | "detail">,
  knownDetailBytes?: number | null,
): Pick<AgentActivity, "detail" | "detailBytes" | "detailTruncated"> {
  const { detail } = activity;
  if (detail === null || activity.kind === "error" || detail.length <= ACTIVITY_DETAIL_PREVIEW_CHARS) {
    return { detail };
  }
  const head = detail.slice(0, headLength(detail, ACTIVITY_DETAIL_PREVIEW_CHARS));
  const tracksErrors = activity.kind === "command" || activity.kind === "tool" || activity.kind === "file";
  const errorStart = tracksErrors ? findErrorSectionStart(detail) : -1;
  const excerpt = errorStart >= 0 && errorStart + ACTIVITY_DETAIL_ERROR_EXCERPT_CHARS > head.length
    ? detail.slice(Math.max(errorStart, head.length), errorStart + ACTIVITY_DETAIL_ERROR_EXCERPT_CHARS)
    : "";
  const omitted = detail.length - head.length - excerpt.length;
  return {
    detail: excerpt ? `${head}${omitted > 0 ? OMISSION(omitted) : ""}${excerpt}` : head,
    detailBytes: knownDetailBytes ?? Buffer.byteLength(detail, "utf8"),
    detailTruncated: true,
  };
}

export function activityDetailPreview(
  activity: Pick<AgentActivity, "kind" | "detail">,
): Pick<AgentActivity, "detail" | "detailBytes" | "detailTruncated"> {
  return buildActivityDetailPreview(activity);
}

export function activityPreviewFromProjectedRow(
  row: ProjectedActivityRow,
): Pick<AgentActivity, "detail" | "detailBytes" | "detailTruncated"> {
  if (row.detail_projected !== 1 || row.detail === null || row.detail_bytes === null) {
    return buildActivityDetailPreview({ kind: row.kind, detail: row.detail }, row.detail_bytes);
  }
  return {
    detail: row.detail,
    detailBytes: row.detail_bytes,
    detailTruncated: true,
  };
}
