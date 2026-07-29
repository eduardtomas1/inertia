const COLLAPSE_CHARACTER_THRESHOLD = 1_200;
const COLLAPSE_LINE_THRESHOLD = 18;
const PREVIEW_CHARACTER_LIMIT = 720;
const PREVIEW_LINE_LIMIT = 10;

export function shouldCollapseUserRequest(content: string): boolean {
  return content.length > COLLAPSE_CHARACTER_THRESHOLD
    || content.split(/\r?\n/u).length > COLLAPSE_LINE_THRESHOLD;
}

export function collapsedUserRequestPreview(content: string): string {
  if (!shouldCollapseUserRequest(content)) return content;
  const lineBounded = content.split(/\r?\n/u).slice(0, PREVIEW_LINE_LIMIT).join("\n");
  if (lineBounded.length <= PREVIEW_CHARACTER_LIMIT) {
    return `${lineBounded.trimEnd()}…`;
  }
  const candidate = lineBounded.slice(0, PREVIEW_CHARACTER_LIMIT);
  const wordBoundary = candidate.lastIndexOf(" ");
  const end = wordBoundary >= PREVIEW_CHARACTER_LIMIT * 0.7
    ? wordBoundary
    : candidate.length;
  return `${candidate.slice(0, end).trimEnd()}…`;
}
