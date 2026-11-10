import { z } from "zod";

import {
  MAX_CUSTOM_AGENTS,
  customAgentDraftSchema,
} from "../../custom-agents";
import { requestBase } from "./common";

const agentIdsSchema = z.array(z.string().uuid()).max(MAX_CUSTOM_AGENTS)
  .refine(
    (values) => new Set(values).size === values.length,
    "Agent order cannot contain duplicate identities.",
  );

const draftFields = customAgentDraftSchema.shape;

export const customAgentHandleConflictSchema = z.enum(["reject", "rename"]);

export const customAgentCommandSchemas = [
  z.object({
    ...requestBase,
    type: z.literal("custom-agent.create"),
    payload: z.object({
      agent: customAgentDraftSchema,
      onHandleConflict: customAgentHandleConflictSchema,
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("custom-agent.update"),
    payload: z.object({
      agentId: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
      name: draftFields.name.optional(),
      handle: draftFields.handle.optional(),
      description: draftFields.description.optional(),
      icon: draftFields.icon.optional(),
      accent: draftFields.accent.optional(),
      blocks: draftFields.blocks.optional(),
      skills: draftFields.skills.optional(),
    }).strict().refine(
      ({ agentId: _agentId, expectedRevision: _expectedRevision, ...fields }) =>
        Object.values(fields).some((value) => value !== undefined),
      "An agent update must change at least one field.",
    ),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("custom-agent.duplicate"),
    payload: z.object({
      agentId: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("custom-agent.delete"),
    payload: z.object({
      agentId: z.string().uuid(),
      expectedRevision: z.number().int().positive(),
    }).strict(),
  }).strict(),
  z.object({
    ...requestBase,
    type: z.literal("custom-agent.reorder"),
    payload: z.object({
      expectedAgentIds: agentIdsSchema,
      agentIds: agentIdsSchema,
    }).strict(),
  }).strict(),
] as const;
