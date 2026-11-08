import { z } from "zod";

import {
  GIT_COMMIT_SHA_PATTERN,
  GIT_HISTORY_LIMITS,
  GIT_LOG_CURSOR_PATTERN,
} from "../git-history";

import {
  diffReviewSelectionSchema,
  requestBase,
} from "./common";

const projectWithOptionalConversation = {
  projectId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
};

const projectWithOptionalConversationAndRepository = {
  ...projectWithOptionalConversation,
  repositoryPath: z.string().min(1).max(4096).optional(),
  authorityRef: z.string().uuid().optional(),
};

function requireRepositoryAuthority(
  payload: { repositoryPath?: string; authorityRef?: string },
  context: z.RefinementCtx,
): void {
  if (Boolean(payload.repositoryPath) === Boolean(payload.authorityRef)) return;
  context.addIssue({
    code: "custom",
    message: "A nested repository path and its authority must be provided together.",
  });
}

/** Upper bound for one `git.stage` / `git.unstage` request. */
export const GIT_STAGING_MAX_PATHS = 200;

/**
 * Repository-relative path in the Git form shown by status: forward slashes,
 * no absolute, drive-qualified, magic-pathspec, traversal, or control forms.
 * The runtime still enforces realpath containment against the repository.
 */
const gitStagingPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) =>
    !path.startsWith("/")
    && !path.startsWith(":")
    && !path.includes("\\")
    && !/^[A-Za-z]:/u.test(path)
    && !/[\0\r\n]/u.test(path)
    && !path.split("/").some((segment) => segment === ".." || segment === "."), {
    message: "A selected file path is invalid.",
  });

const gitStagingPayload = z
  .object({
    ...projectWithOptionalConversationAndRepository,
    paths: z.array(gitStagingPathSchema).min(1).max(GIT_STAGING_MAX_PATHS),
  })
  .strict()
  .superRefine(requireRepositoryAuthority);

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
          authorityRef: z.string().uuid(),
          path: z.string().max(512).optional(),
          ignoreWhitespace: z.boolean().optional(),
          commitReview: z.boolean().optional(),
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
          authorityRef: z.string().uuid(),
          repositoryPath: z.string().min(1).max(4096),
          path: z.string().min(1).max(4096).optional(),
          ignoreWhitespace: z.boolean().optional(),
          commitReview: z.boolean().optional(),
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
        authorityRef: z.string().uuid(),
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
        authorityRef: z.string().uuid(),
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
      type: z.literal("review.selection.cancel"),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
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
      payload: z.object({ ...projectWithOptionalConversation, authorityRef: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.branch.create"),
      payload: z
        .object({
          ...projectWithOptionalConversationAndRepository,
          name: z.string().trim().min(1).max(255),
        })
        .strict()
        .superRefine(requireRepositoryAuthority),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.branch.switch"),
      payload: z
        .object({
          ...projectWithOptionalConversationAndRepository,
          name: z.string().trim().min(1).max(255),
          remote: z.boolean().optional(),
        })
        .strict()
        .superRefine(requireRepositoryAuthority),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.fetch"),
      payload: z.object(projectWithOptionalConversationAndRepository)
        .strict()
        .superRefine(requireRepositoryAuthority),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.pull"),
      payload: z.object(projectWithOptionalConversationAndRepository)
        .strict()
        .superRefine(requireRepositoryAuthority),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.commit"),
      payload: z
        .object({
          ...projectWithOptionalConversationAndRepository,
          message: z.string().trim().min(1).max(10_000),
          paths: z.array(z.string().min(1).max(4096)).max(500).optional(),
          reviewReceipt: z.object({
            authorityRef: z.string().uuid(),
            fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
          }).strict(),
        })
        .strict()
        .superRefine(requireRepositoryAuthority),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.stage"),
      payload: gitStagingPayload,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.unstage"),
      payload: gitStagingPayload,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.push"),
      payload: z.object(projectWithOptionalConversationAndRepository)
        .strict()
        .superRefine(requireRepositoryAuthority),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.pr.open"),
      payload: z.object(projectWithOptionalConversationAndRepository)
        .strict()
        .superRefine(requireRepositoryAuthority),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.pr.confidence"),
      payload: z.object(projectWithOptionalConversationAndRepository)
        .strict()
        .superRefine(requireRepositoryAuthority),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.pr.create"),
      payload: z.object({
        ...projectWithOptionalConversationAndRepository,
        title: z.string().trim().min(1).max(256),
        body: z.string().max(64 * 1024),
        draft: z.boolean(),
      }).strict().superRefine(requireRepositoryAuthority),
    })
    .strict(),
] as const;

// ---------------------------------------------------------------------------
// Read-only Git history and blame (git.log, git.commit.show, git.blame).
// Kept as a separate block so unrelated Git command additions above do not
// conflict with it. Root scope omits repositoryPath; a nested repository
// supplies repositoryPath with its runtime-issued authorityRef, exactly as the
// other repository-scoped Git commands do.
// ---------------------------------------------------------------------------
const gitHistoryPath = z.string().min(1).max(4096)
  .refine((value) => !value.includes("\0"), "Paths cannot contain NUL.");

export const gitHistoryCommandSchemas = [
  z
    .object({
      ...requestBase,
      type: z.literal("git.log"),
      payload: z.object({
        ...projectWithOptionalConversationAndRepository,
        cursor: z.string().regex(GIT_LOG_CURSOR_PATTERN).optional(),
        limit: z.number().int().min(1).max(GIT_HISTORY_LIMITS.logPageMax).optional(),
        path: gitHistoryPath.optional(),
      }).strict().superRefine(requireRepositoryAuthority),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.commit.show"),
      payload: z.object({
        ...projectWithOptionalConversationAndRepository,
        sha: z.string().regex(GIT_COMMIT_SHA_PATTERN),
      }).strict().superRefine(requireRepositoryAuthority),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("git.blame"),
      payload: z.object({
        ...projectWithOptionalConversationAndRepository,
        path: gitHistoryPath,
        startLine: z.number().int().min(1).max(10_000_000).optional(),
        endLine: z.number().int().min(1).max(10_000_000).optional(),
      }).strict().superRefine(requireRepositoryAuthority)
        .refine(
          ({ startLine, endLine }) => endLine === undefined || endLine >= (startLine ?? 1),
          "The blame range is invalid.",
        ),
    })
    .strict(),
] as const;
