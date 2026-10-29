import type { ProviderCustomAgentInput } from "./contracts";

export const OPENCODE_CONFIG_CONTENT = "OPENCODE_CONFIG_CONTENT";

type JsonRecord = Record<string, unknown>;

function plainRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function inheritedConfig(value: string | undefined): JsonRecord {
  if (!value) return {};
  try {
    return plainRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

export function openCodeCustomAgentConfig(
  customAgent: ProviderCustomAgentInput,
  inherited: JsonRecord = {},
): JsonRecord {
  return {
    ...inherited,
    agent: {
      ...plainRecord(inherited.agent),
      [customAgent.nativeName]: {
        mode: "subagent",
        description: customAgent.description,
        prompt: customAgent.instructions,
      },
    },
  };
}

export function openCodeCustomAgentEnvironment(
  environment: NodeJS.ProcessEnv,
  customAgent: ProviderCustomAgentInput | undefined,
): NodeJS.ProcessEnv {
  if (!customAgent) return environment;
  const inheritedKeys = Object.keys(environment)
    .filter((key) => key.toUpperCase() === OPENCODE_CONFIG_CONTENT);
  const inherited = inheritedConfig(inheritedKeys.map((key) => environment[key]).find(Boolean));
  const rest = Object.fromEntries(
    Object.entries(environment).filter(([key]) => !inheritedKeys.includes(key)),
  );
  return {
    ...rest,
    [OPENCODE_CONFIG_CONTENT]: JSON.stringify(openCodeCustomAgentConfig(customAgent, inherited)),
  };
}
