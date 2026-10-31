import { z } from "zod";

import { MAX_TERMINAL_PATH_TEXT_LENGTH } from "../terminal-links";
import { requestBase } from "./common";

function withoutControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

export const terminalLinkCommandSchemas = [
  z
    .object({
      ...requestBase,
      type: z.literal("workspace.path.resolve"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid().optional(),
        /** A path token seen in terminal output, optionally ending in `:line[:column]`. */
        text: z.string()
          .min(1)
          .max(MAX_TERMINAL_PATH_TEXT_LENGTH)
          .refine(withoutControlCharacters, "Invalid terminal path."),
      }).strict(),
    })
    .strict(),
] as const;
