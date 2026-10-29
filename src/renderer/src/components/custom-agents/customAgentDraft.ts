import {
  compileCustomAgentInstructions,
  customAgentDescriptionSchema,
  customAgentDraftSchema,
  customAgentHandleFromName,
  customAgentHandleSchema,
  customAgentNameSchema,
  customAgentSkillNameSchema,
  MAX_CUSTOM_AGENT_BLOCK_CHARS,
  MAX_CUSTOM_AGENT_BLOCKS,
  MAX_CUSTOM_AGENT_COMPILED_CHARS,
  MAX_CUSTOM_AGENT_SKILLS,
  uniqueCustomAgentHandle,
  type CustomAgent,
  type CustomAgentBlock,
  type CustomAgentBlockKind,
  type CustomAgentDraft,
  type CustomAgentPreset,
} from "@shared/custom-agents";
import type { CommandWithoutId } from "../../lib/runtimeCommands";

export type CustomAgentField = "name" | "handle" | "description" | "blocks" | "skills";

export interface CustomAgentValidation {
  agent: CustomAgentDraft | null;
  field: CustomAgentField | null;
  message: string | null;
}

const numberFormat = new Intl.NumberFormat("en-US");

export function formatCount(value: number): string {
  return numberFormat.format(value);
}

export function newCustomAgentBlock(kind: CustomAgentBlockKind, body = ""): CustomAgentBlock {
  return { id: crypto.randomUUID(), kind, body };
}

export function blankCustomAgentDraft(): CustomAgentDraft {
  return {
    name: "",
    handle: "",
    description: "",
    icon: { kind: "symbol", name: "bot" },
    accent: null,
    blocks: [newCustomAgentBlock("role")],
    skills: [],
  };
}

export function customAgentDraftFromPreset(preset: CustomAgentPreset, takenHandles: Iterable<string>): CustomAgentDraft {
  return {
    name: preset.name,
    handle: uniqueCustomAgentHandle(customAgentHandleFromName(preset.name), takenHandles),
    description: preset.summary,
    icon: preset.icon,
    accent: preset.accent,
    blocks: preset.blocks.map((block) => newCustomAgentBlock(block.kind, block.body)),
    skills: [...(preset.skills ?? [])],
  };
}

export function customAgentDraftOf(agent: CustomAgent): CustomAgentDraft {
  return {
    name: agent.name,
    handle: agent.handle,
    description: agent.description,
    icon: agent.icon,
    accent: agent.accent,
    blocks: agent.blocks.map((block) => ({ ...block })),
    skills: [...agent.skills],
  };
}

export function appendCustomAgentPreset(draft: CustomAgentDraft, preset: CustomAgentPreset): CustomAgentDraft {
  const skills = [...draft.skills];
  for (const skill of preset.skills ?? []) if (!skills.includes(skill)) skills.push(skill);
  return {
    ...draft,
    blocks: [...draft.blocks.filter((block) => block.body.trim()), ...preset.blocks.map((block) => newCustomAgentBlock(block.kind, block.body))],
    skills,
  };
}

export function cleanCustomAgentDraft(draft: CustomAgentDraft): CustomAgentDraft {
  return {
    ...draft,
    name: draft.name.trim(),
    description: draft.description.trim(),
    blocks: draft.blocks.filter((block) => block.body.trim().length > 0),
  };
}

export function compiledCustomAgentLength(draft: CustomAgentDraft): number {
  return compileCustomAgentInstructions(cleanCustomAgentDraft(draft)).length;
}

function invalid(field: CustomAgentField, message: string): CustomAgentValidation {
  return { agent: null, field, message };
}

function firstMessage(result: { success: boolean; error?: { issues: readonly { message: string }[] } }, fallback: string): string {
  const message = result.error?.issues[0]?.message;
  return message && !/^(?:String|Too|Array|Invalid|Expected)\b/u.test(message) ? message : fallback;
}

export function customAgentHandleProblem(handle: string, otherHandles: readonly string[]): string | null {
  if (!handle) return "Choose a handle.";
  const parsed = customAgentHandleSchema.safeParse(handle);
  if (!parsed.success) return firstMessage(parsed, "Use up to 32 lowercase letters, digits and single dashes.");
  if (otherHandles.includes(handle)) return `Another agent already answers to /calling ${handle}.`;
  return null;
}

export function validateCustomAgentDraft(draft: CustomAgentDraft, otherHandles: readonly string[]): CustomAgentValidation {
  const clean = cleanCustomAgentDraft(draft);
  if (!clean.name) return invalid("name", "Give the agent a name.");
  const name = customAgentNameSchema.safeParse(clean.name);
  if (!name.success) return invalid("name", firstMessage(name, "Keep the name to one short line."));
  const handle = customAgentHandleProblem(clean.handle, otherHandles);
  if (handle) return invalid("handle", handle);
  const description = customAgentDescriptionSchema.safeParse(clean.description);
  if (!description.success) return invalid("description", firstMessage(description, "Keep the description to one line of 200 characters."));
  if (clean.blocks.length === 0) return invalid("blocks", "Add at least one instruction block.");
  if (clean.blocks.length > MAX_CUSTOM_AGENT_BLOCKS) return invalid("blocks", `Use up to ${MAX_CUSTOM_AGENT_BLOCKS} blocks.`);
  if (clean.blocks.some((block) => block.body.length > MAX_CUSTOM_AGENT_BLOCK_CHARS)) {
    return invalid("blocks", `Keep each block under ${formatCount(MAX_CUSTOM_AGENT_BLOCK_CHARS)} characters.`);
  }
  if (compileCustomAgentInstructions(clean).length > MAX_CUSTOM_AGENT_COMPILED_CHARS) {
    return invalid("blocks", `The instructions are over ${formatCount(MAX_CUSTOM_AGENT_COMPILED_CHARS)} characters.`);
  }
  if (clean.skills.length > MAX_CUSTOM_AGENT_SKILLS) return invalid("skills", `Attach up to ${MAX_CUSTOM_AGENT_SKILLS} skills.`);
  if (clean.skills.some((skill) => !customAgentSkillNameSchema.safeParse(skill).success)) return invalid("skills", "Skill names stay on one line.");
  const parsed = customAgentDraftSchema.safeParse(clean);
  if (!parsed.success) return invalid("blocks", firstMessage(parsed, "Check the agent's fields."));
  return { agent: parsed.data, field: null, message: null };
}

export function customAgentCreateCommand(agent: CustomAgentDraft, onHandleConflict: "reject" | "rename"): CommandWithoutId {
  return { type: "custom-agent.create", payload: { agent, onHandleConflict } };
}

const DRAFT_KEYS = ["name", "handle", "description", "icon", "accent", "blocks", "skills"] as const;

export function customAgentUpdateCommand(agent: CustomAgent, next: CustomAgentDraft): CommandWithoutId | null {
  const changes: Partial<CustomAgentDraft> = {};
  for (const key of DRAFT_KEYS) {
    if (JSON.stringify(agent[key]) !== JSON.stringify(next[key])) Object.assign(changes, { [key]: next[key] });
  }
  if (Object.keys(changes).length === 0) return null;
  return { type: "custom-agent.update", payload: { agentId: agent.id, expectedRevision: agent.revision, ...changes } };
}

export function customAgentSummary(agent: Pick<CustomAgentDraft, "blocks" | "skills">): string {
  const blocks = `${agent.blocks.length} ${agent.blocks.length === 1 ? "block" : "blocks"}`;
  if (agent.skills.length === 0) return blocks;
  return `${blocks} · ${agent.skills.length} ${agent.skills.length === 1 ? "skill" : "skills"}`;
}

export function saveFailureMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "Couldn't save. Try again.";
}
