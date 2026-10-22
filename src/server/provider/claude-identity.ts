import type {
  AgentDefinition,
  Options as ClaudeOptions,
} from "@anthropic-ai/claude-agent-sdk";

import type { ProviderSkillInput } from "../../shared/contracts";
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

export async function prepareClaudeTurnIdentity(
  input: ClaudeTurnIdentityInput,
): Promise<ClaudeTurnIdentity> {
  const selected = input.skills.filter(
    (skill): skill is Extract<ProviderSkillInput, { source: "claude-native" }> =>
      skill.source === "claude-native",
  );
  const deadline = createClaudeSkillDeadline(
    input.timeoutMs,
    "Claude selected-skill staging timed out.",
    input.signal,
  );
  let skills: StagedClaudeSkillPlugin | null;
  try {
    skills = await raceClaudeSkillStaging(
      stageClaudeSkillPlugin(selected, input.cwd, input.environment, {
        ...input.filesystem,
        signal: deadline.signal,
        includeDiscovered: true,
      }),
      deadline.signal,
    );
  } finally {
    deadline.dispose();
  }
  try {
    const staged = new Set(skills?.skillNames ?? []);
    const agents = await optionalIdentity(input, {}, async (control) =>
      await loadClaudeAgents(input.cwd, input.environment, control, (name) => {
        const qualified = `${CLAUDE_ISOLATED_SKILL_PLUGIN_NAME}:${name}`;
        return staged.has(qualified) ? qualified : name;
      }));
    const instructions = await optionalIdentity(input, NO_INSTRUCTIONS, async (control) =>
      await loadClaudeInstructions(input.cwd, input.environment, control));
    return { skills, agents, instructions };
  } catch (error) {
    await skills?.cleanup().catch(() => undefined);
    throw error;
  }
}

export function claudeIdentityOptions(
  identity: ClaudeTurnIdentity,
): Pick<
  ClaudeOptions,
  "systemPrompt" | "additionalDirectories" | "agents" | "plugins" | "skills"
> {
  const { skills, agents, instructions } = identity;
  return {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      snapshot: true,
      ...(instructions.systemPromptAppend
        ? { append: instructions.systemPromptAppend }
        : {}),
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
