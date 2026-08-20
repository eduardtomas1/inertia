export const MARKDOWN_HEADING_DOM_PREFIX = "user-content-";

export interface MarkdownHeadingRequest {
  path: string;
  headingId: string;
  requestId: number;
}

export function markdownHeadingDomId(slug: string): string {
  return `${MARKDOWN_HEADING_DOM_PREFIX}${slug}`;
}
