import type {
  AgentDefinition,
  Options as ClaudeOptions,
} from "@anthropic-ai/claude-agent-sdk";

import type { ProviderSkillInput } from "../../shared/contracts";
import type { ProviderCustomAgentInput } from "./contracts";
import { loadClaudeAgents } from "./claude-agents";
import {
  loadClaudeInstructions,
  type ClaudeInstructionContext,
} from "./claude-memory";
import {
  createClaudeSkillDeadline,
  raceClaudeSkillOperation,
  raceClaudeSkillStaging,
  type ClaudeSkillFilesystemTestSeam,
} from "./claude-skill-operation";
import {
  CLAUDE_ISOLATED_SKILL_PLUGIN_NAME,
  stageClaudeSkillPlugin,
  type StagedClaudeSkillPlugin,
} from "./claude-skill-plugin";

export const CLAUDE_IDENTITY_ENVIRONMENT = {
  CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
} as const;

export interface ClaudeTurnIdentity {
  skills: StagedClaudeSkillPlugin | null;
  agents: Record<string, AgentDefinition>;
  instructions: ClaudeInstructionContext;
}

export interface ClaudeTurnIdentityInput {
  skills: readonly ProviderSkillInput[];
  customAgent?: ProviderCustomAgentInput;
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal: AbortSignal;
  filesystem?: ClaudeSkillFilesystemTestSeam;
}

const NO_INSTRUCTIONS: ClaudeInstructionContext = {
  systemPromptAppend: "",
  additionalDirectories: [],
};

async function optionalIdentity<T>(
  input: ClaudeTurnIdentityInput,
  fallback: T,
  load: (control: { signal: AbortSignal } & ClaudeSkillFilesystemTestSeam) => Promise<T>,
): Promise<T> {
  const deadline = createClaudeSkillDeadline(
    input.timeoutMs,
    "Claude identity loading timed out.",
    input.signal,
  );
  try {
    return await raceClaudeSkillOperation(
      load({ ...input.filesystem, signal: deadline.signal }),
      deadline.signal,
    );
  } catch (error) {
    if (input.signal.aborted) throw error;
    return fallback;
  } finally {
    deadline.dispose();
  }
}

async function stageIdentitySkills(
  input: ClaudeTurnIdentityInput,
  selected: readonly Extract<ProviderSkillInput, { source: "claude-native" }>[],
  includeDiscovered: boolean,
): Promise<StagedClaudeSkillPlugin | null> {
  const deadline = createClaudeSkillDeadline(
    input.timeoutMs,
    "Claude selected-skill staging timed out.",
    input.signal,
  );
  try {
    return await raceClaudeSkillStaging(
      stageClaudeSkillPlugin(selected, input.cwd, input.environment, {
        ...input.filesystem,
        signal: deadline.signal,
        includeDiscovered,
        ...(input.customAgent ? { preferredSkillNames: input.customAgent.skills } : {}),
      }),
      deadline.signal,
    );
  } finally {
    deadline.dispose();
  }
}

export async function prepareClaudeTurnIdentity(
  input: ClaudeTurnIdentityInput,
): Promise<ClaudeTurnIdentity> {
  const selected = input.skills.filter(
    (skill): skill is Extract<ProviderSkillInput, { source: "claude-native" }> =>
      skill.source === "claude-native",
  );
  let skills: StagedClaudeSkillPlugin | null;
  try {
    skills = await stageIdentitySkills(input, selected, true);
  } catch (error) {
    if (input.signal.aborted) throw error;
    skills = await stageIdentitySkills(input, selected, false);
  }
  try {
    const staged = new Set(skills?.skillNames ?? []);
    const discovered = await optionalIdentity(input, {}, async (control) =>
      await loadClaudeAgents(input.cwd, input.environment, control, (name) => {
        const qualified = `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:${name}`;
        return staged.has(qualified) ? qualified : name;
      }));
    const agents = input.customAgent
      ? withClaudeCustomAgent(discovered, input.customAgent, staged)
      : discovered;
    const instructions = await optionalIdentity(input, NO_INSTRUCTIONS, async (control) =>
      await loadClaudeInstructions(input.cwd, input.environment, control));
    return { skills, agents, instructions };
  } catch (error) {
    await skills?.cleanup().catch(() => undefined);
    throw error;
  }
}

export function withClaudeCustomAgent(
  agents: Readonly<Record<string, AgentDefinition>>,
  customAgent: ProviderCustomAgentInput,
  stagedSkillNames: ReadonlySet<string>,
): Record<string, AgentDefinition> {
  const skills = customAgent.skills
    .map((name) => `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:${name}`)
    .filter((qualified) => stagedSkillNames.has(qualified));
  return {
    ...Object.fromEntries(Object.entries(agents).filter(([name]) => name !== customAgent.nativeName)),
    [customAgent.nativeName]: {
      description: customAgent.description,
      prompt: customAgent.instructions,
      ...(skills.length > 0 ? { skills } : {}),
      background: false,
    },
  };
}

export function claudeIdentityOptions(
  identity: ClaudeTurnIdentity,
  systemInstruction?: string,
  sessionInstruction?: string,
): Pick<
  ClaudeOptions,
  "systemPrompt" | "additionalDirectories" | "agents" | "plugins" | "skills"
> {
  const { skills, agents, instructions } = identity;
  const append = [instructions.systemPromptAppend, sessionInstruction ?? "", systemInstruction ?? ""]
    .filter((section) => section.length > 0)
    .join("\n\n");
  return {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      snapshot: systemInstruction === undefined,
      ...(append ? { append } : {}),
    },
    ...(instructions.additionalDirectories.length > 0
      ? { additionalDirectories: instructions.additionalDirectories }
      : {}),
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
    ...(skills
      ? {
          plugins: [{
            type: "local" as const,
            path: skills.path,
            skipMcpDiscovery: true,
          }],
          skills: skills.skillNames,
        }
      : {}),
  };
}
