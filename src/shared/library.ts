import { z } from "zod";

export const MAX_LIBRARY_CATEGORIES = 100;
export const MAX_SAVED_ANSWERS = 1_000;
export const MAX_LIBRARY_PAGES = 500;
export const MAX_LIBRARY_CATEGORY_NAME_CHARS = 60;
export const MAX_SAVED_ANSWER_TITLE_CHARS = 120;
export const MAX_SAVED_ANSWER_EXCERPT_CHARS = 200;
export const MAX_LIBRARY_IDENTIFIER_CHARS = 128;
export const MAX_LIBRARY_SERIALIZED_BYTES = 1_024 * 1_024;
export const SAVED_ANSWER_FALLBACK_TITLE = "Saved answer";

const timestampSchema = z.string().datetime({ offset: true });
const identifierSchema = z.string().min(1).max(MAX_LIBRARY_IDENTIFIER_CHARS);
const singleLine = (value: string): boolean => !/[\0\r\n]/u.test(value);

export const libraryCategoryNameSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_LIBRARY_CATEGORY_NAME_CHARS)
  .refine(singleLine, "Category names must stay on one line.");

export const savedAnswerTitleSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_SAVED_ANSWER_TITLE_CHARS)
  .refine(singleLine, "Saved answer titles must stay on one line.");

export const savedAnswerExcerptSchema = z.string()
  .max(MAX_SAVED_ANSWER_EXCERPT_CHARS)
  .refine(singleLine, "Saved answer excerpts must stay on one line.");

export const libraryCategorySchema = z.object({
  id: z.string().uuid(),
  name: libraryCategoryNameSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const savedAnswerSchema = z.object({
  id: z.string().uuid(),
  conversationId: identifierSchema,
  projectId: identifierSchema,
  turnId: identifierSchema,
  messageId: identifierSchema,
  categoryId: z.string().uuid().nullable(),
  title: savedAnswerTitleSchema,
  excerpt: savedAnswerExcerptSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const librarySnapshotSchema = z.object({
  categories: z.array(libraryCategorySchema).max(MAX_LIBRARY_CATEGORIES),
  savedAnswers: z.array(savedAnswerSchema).max(MAX_SAVED_ANSWERS),
}).strict();

export const libraryPageSchema = z.object({
  renderId: z.string().uuid(),
  title: z.string().min(1).max(MAX_SAVED_ANSWER_TITLE_CHARS),
  height: z.number().int().positive().nullable(),
  conversationId: identifierSchema,
  conversationTitle: z.string(),
  projectId: identifierSchema,
  turnId: identifierSchema,
  messageId: identifierSchema.nullable(),
  createdAt: z.string().min(1),
  archived: z.boolean(),
}).strict();

export const libraryPagesSchema = z.array(libraryPageSchema)
  .max(MAX_LIBRARY_PAGES)
  .refine((pages) => new Set(pages.map(({ renderId }) => renderId)).size === pages.length, "Rendered pages must be unique.");

export const savedAnswerPatchSchema = z.object({
  categoryId: z.string().uuid().nullable().optional(),
  title: savedAnswerTitleSchema.optional(),
}).strict().refine(
  (patch) => patch.categoryId !== undefined || patch.title !== undefined,
  "A saved answer update must change at least one field.",
);

const libraryCategoryResultSchema = z.object({
  kind: z.literal("library.category"),
  category: libraryCategorySchema,
}).strict();

const savedAnswerResultSchema = z.object({
  kind: z.literal("library.answer"),
  savedAnswer: savedAnswerSchema,
}).strict();

const libraryPagesResultSchema = z.object({
  kind: z.literal("library.pages"),
  pages: libraryPagesSchema,
}).strict();

export const libraryRequestResultValidators = {
  "library.category": (value: unknown) => libraryCategoryResultSchema.safeParse(value).success,
  "library.answer": (value: unknown) => savedAnswerResultSchema.safeParse(value).success,
  "library.pages": (value: unknown) => libraryPagesResultSchema.safeParse(value).success,
} as const;

export type LibraryCategory = z.infer<typeof libraryCategorySchema>;
export type SavedAnswer = z.infer<typeof savedAnswerSchema>;
export type LibrarySnapshot = z.infer<typeof librarySnapshotSchema>;
export type LibraryPage = z.infer<typeof libraryPageSchema>;
export type SavedAnswerPatch = z.infer<typeof savedAnswerPatchSchema>;

export function libraryCategoryNameKey(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}

export function truncateLibraryText(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  let head = value.slice(0, Math.max(0, maximum - 1));
  if (/[\uD800-\uDBFF]$/u.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}

const MAX_NORMALIZED_LINE_CHARS = 1_000;

const INLINE_MARKDOWN: readonly (readonly [RegExp, string])[] = [
  [/!?\[([^\n[\]]*)\]\([^()\n]*\)/gu, "$1"],
  [/!?\[([^\n[\]]+)\]\[[^\n[\]]*\]/gu, "$1"],
  [/(?<!`)(`+)([^`\n]+?)\1(?!`)/gu, "$2"],
  [/\*\*(?=\S)((?:[^*\n]|\*(?!\*))*?\S)\*\*/gu, "$1"],
  [/__(?=\S)((?:[^_\n]|_(?!_))*?\S)__/gu, "$1"],
  [/(?<![\w*])\*(?=\S)([^\n*]*?\S)\*(?![\w*])/gu, "$1"],
  [/(?<![\w_])_(?=\S)([^\n_]*?\S)_(?![\w_])/gu, "$1"],
  [/~~(?=\S)([^\n~]*?\S)~~/gu, "$1"],
  [/<\/?[A-Za-z][^<>\n]*>/gu, ""],
];

function boundedLine(line: string): string {
  if (line.length <= MAX_NORMALIZED_LINE_CHARS) return line;
  const head = line.slice(0, MAX_NORMALIZED_LINE_CHARS);
  return /[\uD800-\uDBFF]$/u.test(head) ? head.slice(0, -1) : head;
}

function plainMarkdownLine(line: string): string {
  if (/^\s{0,3}(?:`{3,}|~{3,})/u.test(line)) return "";
  if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line)) return "";
  if (/^\s*(?:\|\s*)?:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*(?:\|\s*)?$/u.test(line)) return "";
  let text = line
    .replace(/^\s{0,3}(?:>\s?)+/u, "")
    .replace(/^\s{0,3}#{1,6}(?:\s+|$)/u, "")
    .replace(/(?<!\s)\s+#+\s*$/u, "")
    .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/u, "");
  for (const [pattern, replacement] of INLINE_MARKDOWN) text = text.replace(pattern, replacement);
  return text.replace(/\|/gu, " ").replace(/\\([\\`*_{}[\]()#+\-.!|~>])/gu, "$1");
}

function collapse(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function* plainTextLines(markdown: string): Generator<string> {
  const pattern = /[^\r\n]*(?:\r\n?|\n|$)/gu;
  const text = markdown.replace(/\0/gu, "");
  for (let match = pattern.exec(text); match && match.index < text.length; match = pattern.exec(text)) {
    const line = collapse(plainMarkdownLine(boundedLine(match[0].replace(/[\r\n]+$/u, ""))));
    if (line) yield line;
  }
}

function firstPlainLine(markdown: string): string | null {
  for (const line of plainTextLines(markdown)) return line;
  return null;
}

export function savedAnswerExcerpt(answer: string): string {
  const lines: string[] = [];
  let length = 0;
  for (const line of plainTextLines(answer)) {
    lines.push(line);
    length += line.length + 1;
    if (length > MAX_SAVED_ANSWER_EXCERPT_CHARS) break;
  }
  return truncateLibraryText(lines.join(" "), MAX_SAVED_ANSWER_EXCERPT_CHARS);
}

export function savedAnswerDefaultTitle(request: string, answer = ""): string {
  const line = firstPlainLine(request) ?? firstPlainLine(answer) ?? SAVED_ANSWER_FALLBACK_TITLE;
  return truncateLibraryText(line, MAX_SAVED_ANSWER_TITLE_CHARS);
}

export function librarySerializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function emptyLibrarySnapshot(): LibrarySnapshot {
  return { categories: [], savedAnswers: [] };
}
