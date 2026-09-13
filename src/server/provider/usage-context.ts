import { providerChildEnvironment, providerEnvironment } from "../environment";
import { providerNativeBackendProfile } from "../../shared/model-routing";
import { ProviderRuntimeError, type ProviderInstallationUseTransfer } from "./contracts";
import type { ProviderManagerInstallationAuthority } from "./provider-manager-installation";
import { readClaudeAgentSdkMetadata } from "./claude-agent-sdk-metadata";
import { isProcessTreeTerminationUnconfirmed, ProcessTreeTerminationError } from "../process-lifecycle";

export interface CodexControlContext {
  executable: string; environment: NodeJS.ProcessEnv; cwd: string;
  installationUse: ProviderInstallationUseTransfer;
}
export async function codexUsageContext(cwd: string, resolveExecutable: () => Promise<string | undefined>, installation: ProviderManagerInstallationAuthority, rememberEnvironment: (env: NodeJS.ProcessEnv) => void): Promise<CodexControlContext> {
  const executable = await resolveExecutable();
  if (!executable) throw new ProviderRuntimeError("invalid_input", "Codex CLI is not installed.");
  const { env } = await providerEnvironment(); rememberEnvironment(env);
  return { executable, environment: providerChildEnvironment("codex", env), cwd,
    installationUse: installation.transfer(installation.acquire("codex", executable, providerNativeBackendProfile("codex"), "provider-server", installation.operationIdentity("provider-server"))) };
}
export async function readManagedClaudeUsage(executable: string | undefined, cwd: string, installation: ProviderManagerInstallationAuthority, signal: AbortSignal): ReturnType<typeof readClaudeAgentSdkMetadata> {
  if (!executable) throw new Error("Claude CLI is unavailable.");
  const { env } = await providerEnvironment();
  const admission = installation.acquire("claude", executable, providerNativeBackendProfile("claude"), "metadata-discovery", installation.operationIdentity("metadata-discovery"));
  const release = (): void => {
    if (!installation.release(admission)) {
      installation.quarantine(admission, "claude-usage-release-unconfirmed");
      throw new ProcessTreeTerminationError("Claude usage installation authority");
    }
  };
  let result: Awaited<ReturnType<typeof readClaudeAgentSdkMetadata>>;
  try {
    result = await readClaudeAgentSdkMetadata(executable, providerChildEnvironment("claude", env), cwd, 6000, undefined, ["rateLimits"], {}, signal, true);
  } catch (error) {
    if (isProcessTreeTerminationUnconfirmed(error)) {
      installation.quarantine(admission, "claude-usage-cleanup-unconfirmed");
    } else release();
    throw error;
  }
  // The reader awaits its tree barrier even on an ordinary timeout/cancellation.
  release();
  return result;
}
