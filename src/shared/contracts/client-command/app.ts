import { z } from "zod";

import {
  modelBackendProfileIdSchema,
  modelSelectionSchema,
} from "../../model-routing";
import {
  modelBackendCredentialRevisionSchema,
  modelBackendDefaultInputSchema,
  modelBackendProfileDraftSchema,
  modelBackendProfileProbeSchema,
  modelBackendProfileUpdateSchema,
} from "../../backend-profile-settings";
import {
  providerMaintenanceOperationIdSchema,
  providerMaintenanceProviderIdSchema,
} from "../../provider-maintenance";
import {
  accessModeSchema,
  interactionModeSchema,
  providerIdSchema,
  requestBase,
} from "./common";

const conversationCreatePayloadSchema = z
  .object({
    projectId: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
    providerId: providerIdSchema.optional(),
    modelSelection: modelSelectionSchema.optional(),
    model: z.string().trim().max(160).optional(),
    reasoningEffort: z.string().trim().max(40).optional(),
    interactionMode: interactionModeSchema.optional(),
    accessMode: accessModeSchema.optional(),
    activate: z.boolean().optional(),
    useWorktree: z.boolean().optional(),
    branch: z.string().trim().min(1).max(255).nullable().optional(),
    worktreePath: z.string().min(1).max(4096).nullable().optional(),
  })
  .strict();

const duoSideSchema = conversationCreatePayloadSchema.extend({
  activate: z.literal(false).optional(),
}).strict();

const duoComparisonSchema = conversationCreatePayloadSchema.omit({
  branch: true,
  useWorktree: true,
  worktreePath: true,
}).extend({
  activate: z.literal(false).optional(),
}).strict();

export const appCommandSchemas = [
  z.object({ ...requestBase, type: z.literal("app.refresh") }).strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("provider.refresh"),
      payload: z.object({ providerId: providerIdSchema.optional() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("provider.auth.start"),
      payload: z.object({
        providerId: providerIdSchema,
        cols: z.number().int().min(40).max(240),
        rows: z.number().int().min(10).max(80),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("provider.maintenance.refresh"),
      payload: z.object({
        providerId: providerMaintenanceProviderIdSchema.optional(),
        force: z.boolean().optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("provider.maintenance.update"),
      payload: z.object({
        providerId: providerMaintenanceProviderIdSchema,
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("provider.maintenance.cancel"),
      payload: z.object({
        operationId: providerMaintenanceOperationIdSchema,
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.create"),
      payload: z.object({
        name: z.string().trim().min(1).max(80),
        path: z.string().min(1).max(4096),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.select"),
      payload: z.object({ projectId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.remove"),
      payload: z.object({ projectId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("project.update"),
      payload: z.object({
        projectId: z.string().uuid(),
        name: z.string().trim().min(1).max(80).optional(),
        groupingMode: z.enum(["repository", "repository-path", "separate"]).nullable().optional(),
        gitRepositoryLimit: z.number().int().min(16).max(1_024).optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("conversation.create"),
      payload: conversationCreatePayloadSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("duo.prepare"),
      payload: z.object({
        launchId: z.string().uuid(),
        prompt: z.string().trim().min(1).max(20_000),
        sides: z.tuple([duoSideSchema, duoSideSchema]),
        comparison: duoComparisonSchema.optional(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("duo.pending"),
      payload: z.object({
        projectIds: z.array(z.string().uuid()).min(1).max(2),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.enum([
        "duo.dispatch",
        "duo.cancel",
        "duo.status",
        "duo.acknowledge",
        "duo.comparison.retry",
        "duo.comparison.cancel",
      ]),
      payload: z.object({ launchId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("conversation.select"),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("conversation.detail.load"),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("conversation.detail.subscription"),
      payload: z.object({
        owner: z.enum(["primary", "secondary"]),
        conversationId: z.string().uuid().nullable(),
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("conversation.update"),
      payload: z
        .object({
          conversationId: z.string().uuid(),
          title: z.string().trim().min(1).max(120).optional(),
          providerId: providerIdSchema.optional(),
          modelSelection: modelSelectionSchema.optional(),
          model: z.string().trim().max(160).optional(),
          reasoningEffort: z.string().trim().max(40).optional(),
          interactionMode: interactionModeSchema.optional(),
          accessMode: accessModeSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.enum([
        "conversation.archive",
        "conversation.unarchive",
        "conversation.settle",
        "conversation.unsettle",
        "conversation.delete",
      ]),
      payload: z.object({ conversationId: z.string().uuid() }).strict(),
    })
    .strict(),
] as const;

export const configurationCommandSchemas = [
  z
    .object({
      ...requestBase,
      type: z.literal("settings.update"),
      payload: z
        .object({
          theme: z.enum(["system", "light", "dark"]).optional(),
          compactSidebar: z.boolean().optional(),
          showTimestamps: z.boolean().optional(),
          terminalFontSize: z.number().int().min(11).max(22).optional(),
          defaultProvider: providerIdSchema.optional(),
          defaultModel: z.string().trim().max(160).optional(),
          defaultAccessMode: accessModeSchema.optional(),
          newThreadMode: z.enum(["local", "worktree"]).optional(),
          wrapDiffs: z.boolean().optional(),
          ignoreWhitespace: z.boolean().optional(),
          showThinking: z.boolean().optional(),
          usageDisplayMode: z.enum(["expanded", "compact", "hidden"]).optional(),
          interfaceScale: z.enum(["compact", "default", "comfortable", "large"]).optional(),
          responseDensity: z.enum(["compact", "default", "comfortable"]).optional(),
          workspaceStartupSurface: z.enum(["summary", "tools"]).optional(),
          defaultCodeWrap: z.boolean().optional(),
          autoCollapseWorkLog: z.boolean().optional(),
          showChangedFileSummaries: z.boolean().optional(),
          sidebarMode: z.enum(["classic", "activity"]).optional(),
          projectGrouping: z.enum(["repository", "repository-path", "separate"]).optional(),
          autoOpenPlan: z.boolean().optional(),
          confirmDestructiveActions: z.boolean().optional(),
          defaultReasoningEffort: z.string().trim().max(40).optional(),
          defaultInteractionMode: interactionModeSchema.optional(),
          codexBinaryPath: z.string().trim().max(4096).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.get"),
      payload: z.object({ profileId: modelBackendProfileIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.create"),
      payload: modelBackendProfileDraftSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.update"),
      payload: z.object({
        profileId: modelBackendProfileIdSchema,
        update: modelBackendProfileUpdateSchema,
      }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.credential-revision"),
      payload: modelBackendCredentialRevisionSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.probe"),
      payload: modelBackendProfileProbeSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.profile.delete"),
      payload: z.object({ profileId: modelBackendProfileIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.default.set"),
      payload: modelBackendDefaultInputSchema,
    })
    .strict(),
  z
    .object({
      ...requestBase,
      type: z.literal("backend.default.clear"),
      payload: z.object({ projectId: z.string().uuid().nullable() }).strict(),
    })
    .strict(),
] as const;
