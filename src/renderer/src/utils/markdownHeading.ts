export const MARKDOWN_HEADING_DOM_PREFIX = "user-content-";

export function markdownHeadingDomId(slug: string): string {
  return `${MARKDOWN_HEADING_DOM_PREFIX}${slug}`;
}
