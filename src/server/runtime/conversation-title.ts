import { withoutPotentialSkillInvocations } from "./agent-skill-invocation";

export const QUICK_TITLE_SCANNED_CHARS = 16_384;
const MAX_TITLE_WORDS = 6;
const MAX_TITLE_CHARACTERS = 60;
const UNTITLED_TITLES = new Set(["New chat", "New thread"]);
const GENERIC_TITLES = new Set([
  "new chat",
  "new thread",
  "untitled",
  "chat",
  "conversation",
]);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function characters(text: string): string[] {
  return Array.from(graphemes.segment(text), ({ segment }) => segment);
}

function plainLine(line: string): string {
  return line.replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
}

function lines(text: string): string[] {
  return text.split(/\r\n|\r|\n/u);
}

function boundedTitle(text: string): string {
  const words = text.split(" ").slice(0, MAX_TITLE_WORDS);
  let title = "";
  for (const word of words) {
    const candidate = title ? `${title} ${word}` : word;
    if (characters(candidate).length > MAX_TITLE_CHARACTERS) break;
    title = candidate;
  }
  return title
    || characters(words[0] ?? "").slice(0, MAX_TITLE_CHARACTERS).join("");
}

function proseLines(text: string): string[] {
  const prose: string[] = [];
  let fence: string | undefined;
  for (const line of lines(text)) {
    const opener = /^[ \t]*(```|~~~)/u.exec(line)?.[1];
    if (opener && (fence === undefined || fence === opener)) {
      fence = fence === undefined ? opener : undefined;
    } else if (fence === undefined) {
      prose.push(line);
    }
  }
  return prose;
}

export function quickConversationTitle(content: string): string {
  for (const line of proseLines(content.slice(0, QUICK_TITLE_SCANNED_CHARS))) {
    const text = plainLine(withoutPotentialSkillInvocations(
      line
        .replace(/`([^`]*)`/gu, "$1")
        .replace(/\b[a-z][a-z\d+.-]*:\/\/\S+/giu, " "),
    ));
    const title = boundedTitle(text).replace(/[\s.,:;]+$/u, "");
    if (title) return title;
  }
  return "";
}

export function normalizeGeneratedTitle(text: string): string | undefined {
  const unwrapped = text
    .replace(/<(think|analysis)>[\s\S]*?(?:<\/\1>|$)/giu, "\n")
    .replace(/<\/?(?:think|analysis)>/giu, "\n")
    .replace(/^[ \t]*(?:```|~~~).*$/gmu, "\n");
  const line = lines(unwrapped).map(plainLine).find(Boolean) ?? "";
  const unquoted = line
    .replaceAll("`", "")
    .replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s.]+$/gu, "");
  const title = boundedTitle(plainLine(unquoted)).replace(/[\s.]+$/u, "");
  if (!title || GENERIC_TITLES.has(title.toLowerCase())) return undefined;
  return title;
}

export function isUntitledConversationTitle(title: string): boolean {
  return UNTITLED_TITLES.has(title);
}
