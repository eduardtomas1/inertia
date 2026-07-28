import { z } from "zod";

import {
  diffReviewSelectionSchema,
  requestBase,
} from "./common";

const projectWithOptionalConversation = {
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
};

export const gitCommandSchemas = [
  z
    .object({
      ...requestBase,
      type: z.literal("git.refresh"),
      payload: z.object(projectWithOptionalConversation).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.diff"),
      payload: z
        .object({
          ...projectWithOptionalConversation,
          path: z.string().max(512).optional(),
          ignoreWhitespace: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.workspace.refresh"),
      payload: z.object(projectWithOptionalConversation).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.workspace.diff"),
      payload: z
        .object({
          ...projectWithOptionalConversation,
          repositoryPath: z.string().min(1).max(4096),
          path: z.string().min(1).max(4096).optional(),
          ignoreWhitespace: z.boolean().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.turn.diff"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid(),
        turnId: z.string().min(1).max(200),
        path: z.string().min(1).max(4096).optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.turn.compare"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid(),
        earlierTurnId: z.string().min(1).max(200),
        laterTurnId: z.string().min(1).max(200),
        path: z.string().min(1).max(4096).optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.selection.inspect"),
      payload: z.object({
        ...projectWithOptionalConversation,
        repositoryPath: z.string().min(1).max(4096).optional(),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        filePath: z.string().min(1).max(4096),
        hunkId: z.string().min(1).max(128),
        lineIds: z.array(z.string().min(1).max(160)).min(1).max(500),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.selection.revert"),
      payload: z.object({
        ...projectWithOptionalConversation,
        repositoryPath: z.string().min(1).max(4096).optional(),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        filePath: z.string().min(1).max(4096),
        hunkId: z.string().min(1).max(128),
        lineIds: z.array(z.string().min(1).max(160)).min(1).max(500),
        expected: z.object({
          diffFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
          fileFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
          hunkFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
          selectionFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
          gitStateFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        }).strict(),
        comment: z.string().trim().max(2_000).optional(),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.selection.undo"),
      payload: z.object({
        ...projectWithOptionalConversation,
        repositoryPath: z.string().min(1).max(4096).optional(),
        operationId: z.string().uuid(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.selection.ask"),
      payload: diffReviewSelectionSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.selection.revise"),
      payload: diffReviewSelectionSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.state.set"),
      payload: z.object({
        conversationId: z.string().uuid(),
        repositoryPath: z.string().min(1).max(4096).optional(),
        scope: z.enum(["file", "hunk"]),
        path: z.string().min(1).max(4096),
        hunkId: z.string().min(1).max(128).nullable(),
        targetFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        reviewed: z.boolean(),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.note.create"),
      payload: z.object({
        conversationId: z.string().uuid(),
        repositoryPath: z.string().min(1).max(4096).optional(),
        path: z.string().min(1).max(4096),
        hunkId: z.string().min(1).max(128).nullable(),
        lineIds: z.array(z.string().min(1).max(160)).max(500),
        targetFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        body: z.string().trim().min(1).max(8_000),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.note.update"),
      payload: z.object({
        conversationId: z.string().uuid(),
        noteId: z.string().uuid(),
        body: z.string().trim().min(1).max(8_000),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.note.delete"),
      payload: z.object({
        conversationId: z.string().uuid(),
        noteId: z.string().uuid(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.summary.generate"),
      payload: z.object({
        projectId: z.string().uuid(),
        conversationId: z.string().uuid(),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
        ignoreWhitespace: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("review.summary.cancel"),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.branches"),
      payload: z.object({ projectId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.branch.create"),
      payload: z.object({
        projectId: z.string().uuid(),
        name: z.string().trim().min(1).max(255),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.branch.switch"),
      payload: z.object({
        projectId: z.string().uuid(),
        name: z.string().trim().min(1).max(255),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.worktree.create"),
      payload: z
        .object({
          projectId: z.string().uuid(),
          conversationId: z.string().uuid(),
          baseBranch: z.string().trim().min(1).max(255),
          branch: z.string().trim().min(1).max(255),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.pull"),
      payload: z.object(projectWithOptionalConversation).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.commit"),
      payload: z
        .object({
          ...projectWithOptionalConversation,
          message: z.string().trim().min(1).max(10_000),
          paths: z.array(z.string().min(1).max(512)).max(500).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.push"),
      payload: z.object(projectWithOptionalConversation).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.pr.open"),
      payload: z.object(projectWithOptionalConversation).strict(),
    })
    .strict(),
] as const;
