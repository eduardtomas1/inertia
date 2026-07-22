import { readCodexMetadata, type CodexMetadata } from "../codex-metadata";
import { readClaudeAgentSdkModels } from "./claude-agent-sdk-harness";
import type { ProviderId } from "./contracts";
import { readOpenCodeSdkModels } from "./opencode-sdk-harness";

export type ProviderMetadata = CodexMetadata;

/** Provider-specific metadata access; caching policy belongs above this seam. */
export async function readProviderMetadata(
  providerId: ProviderId,
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ProviderMetadata> {
  if (providerId === "codex") return await readCodexMetadata(executable, environment, cwd);
  if (providerId === "claude") return { models: await readClaudeAgentSdkModels(executable, environment, cwd), rateLimits: [] };
  if (providerId === "opencode") return { models: await readOpenCodeSdkModels(executable, environment, cwd), rateLimits: [] };
  return { models: [], rateLimits: [] };
}
