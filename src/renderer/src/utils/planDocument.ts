const HEADING = /^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/u;
const PLAN_PREFIX = /^plan\s*[:\-–—]\s*/iu;
const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/gu;

export type PlanDocument = { title: string | null; body: string };
export type PlanInlineSegment = { kind: "text" | "code" | "strong"; text: string };

export function planDocument(markdown: string): PlanDocument {
  const lines = markdown.trim().split(/\r?\n/u);
  const heading = lines[0]?.match(HEADING)?.[1]?.replace(PLAN_PREFIX, "").trim();
  if (!heading) return { title: null, body: lines.join("\n") };
  return {
    title: heading.charAt(0).toLocaleUpperCase() + heading.slice(1),
    body: lines.slice(1).join("\n").trim(),
  };
}

export function planDocumentIsLong(body: string): boolean {
  return body.length > 900 || body.split("\n").length > 20;
}

export function planInlineSegments(text: string): PlanInlineSegment[] {
  const segments: PlanInlineSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > cursor) segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    segments.push(match[1] !== undefined
      ? { kind: "code", text: match[1] }
      : { kind: "strong", text: match[2]! });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  return segments;
}
