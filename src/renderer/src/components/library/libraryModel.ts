import type { ConversationShell, Project } from "@shared/contracts";
import type { LibraryCategory, LibraryPage, LibrarySnapshot, SavedAnswer } from "@shared/library";
import type { MessageSearchTarget } from "@shared/message-search";

export type LibraryFilter = { kind: "all" } | { kind: "unsorted" } | { kind: "category"; id: string };

export interface SavedAnswerEntry {
  answer: SavedAnswer;
  conversation: ConversationShell;
  projectName: string | null;
  category: LibraryCategory | null;
}

export interface LibraryCounts {
  all: number;
  unsorted: number;
  byCategory: ReadonlyMap<string, number>;
}

export function savedAnswerEntries(
  library: LibrarySnapshot | null | undefined,
  conversations: readonly ConversationShell[],
  projects: readonly Pick<Project, "id" | "name">[],
): SavedAnswerEntry[] {
  if (!library) return [];
  const conversationsById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const projectNames = new Map(projects.map(({ id, name }) => [id, name]));
  const categories = new Map(library.categories.map((category) => [category.id, category]));
  return library.savedAnswers.flatMap((answer) => {
    const conversation = conversationsById.get(answer.conversationId);
    if (!conversation) return [];
    return [{
      answer,
      conversation,
      projectName: projectNames.get(conversation.projectId) ?? null,
      category: answer.categoryId ? categories.get(answer.categoryId) ?? null : null,
    }];
  });
}

export function libraryCounts(entries: readonly SavedAnswerEntry[]): LibraryCounts {
  const byCategory = new Map<string, number>();
  let unsorted = 0;
  for (const { category } of entries) {
    if (category) byCategory.set(category.id, (byCategory.get(category.id) ?? 0) + 1);
    else unsorted += 1;
  }
  return { all: entries.length, unsorted, byCategory };
}

export function inLibraryFilter(entry: SavedAnswerEntry, filter: LibraryFilter): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "unsorted") return entry.category === null;
  return entry.category?.id === filter.id;
}

function normalized(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase();
}

export function matchesLibraryQuery(fields: readonly (string | null)[], query: string): boolean {
  const terms = normalized(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = normalized(fields.filter((field): field is string => Boolean(field)).join(" \n "));
  return terms.every((term) => haystack.includes(term));
}

export function savedAnswerMatches(entry: SavedAnswerEntry, query: string): boolean {
  return matchesLibraryQuery([
    entry.answer.title,
    entry.answer.excerpt,
    entry.conversation.title,
    entry.projectName,
    entry.category?.name ?? null,
  ], query);
}

export function libraryPageMatches(page: LibraryPage, query: string): boolean {
  return matchesLibraryQuery([page.title, page.conversationTitle], query);
}

export function savedAnswerTarget(entry: Pick<SavedAnswerEntry, "answer" | "conversation">): MessageSearchTarget {
  return {
    projectId: entry.conversation.projectId,
    conversationId: entry.answer.conversationId,
    turnId: entry.answer.turnId,
    messageId: entry.answer.messageId,
  };
}

export function libraryFilterName(filter: LibraryFilter, categories: readonly LibraryCategory[]): string {
  if (filter.kind === "all") return "All";
  if (filter.kind === "unsorted") return "Unsorted";
  return categories.find(({ id }) => id === filter.id)?.name ?? "All";
}

export function pageThumbnailSeed(renderId: string): number[] {
  let hash = 2166136261;
  for (const character of renderId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return Array.from({ length: 6 }, (_, index) => ((hash >>> (index * 5)) & 31) / 31);
}

export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
