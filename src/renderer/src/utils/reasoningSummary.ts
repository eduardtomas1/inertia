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

export interface ReasoningLine {
  id: string;
  text: string;
}

export function latestReasoningLine(content: string): ReasoningLine {
  const segments = parseReasoningSummary(content);
  const latest = segments.at(-1);
  const source = latest ? latest.body || latest.title || "" : content;
  const lines = source
    .split("\n")
    .map((line) => line.replaceAll("**", "").trim())
    .filter(Boolean);
  const sentences = (lines.at(-1) ?? "").split(/(?<=[.!?])\s+/u).filter(Boolean);
  return {
    id: `${segments.length}:${latest?.body ? "body" : "title"}:${lines.length}:${sentences.length}`,
    text: sentences.at(-1) ?? "",
  };
}
