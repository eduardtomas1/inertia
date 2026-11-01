import { INTERNAL_PROVIDER_INSTRUCTIONS_HEADER } from "../internal-provider-instructions";
import { objectValue, type JsonObject } from "./protocol";

export const CODEX_CONFIG_READ_TIMEOUT_MS = 3_000;

export function configuredDeveloperInstructions(config: JsonObject | null): string {
  const value = objectValue(config?.config)?.developer_instructions;
  return typeof value === "string" ? value.trim() : "";
}

export async function readConfiguredDeveloperInstructions(
  read: () => Promise<JsonObject>,
  timeoutMs = CODEX_CONFIG_READ_TIMEOUT_MS,
): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
  });
  try {
    const config = await Promise.race([read(), timedOut]);
    return config === null ? null : configuredDeveloperInstructions(config);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface CodexSessionDeveloperInstructions {
  developerInstructions: string;
  sessionInstructionApplied: boolean;
}

export function codexSessionDeveloperInstructions(
  configured: string | null | undefined,
  sessionInstruction: string | undefined,
  developerInstructions?: string,
): CodexSessionDeveloperInstructions {
  const sessionInstructionApplied = sessionInstruction === undefined || configured !== null;
  return {
    developerInstructions: codexDeveloperInstructions([
      configured ?? undefined,
      sessionInstructionApplied ? sessionInstruction : undefined,
      developerInstructions,
    ]),
    sessionInstructionApplied,
  };
}

export function codexPromptWithSessionInstruction(prompt: string, sessionInstruction: string): string {
  return `${prompt}\n\n${INTERNAL_PROVIDER_INSTRUCTIONS_HEADER}\n${sessionInstruction}`;
}

export function codexDeveloperInstructions(sections: readonly (string | undefined)[]): string {
  return sections.filter((section): section is string => section !== undefined && section.length > 0).join("\n\n");
}
