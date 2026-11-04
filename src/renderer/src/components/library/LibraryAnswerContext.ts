import { createContext, useContext } from "react";
import type { ServerEvent } from "@shared/contracts";
import type { LibrarySnapshot, SavedAnswer } from "@shared/library";

import type { CommandWithoutId } from "../../lib/runtimeCommands";

export interface LibraryAnswerController {
  library: LibrarySnapshot | null;
  savedByMessageId: ReadonlyMap<string, SavedAnswer>;
  online: boolean;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  onError: (message: string) => void;
}

export const LIBRARY_NAVIGATION_COPY = {
  unavailable: "This is no longer in its chat.",
  failed: "This could not be opened. Try again from the Library.",
};

const NO_SAVED_ANSWERS: ReadonlyMap<string, SavedAnswer> = new Map();

export function savedAnswersByMessage(library: LibrarySnapshot | null | undefined): ReadonlyMap<string, SavedAnswer> {
  if (!library?.savedAnswers.length) return NO_SAVED_ANSWERS;
  return new Map(library.savedAnswers.map((answer) => [answer.messageId, answer]));
}

export const LibraryAnswerContext = createContext<LibraryAnswerController | null>(null);

export function useLibraryAnswers(): LibraryAnswerController | null {
  return useContext(LibraryAnswerContext);
}
