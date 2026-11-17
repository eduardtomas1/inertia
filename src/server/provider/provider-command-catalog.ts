import { realpath } from "node:fs/promises";

import type { ProviderSlashCommand } from "../../shared/contracts";
import { providerNativeBackendProfile } from "../../shared/model-routing";
import type { ProviderId } from "../../shared/provider";
import { providerChildEnvironment, providerEnvironment } from "../environment";
import { isProcessTreeTerminationUnconfirmed } from "../process-lifecycle";
import { readClaudeAgentSdkMetadata } from "./claude-agent-sdk-metadata";
import { ProviderRuntimeError } from "./contracts";
import type { ProviderManagerInstallationAuthority } from "./provider-manager-installation";
import { SLASH_COMMAND_PROVIDERS } from "./provider-slash-commands";

const CLAUDE_COMMAND_CACHE_TTL_MS = 30 * 60 * 1_000;

export interface ProviderCommandCatalogDependencies {
  installationAuthority: ProviderManagerInstallationAuthority;
  /** The executable the runtime currently resolves for a provider, if any. */
  resolvedCommand(providerId: ProviderId): string | undefined;
  /** Resolves Claude's executable, detecting it when not yet resolved. */
  claudeExecutable(cwd: string): Promise<string>;
  /** Runs an owned provider read so runtime shutdown can await it. */
  trackAuxiliary<T>(operation: () => Promise<T>): Promise<T>;
  rememberEnvironment(environment: NodeJS.ProcessEnv): void;
  signal: AbortSignal;
}

/**
 * The slash commands each provider runs from a `/name` prompt. Claude Code
 * answers on demand; ACP providers advertise theirs during a session, so they
 * are known once that provider has run in this runtime. Providers without a
 * command list return none. Failures are never cached.
 */
export class ProviderCommandCatalog {
  private readonly claudeCache = new Map<string, {
    expiresAt: number;
    commands: Promise<ProviderSlashCommand[]>;
  }>();
  private readonly sessionCommands = new Map<ProviderId, {
    executable: string | null;
    commands: ProviderSlashCommand[];
  }>();

  constructor(private readonly dependencies: ProviderCommandCatalogDependencies) {}

  async list(providerId: ProviderId, cwd: string): Promise<ProviderSlashCommand[]> {
    if (providerId === "claude") return await this.claudeCommands(cwd);
    if (!SLASH_COMMAND_PROVIDERS.includes(providerId)) return [];
    const learned = this.sessionCommands.get(providerId);
    const executable = this.dependencies.resolvedCommand(providerId) ?? null;
    return learned && learned.executable === executable ? learned.commands : [];
  }

  /** Records the commands an ACP provider advertised during a run. */
  learn(providerId: ProviderId, commands: readonly ProviderSlashCommand[]): void {
    if (providerId === "claude" || !SLASH_COMMAND_PROVIDERS.includes(providerId)) return;
    this.sessionCommands.set(providerId, {
      executable: this.dependencies.resolvedCommand(providerId) ?? null,
      commands: [...commands],
    });
  }

  /**
   * Read under the same isolated settings every Inertia turn uses. The list
   * depends on the installed CLI, not the folder, so it is shared per resolved
   * executable (a CLI update changes the resolved path) and refreshed after a
   * while in case an update kept the same path.
   */
  private async claudeCommands(cwd: string): Promise<ProviderSlashCommand[]> {
    const executable = await this.dependencies.claudeExecutable(cwd);
    const key = await realpath(executable).catch(() => executable);
    const now = Date.now();
    const cached = this.claudeCache.get(key);
    if (cached && cached.expiresAt > now) return await cached.commands;
    const entry = {
      expiresAt: now + CLAUDE_COMMAND_CACHE_TTL_MS,
      commands: this.dependencies.trackAuxiliary(async () => await this.readClaude(executable, cwd)),
    };
    this.claudeCache.set(key, entry);
    try {
      return await entry.commands;
    } catch (error) {
      if (this.claudeCache.get(key) === entry) this.claudeCache.delete(key);
      throw error;
    }
  }

  private async readClaude(executable: string, cwd: string): Promise<ProviderSlashCommand[]> {
    const { installationAuthority } = this.dependencies;
    const environment = await providerEnvironment();
    this.dependencies.rememberEnvironment(environment.env);
    const admission = installationAuthority.acquire(
      "claude",
      executable,
      providerNativeBackendProfile("claude"),
      "metadata-discovery",
      installationAuthority.operationIdentity("metadata-discovery"),
    );
    let commands: ProviderSlashCommand[];
    try {
      const read = await readClaudeAgentSdkMetadata(
        executable,
        providerChildEnvironment("claude", environment.env),
        cwd,
        6_000,
        undefined,
        ["commands"],
        {},
        this.dependencies.signal,
      );
      // A rejected SDK read settles as a missing field; it must not be cached
      // as an empty command list.
      if (!read.commands) throw new Error("Claude did not report its slash commands.");
      commands = read.commands;
    } catch (error) {
      if (isProcessTreeTerminationUnconfirmed(error)) {
        installationAuthority.quarantineUnconfirmedCleanup(
          admission,
          "claude-command-discovery-cleanup-unconfirmed",
        );
      } else {
        installationAuthority.release(admission);
      }
      throw error;
    }
    if (!installationAuthority.release(admission)) {
      throw new ProviderRuntimeError(
        "lifecycle_corruption",
        "Claude command discovery could not release exact installation authority.",
      );
    }
    return commands;
  }
}
