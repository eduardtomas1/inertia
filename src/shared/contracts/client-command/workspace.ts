import { z } from "zod";

import {
  requestBase,
  workspaceDirectoryPathSchema,
  workspaceFilePathSchema,
} from "./common";
import { workspaceFileWriteCommandSchema } from "./workspace-file-write";

export const workspaceCommandSchemas = [
  z
    .object({
      ...requestBase,
      type: z.literal("workspace.entries"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          conversationId: z.string().uuid().optional(),
          directory: workspaceDirectoryPathSchema.optional(),
          query: z.string().trim().min(1).max(200).optional(),
        })
        .strict()
        .refine(
          ({ directory, query }) => !(directory && query),
          "Choose either a folder listing or a project search.",
        ),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("workspace.file.read"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid().optional(),
        path: workspaceFilePathSchema,
        fallbackPath: workspaceFilePathSchema.optional(),
      }).strict(),
    })
    .strict(),
  workspaceFileWriteCommandSchema,
  z
    .object({
      ...requestBase,
      type: z.literal("project.actions"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.action.run"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          conversationId: z.string().uuid().optional(),
          actionId: z.string().trim().min(1).max(200),
          terminalId: z.string().uuid(),
          cols: z.number().int().min(20).max(400),
          rows: z.number().int().min(4).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("checkpoint.revert"),
      payload: z.object({
        conversationId: z.string().uuid(),
        checkpointId: z.string().uuid(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("terminal.create"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          conversationId: z.string().uuid().optional(),
          cols: z.number().int().min(20).max(400),
          rows: z.number().int().min(4).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("terminal.attach"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          conversationId: z.string().uuid().optional(),
          terminalId: z.string().uuid(),
          replacementRequestId: z.string().uuid().optional(),
          cols: z.number().int().min(20).max(400),
          rows: z.number().int().min(4).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("terminal.provider.resume"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          conversationId: z.string().uuid(),
          terminalId: z.string().uuid(),
          cols: z.number().int().min(20).max(400),
          rows: z.number().int().min(4).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("terminal.input"),
      payload: z.object({
        terminalId: z.string().uuid(),
        data: z.string().max(8192),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("terminal.resize"),
      payload: z
        .object({
          terminalId: z.string().uuid(),
          cols: z.number().int().min(20).max(400),
          rows: z.number().int().min(4).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("terminal.close"),
      payload: z.object({ terminalId: z.string().uuid() }).strict(),
    })
    .strict(),
] as const;
