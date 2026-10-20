import type { ChangedFile } from "@shared/contracts";

/** Git's conventional subject length; shown as a hint, never enforced. */
export const COMMIT_SUBJECT_SOFT_LIMIT = 72;
export const COMMIT_MESSAGE_MAX_LENGTH = 10_000;
const MAX_LISTED_FILES = 50;

export type CommitDraftFile = Pick<ChangedFile, "path" | "status" | "untracked">;

export interface CommitDraftInput {
  /** Overall text of the chat's review summary for this change set, if any. */
  summary?: string | null;
  files: readonly CommitDraftFile[];
  selectedPaths: readonly string[];
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  added: "Added",
  untracked: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  "type-changed": "Type changed",
  unmerged: "Unmerged",
};

function statusLabel(file: CommitDraftFile): string {
  if (file.untracked) return "Added";
  return STATUS_LABELS[file.status] ?? "Changed";
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function fromSummary(summary: string): string | null {
  const text = summary.trim();
  if (!text) return null;
  const match = /^([\s\S]*?[.!?])(?=\s|$)/u.exec(text);
  const sentence = match?.[1] ?? text;
  const subject = singleLine(sentence).replace(/\.$/u, "");
  if (!subject) return null;
  const body = text.slice(sentence.length).trim();
  return body ? `${subject}\n\n${body}` : subject;
}

function commonFolder(paths: readonly string[]): string {
  const folders = paths.map((path) => path.split("/").slice(0, -1));
  const [first, ...rest] = folders;
  if (!first) return "";
  let length = first.length;
  for (const folder of rest) {
    let index = 0;
    while (index < length && folder[index] === first[index]) index += 1;
    length = index;
  }
  return first.slice(0, length).join("/");
}

function fromPaths(files: readonly CommitDraftFile[]): string | null {
  if (files.length === 0) return null;
  const paths = files.map((file) => file.path);
  const folder = commonFolder(paths);
  const subject = files.length === 1
    ? `Update ${paths[0]}`
    : folder
      ? `Update ${folder}`
      : `Update ${files.length} files`;
  const listed = files.slice(0, MAX_LISTED_FILES)
    .map((file) => `- ${statusLabel(file)}: ${file.path}`);
  if (files.length > MAX_LISTED_FILES) {
    listed.push(`- …and ${files.length - MAX_LISTED_FILES} more`);
  }
  return `${subject}\n\n${listed.join("\n")}`;
}

/**
 * Builds a commit message from local evidence only. A chat review summary
 * supplies the subject (its first sentence) and body (the rest); otherwise the
 * subject names the selected files' common folder or count and the body lists
 * each selected file with its status. Returns "" when nothing is available.
 */
export function draftCommitMessage(input: CommitDraftInput): string {
  const selected = new Set(input.selectedPaths);
  const draft = (input.summary ? fromSummary(input.summary) : null)
    ?? fromPaths(input.files.filter((file) => selected.has(file.path)))
    ?? "";
  return draft.slice(0, COMMIT_MESSAGE_MAX_LENGTH);
}

/** The first line of a commit message, which Git treats as its subject. */
export function commitSubject(message: string): string {
  return message.split(/\r?\n/u, 1)[0] ?? "";
}
