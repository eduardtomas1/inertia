import { z } from "zod";

import { PROJECT_COLOR_NAMES } from "./project-colors";

export const MAX_CUSTOM_AGENTS = 40;
export const MAX_CUSTOM_AGENT_NAME_CHARS = 60;
export const MAX_CUSTOM_AGENT_HANDLE_CHARS = 32;
export const MAX_CUSTOM_AGENT_DESCRIPTION_CHARS = 200;
export const MAX_CUSTOM_AGENT_BLOCKS = 16;
export const MAX_CUSTOM_AGENT_BLOCK_CHARS = 4_000;
export const MAX_CUSTOM_AGENT_SKILLS = 8;
export const MAX_CUSTOM_AGENT_SKILL_NAME_CHARS = 120;
export const MAX_CUSTOM_AGENT_COMPILED_CHARS = 12_000;
export const CUSTOM_AGENT_ICON_SIZE = 64;
export const MAX_CUSTOM_AGENT_ICON_DATA_LENGTH = 48_000;
export const MAX_CUSTOM_AGENT_EXPORT_BYTES = 8 * 1_024 * 1_024;
export const CUSTOM_AGENT_EXPORT_FORMAT = "inertia-custom-agents";
export const CUSTOM_AGENT_EXPORT_VERSION = 1;
export const CUSTOM_AGENT_NATIVE_PREFIX = "inertia-";

export const CUSTOM_AGENT_ICON_NAMES = [
  "orbit",
  "star",
  "shield",
  "search",
  "wrench",
  "flask",
  "pen",
  "book",
  "bug",
  "target",
  "eye",
  "brush",
  "rocket",
  "scale",
  "zap",
  "braces",
] as const;

export const CUSTOM_AGENT_BLOCK_KINDS = [
  "role",
  "directions",
  "must",
  "must-not",
  "message",
  "example",
] as const;

export const CUSTOM_AGENT_BLOCK_LABELS: Readonly<Record<CustomAgentBlockKind, string>> = {
  role: "Role",
  directions: "Directions",
  must: "Must",
  "must-not": "Must not",
  message: "Message",
  example: "Example",
};

export const CUSTOM_AGENT_BLOCK_HINTS: Readonly<Record<CustomAgentBlockKind, string>> = {
  role: "Who this agent is and what it is for.",
  directions: "How it should work: order of operations, what to look at, how to report.",
  must: "Rules it always follows. One per line.",
  "must-not": "Lines it never crosses. One per line.",
  message: "Text handed over verbatim, such as a brief or a checklist.",
  example: "A sample request and the answer you expect, so the tone is unmistakable.",
};

export const CUSTOM_AGENT_DELIVERIES = ["subagent", "in-role"] as const;

const timestampSchema = z.string().datetime({ offset: true });
const singleLine = (value: string): boolean => !/[\0\r\n]/u.test(value);

function boundedPng(value: string): boolean {
  try {
    const prefix = "data:image/png;base64,";
    const header = atob(value.slice(prefix.length, prefix.length + 44));
    const integer = (offset: number): number =>
      [0, 1, 2, 3].reduce((total, index) => total * 256 + header.charCodeAt(offset + index), 0);
    return header.length >= 33 && integer(8) === 13 && header.slice(12, 16) === "IHDR"
      && [integer(16), integer(20)].every((size) => size > 0 && size <= CUSTOM_AGENT_ICON_SIZE);
  } catch {
    return false;
  }
}

export const customAgentHandleSchema = z.string()
  .max(MAX_CUSTOM_AGENT_HANDLE_CHARS)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u, "Use lowercase letters, digits and single dashes.")
  .refine((value) => !value.includes("--"), "Use single dashes.");

export const customAgentNameSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_CUSTOM_AGENT_NAME_CHARS)
  .refine(singleLine, "Agent names stay on one line.");

export const customAgentDescriptionSchema = z.string()
  .trim()
  .max(MAX_CUSTOM_AGENT_DESCRIPTION_CHARS)
  .refine(singleLine, "Descriptions stay on one line.");

export const customAgentIconSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("symbol"), name: z.enum(CUSTOM_AGENT_ICON_NAMES) }),
  z.strictObject({
    kind: z.literal("image"),
    data: z.string()
      .max(MAX_CUSTOM_AGENT_ICON_DATA_LENGTH)
      .regex(/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/u)
      .refine(boundedPng, "Use a normalized small PNG icon."),
  }),
]);

export const customAgentAccentSchema = z.enum(PROJECT_COLOR_NAMES).nullable();

export const customAgentBlockSchema = z.strictObject({
  id: z.string().uuid(),
  kind: z.enum(CUSTOM_AGENT_BLOCK_KINDS),
  body: z.string()
    .max(MAX_CUSTOM_AGENT_BLOCK_CHARS)
    .refine((value) => value.trim().length > 0, "Blocks cannot be blank.")
    .refine((value) => !value.includes("\0"), "Blocks cannot contain NUL bytes."),
});

export const customAgentSkillNameSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_CUSTOM_AGENT_SKILL_NAME_CHARS)
  .refine(singleLine, "Skill names stay on one line.");

export const customAgentDraftSchema = z.strictObject({
  name: customAgentNameSchema,
  handle: customAgentHandleSchema,
  description: customAgentDescriptionSchema,
  icon: customAgentIconSchema,
  accent: customAgentAccentSchema,
  blocks: z.array(customAgentBlockSchema)
    .max(MAX_CUSTOM_AGENT_BLOCKS)
    .refine(
      (blocks) => new Set(blocks.map((block) => block.id)).size === blocks.length,
      "Block identities must be unique.",
    ),
  skills: z.array(customAgentSkillNameSchema)
    .max(MAX_CUSTOM_AGENT_SKILLS)
    .refine((skills) => new Set(skills).size === skills.length, "Skills must be unique."),
}).superRefine((draft, context) => {
  if (compileCustomAgentInstructions(draft).length > MAX_CUSTOM_AGENT_COMPILED_CHARS) {
    context.addIssue({
      code: "custom",
      path: ["blocks"],
      message: `The compiled instructions cannot exceed ${MAX_CUSTOM_AGENT_COMPILED_CHARS} characters.`,
    });
  }
});

export const customAgentSchema = customAgentDraftSchema.extend({
  id: z.string().uuid(),
  position: z.number().int().min(0).max(MAX_CUSTOM_AGENTS - 1),
  revision: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const customAgentCallAttributionSchema = z.strictObject({
  agentId: z.string().uuid(),
  revision: z.number().int().positive(),
  handle: customAgentHandleSchema,
  name: customAgentNameSchema,
  icon: customAgentIconSchema,
  accent: customAgentAccentSchema,
  delivery: z.enum(CUSTOM_AGENT_DELIVERIES),
});

export const customAgentExportSchema = z.strictObject({
  format: z.literal(CUSTOM_AGENT_EXPORT_FORMAT),
  version: z.literal(CUSTOM_AGENT_EXPORT_VERSION),
  exportedAt: timestampSchema,
  agents: z.array(customAgentDraftSchema).min(1).max(MAX_CUSTOM_AGENTS),
});

export type CustomAgentIconName = typeof CUSTOM_AGENT_ICON_NAMES[number];
export type CustomAgentBlockKind = typeof CUSTOM_AGENT_BLOCK_KINDS[number];
export type CustomAgentDelivery = typeof CUSTOM_AGENT_DELIVERIES[number];
export type CustomAgentIcon = z.infer<typeof customAgentIconSchema>;
export type CustomAgentAccent = z.infer<typeof customAgentAccentSchema>;
export type CustomAgentBlock = z.infer<typeof customAgentBlockSchema>;
export type CustomAgentDraft = z.infer<typeof customAgentDraftSchema>;
export type CustomAgent = z.infer<typeof customAgentSchema>;
export type CustomAgentCallAttribution = z.infer<typeof customAgentCallAttributionSchema>;
export type CustomAgentExport = z.infer<typeof customAgentExportSchema>;

export interface CustomAgentPreset {
  id: string;
  name: string;
  summary: string;
  icon: CustomAgentIcon;
  accent: CustomAgentAccent;
  blocks: ReadonlyArray<{ kind: CustomAgentBlockKind; body: string }>;
  skills?: readonly string[];
}

export function customAgentNativeName(handle: string): string {
  return `${CUSTOM_AGENT_NATIVE_PREFIX}${handle}`;
}

export function customAgentHandleFromNativeName(name: string | null | undefined): string | null {
  if (!name || !name.startsWith(CUSTOM_AGENT_NATIVE_PREFIX)) return null;
  const handle = name.slice(CUSTOM_AGENT_NATIVE_PREFIX.length);
  return customAgentHandleSchema.safeParse(handle).success ? handle : null;
}

export function customAgentHandleFromName(name: string): string {
  const handle = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, MAX_CUSTOM_AGENT_HANDLE_CHARS)
    .replace(/-+$/u, "");
  return handle || "agent";
}

export function uniqueCustomAgentHandle(
  handle: string,
  taken: Iterable<string>,
): string {
  const used = new Set(taken);
  if (!used.has(handle)) return handle;
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${handle.slice(0, MAX_CUSTOM_AGENT_HANDLE_CHARS - tail.length).replace(/-+$/u, "")}${tail}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${handle.slice(0, MAX_CUSTOM_AGENT_HANDLE_CHARS - 9)}-${Date.now().toString(36).slice(-8)}`;
}

export function duplicateCustomAgentName(name: string): string {
  const suffix = " copy";
  return `${name.slice(0, MAX_CUSTOM_AGENT_NAME_CHARS - suffix.length).trimEnd()}${suffix}`;
}

const compiledSections: ReadonlyArray<{ kind: CustomAgentBlockKind; heading: string; list: boolean }> = [
  { kind: "role", heading: "Role", list: false },
  { kind: "directions", heading: "Directions", list: false },
  { kind: "must", heading: "Always", list: true },
  { kind: "must-not", heading: "Never", list: true },
  { kind: "message", heading: "Brief", list: false },
  { kind: "example", heading: "Example", list: false },
];

export function compileCustomAgentInstructions(
  agent: Pick<CustomAgentDraft, "name" | "description" | "blocks" | "skills">,
): string {
  const lines: string[] = [`# ${agent.name}`];
  if (agent.description.trim()) lines.push("", agent.description.trim());
  for (const section of compiledSections) {
    const bodies = agent.blocks
      .filter((block) => block.kind === section.kind)
      .map((block) => block.body.trim())
      .filter((body) => body.length > 0);
    if (bodies.length === 0) continue;
    lines.push("", `## ${section.heading}`, "");
    if (section.list) {
      for (const body of bodies) {
        for (const item of body.split(/\r?\n/u)) {
          const text = item.replace(/^\s*(?:[-*•]|\d+[.)])\s*/u, "").trim();
          if (text) lines.push(`- ${text}`);
        }
      }
    } else {
      lines.push(bodies.join("\n\n"));
    }
  }
  if (agent.skills.length > 0) {
    lines.push("", "## Skills", "", ...agent.skills.map((skill) => `- ${skill}`));
  }
  return `${lines.join("\n")}\n`;
}

export function customAgentExportFileName(agents: readonly Pick<CustomAgentDraft, "handle">[]): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return agents.length === 1
    ? `inertia-agent-${agents[0]?.handle ?? "agent"}-${stamp}.json`
    : `inertia-agents-${stamp}.json`;
}

export function buildCustomAgentExport(
  agents: readonly CustomAgentDraft[],
  exportedAt: string = new Date().toISOString(),
): CustomAgentExport {
  return {
    format: CUSTOM_AGENT_EXPORT_FORMAT,
    version: CUSTOM_AGENT_EXPORT_VERSION,
    exportedAt,
    agents: agents.map(({ name, handle, description, icon, accent, blocks, skills }) => ({
      name,
      handle,
      description,
      icon,
      accent,
      blocks: blocks.map((block) => ({ ...block })),
      skills: [...skills],
    })),
  };
}
