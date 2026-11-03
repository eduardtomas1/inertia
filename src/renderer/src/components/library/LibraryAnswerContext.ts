import { createContext, useContext } from "react";
import type { ServerEvent } from "@shared/contracts";
import type { LibrarySnapshot } from "@shared/library";

import type { CommandWithoutId } from "../../lib/runtimeCommands";

export interface LibraryAnswerController {
  library: LibrarySnapshot | null;
  online: boolean;
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  onError: (message: string) => void;
}

export const LIBRARY_NAVIGATION_COPY = {
  unavailable: "This is no longer in its chat.",
  failed: "This could not be opened. Try again from the Library.",
};

export const LibraryAnswerContext = createContext<LibraryAnswerController | null>(null);

export function useLibraryAnswers(): LibraryAnswerController | null {
  return useContext(LibraryAnswerContext);
}
