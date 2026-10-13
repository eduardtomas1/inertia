import type { CodexControlClientOptions } from "./control-client";

export interface CodexThreadTitleOptions {
  executable: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  model: string;
  prompt: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  spawnProcess?: CodexControlClientOptions["spawnProcess"];
  installationUse?: CodexControlClientOptions["installationUse"];
}

export async function generateCodexThreadTitle(
  _options: CodexThreadTitleOptions,
): Promise<string | undefined> {
  return undefined;
}
