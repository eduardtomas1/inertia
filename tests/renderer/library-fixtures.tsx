import type { ServerEvent } from "../../src/shared/contracts";
import type { LibraryCategory, LibraryPage, LibrarySnapshot, SavedAnswer } from "../../src/shared/library";
import { conversationId, firstProjectId, otherConversationId, stamp } from "./tasks-fixtures";

export const researchId = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
export const recipesId = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
export const createdCategoryId = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
export const missingConversationId = "99999999-9999-4999-8999-999999999999";

export function category(id: string, name: string): LibraryCategory {
  return { id, name, createdAt: stamp, updatedAt: stamp };
}

let answerSequence = 0;

export function savedAnswer(overrides: Partial<SavedAnswer> = {}): SavedAnswer {
  answerSequence += 1;
  const suffix = String(answerSequence).padStart(12, "0");
  return {
    id: `d4d4d4d4-d4d4-4d4d-8d4d-${suffix}`,
    conversationId,
    projectId: firstProjectId,
    turnId: `turn-${answerSequence}`,
    messageId: `message-${answerSequence}`,
    categoryId: null,
    title: `Saved answer ${answerSequence}`,
    excerpt: "An excerpt of the answer.",
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}

export function library(categories: LibraryCategory[], savedAnswers: SavedAnswer[]): LibrarySnapshot {
  return {
    categories: [...categories].sort((left, right) => left.name.localeCompare(right.name)),
    savedAnswers,
  };
}

export function page(overrides: Partial<LibraryPage> = {}): LibraryPage {
  return {
    renderId: "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5",
    title: "Treatment comparison",
    height: 320,
    conversationId: otherConversationId,
    conversationTitle: "Compare treatments",
    projectId: firstProjectId,
    turnId: "page-turn",
    messageId: "page-message",
    createdAt: stamp,
    archived: false,
    ...overrides,
  };
}

export function result(value: Extract<ServerEvent, { type: "request.result" }>["result"]): ServerEvent {
  return { type: "request.result", requestId: "request", result: value };
}
