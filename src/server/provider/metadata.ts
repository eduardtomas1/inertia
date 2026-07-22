import { readCodexMetadata, type CodexMetadata } from "../codex-metadata";
import type { ProviderId } from "./contracts";

export type ProviderMetadata = CodexMetadata;

/** Provider-specific metadata access; caching policy belongs above this seam. */
export async function readProviderMetadata(
  providerId: ProviderId,
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<ProviderMetadata> {
  if (providerId !== "codex") return { models: [], rateLimits: [] };
  return await readCodexMetadata(executable, environment, cwd);
}
