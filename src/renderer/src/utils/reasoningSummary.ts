export interface ReasoningSummarySegment {
  id: string;
  title: string | null;
  body: string;
}

const SEGMENT_PATTERN = /\*\*([^*]+?)\*\*/gu;

export function parseReasoningSummary(
  content: string,
): ReasoningSummarySegment[] {
  const text = content.replace(/\r\n?/gu, "\n");
  const segments: ReasoningSummarySegment[] = [];
  let lastIndex = 0;
  let pendingTitle: string | null = null;
  SEGMENT_PATTERN.lastIndex = 0;
  for (
    let match = SEGMENT_PATTERN.exec(text);
    match !== null;
    match = SEGMENT_PATTERN.exec(text)
  ) {
    const body = text.slice(lastIndex, match.index).trim();
    if (pendingTitle !== null || body) {
      segments.push({
        id: `${segments.length}`,
        title: pendingTitle,
        body,
      });
    }
    pendingTitle = match[1]!.trim();
    lastIndex = match.index + match[0].length;
  }
  const trailing = text.slice(lastIndex).trim();
  if (pendingTitle !== null || trailing) {
    segments.push({
      id: `${segments.length}`,
      title: pendingTitle,
      body: trailing,
    });
  }
  if (!segments.some(({ title }) => title !== null)) return [];
  return segments.filter(({ title, body }) => title !== null || body.length > 0);
}
