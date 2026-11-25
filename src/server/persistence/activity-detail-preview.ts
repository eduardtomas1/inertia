import type { AgentActivity } from "../../shared/contracts";

export const ACTIVITY_DETAIL_PREVIEW_CHARS = 2_048;
export const ACTIVITY_DETAIL_ERROR_EXCERPT_CHARS = 4_096;

const OMISSION = (count: number) => `\n… [${count} or more characters omitted] …\n`;
const ERROR_SECTION = /(?:^|\n)Error:\n/u;

function headLength(value: string, limit: number): number {
  const code = value.charCodeAt(limit - 1);
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit;
}

export function activityDetailPreview(
  activity: Pick<AgentActivity, "kind" | "detail">,
): Pick<AgentActivity, "detail" | "detailBytes" | "detailTruncated"> {
  const { detail } = activity;
  if (detail === null || activity.kind === "error" || detail.length <= ACTIVITY_DETAIL_PREVIEW_CHARS) {
    return { detail };
  }
  const head = detail.slice(0, headLength(detail, ACTIVITY_DETAIL_PREVIEW_CHARS));
  const tracksErrors = activity.kind === "command" || activity.kind === "tool" || activity.kind === "file";
  const errorStart = tracksErrors ? detail.search(ERROR_SECTION) : -1;
  const excerpt = errorStart >= 0 && errorStart + ACTIVITY_DETAIL_ERROR_EXCERPT_CHARS > head.length
    ? detail.slice(Math.max(errorStart, head.length), errorStart + ACTIVITY_DETAIL_ERROR_EXCERPT_CHARS)
    : "";
  const omitted = detail.length - head.length - excerpt.length;
  return {
    detail: excerpt ? `${head}${omitted > 0 ? OMISSION(omitted) : ""}${excerpt}` : head,
    detailBytes: new TextEncoder().encode(detail).byteLength,
    detailTruncated: true,
  };
}
