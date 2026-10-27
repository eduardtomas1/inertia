import { objectValue, type JsonObject } from "./protocol";

export const CODEX_CONFIG_READ_TIMEOUT_MS = 3_000;

export function configuredDeveloperInstructions(config: JsonObject | null): string {
  const value = objectValue(config?.config)?.developer_instructions;
  return typeof value === "string" ? value.trim() : "";
}

export async function readConfiguredDeveloperInstructions(
  read: () => Promise<JsonObject>,
  timeoutMs = CODEX_CONFIG_READ_TIMEOUT_MS,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();
  });
  try {
    return configuredDeveloperInstructions(await Promise.race([read(), timedOut]));
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

export function codexDeveloperInstructions(sections: readonly (string | undefined)[]): string {
  return sections.filter((section): section is string => section !== undefined && section.length > 0).join("\n\n");
}
