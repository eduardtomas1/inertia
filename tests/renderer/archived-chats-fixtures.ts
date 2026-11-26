import { vi } from "vitest";

import type { Conversation } from "../../src/shared/contracts";
import {
  ARCHIVED_CONVERSATIONS_PAGE_SIZE,
  type ArchivedConversationsPage,
  type ArchivedConversationsRequest,
} from "../../src/shared/archived-conversations";

export function archivedLoader(chats: readonly Conversation[]) {
  return vi.fn(async (request: ArchivedConversationsRequest): Promise<ArchivedConversationsPage> => {
    const needle = request.query?.trim().toLowerCase() ?? "";
    const matches = chats
      .filter((chat) => chat.archivedAt !== null)
      .filter((chat) => !needle || chat.title.toLowerCase().includes(needle) || (request.providerIds ?? []).includes(chat.providerId))
      .sort((left, right) => right.archivedAt!.localeCompare(left.archivedAt!) || left.id.localeCompare(right.id));
    const after = request.after;
    const start = after
      ? matches.findIndex((chat) => chat.archivedAt! < after.archivedAt || (chat.archivedAt === after.archivedAt && chat.id > after.id))
      : 0;
    const limit = request.limit ?? ARCHIVED_CONVERSATIONS_PAGE_SIZE;
    const page = start < 0 ? [] : matches.slice(start, start + limit);
    const last = page.at(-1);
    return {
      kind: "conversation.archived",
      conversations: page,
      total: matches.length,
      next: last && start + limit < matches.length ? { archivedAt: last.archivedAt!, id: last.id } : null,
    };
  });
}

export function archivedChatsProps(chats: readonly Conversation[]) {
  return { archivedCount: chats.length, onLoadArchived: archivedLoader(chats) };
}
