import { z } from "zod";

import { MAX_WORKSPACE_FILE_EDIT_BYTES } from "../workspace";
import {
  requestBase,
  workspaceFilePathSchema,
} from "./common";

export const workspaceFileWriteCommandSchema = z
  .object({
    ...requestBase,
    type: z.literal("workspace.file.write"),
    payload: z.object({
      projectId: z.string().uuid(),
      conversationId: z.string().uuid().optional(),
      path: workspaceFilePathSchema,
      authorityRef: z.string().uuid(),
      expectedDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      content: z
        .string()
        .max(MAX_WORKSPACE_FILE_EDIT_BYTES)
        .refine(
          (value) => new TextEncoder().encode(value).byteLength
            <= MAX_WORKSPACE_FILE_EDIT_BYTES,
          "The file content exceeds the workspace editing limit.",
        ),
    }).strict(),
  })
  .strict();
