import { realpath } from "node:fs/promises";

import type { ProviderSlashCommand } from "../../shared/contracts";
import { providerNativeBackendProfile } from "../../shared/model-routing";
import type { ProviderId } from "../../shared/provider";
import { providerChildEnvironment, providerEnvironment } from "../environment";
import { isProcessTreeTerminationUnconfirmed } from "../process-lifecycle";
import { normalizeIdentityPath } from "../project-identity";
import { readClaudeAgentSdkMetadata } from "./claude-agent-sdk-metadata";
import type { ClaudeQueryFactory } from "./claude-skill-query";
import { ProviderRuntimeError } from "./contracts";
import type { ProviderManagerInstallationAuthority } from "./provider-manager-installation";
import { SLASH_COMMAND_PROVIDERS } from "./provider-slash-commands";

const CLAUDE_COMMAND_CACHE_TTL_MS = 30 * 60 * 1_000;
export const CLAUDE_COMMAND_FAILURE_TTL_MS = 60 * 1_000;
const MAX_LEARNED_COMMAND_LISTS = 256;

export interface ProviderCommandScope {
  providerId: ProviderId;
  cwd: string;
  conversationId: string | null;
}

export interface ProviderCommandRunIdentity {
  conversationId: string;
  providerId: ProviderId;
  cwd: string;
}

export interface ProviderCommandCatalogDependencies {
  installationAuthority: Pick<
    ProviderManagerInstallationAuthority,
    "acquire" | "operationIdentity" | "release" | "quarantineUnconfirmedCleanup"
  >;
  resolvedCommand(providerId: ProviderId): string | undefined;
  claudeExecutable(cwd: string): Promise<string>;
  trackAuxiliary<T>(operation: () => Promise<T>): Promise<T>;
  rememberEnvironment(environment: NodeJS.ProcessEnv): void;
  signal: AbortSignal;
  claudeQuery?: ClaudeQueryFactory;
  now?: () => number;
}

interface LearnedCommands {
  executable: string | null;
  workspace: string;
  commands: readonly ProviderSlashCommand[];
}

function remember(lists: Map<string, LearnedCommands>, key: string, entry: LearnedCommands): void {
  lists.delete(key);
  lists.set(key, entry);
  while (lists.size > MAX_LEARNED_COMMAND_LISTS) {
    const oldest = lists.keys().next().value;
    if (oldest === undefined) return;
    lists.delete(oldest);
  }
}

export function providerCommandIntegrityFailure(error: unknown): boolean {
  return (error instanceof ProviderRuntimeError && error.code === "lifecycle_corruption")
    || isProcessTreeTerminationUnconfirmed(error);
}

function learnsFromSession(providerId: ProviderId): boolean {
  return providerId !== "claude" && SLASH_COMMAND_PROVIDERS.includes(providerId);
}

export class ProviderCommandCatalog {
  private readonly claudeCache = new Map<string, {
    expiresAt: number;
    commands: Promise<ProviderSlashCommand[]>;
  }>();
  private readonly claudeFailures = new Map<string, { expiresAt: number; error: unknown }>();
  private readonly conversationCommands = new Map<string, LearnedCommands>();
  private readonly workspaceCommands = new Map<string, LearnedCommands>();

  constructor(private readonly dependencies: ProviderCommandCatalogDependencies) {}

  async list(scope: ProviderCommandScope): Promise<ProviderSlashCommand[]> {
    if (scope.providerId === "claude") return await this.claudeCommands(scope.cwd);
    if (!learnsFromSession(scope.providerId)) return [];
    const executable = this.dependencies.resolvedCommand(scope.providerId) ?? null;
    const workspace = normalizeIdentityPath(scope.cwd);
    const current = (entry: LearnedCommands | undefined): readonly ProviderSlashCommand[] | undefined =>
      entry && entry.executable === executable && entry.workspace === workspace ? entry.commands : undefined;
    const conversation = scope.conversationId === null
      ? undefined
      : this.conversationCommands.get(`${scope.providerId}\0${scope.conversationId}`);
    return [
      ...(current(conversation)
        ?? current(this.workspaceCommands.get(`${scope.providerId}\0${workspace}`))
        ?? []),
    ];
  }

  learn(identity: ProviderCommandRunIdentity, commands: readonly ProviderSlashCommand[]): void {
    if (!learnsFromSession(identity.providerId)) return;
    const entry: LearnedCommands = {
      executable: this.dependencies.resolvedCommand(identity.providerId) ?? null,
      workspace: normalizeIdentityPath(identity.cwd),
      commands: [...commands],
    };
    remember(this.conversationCommands, `${identity.providerId}\0${identity.conversationId}`, entry);
    remember(this.workspaceCommands, `${identity.providerId}\0${entry.workspace}`, entry);
  }

  forgetFailures(providerId: ProviderId): void {
    if (providerId === "claude") this.claudeFailures.clear();
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private async claudeCommands(cwd: string): Promise<ProviderSlashCommand[]> {
    const executable = await this.dependencies.claudeExecutable(cwd);
    const key = await realpath(executable).catch(() => executable);
    const now = this.now();
    const failure = this.claudeFailures.get(key);
    if (failure && failure.expiresAt > now) throw failure.error;
    this.claudeFailures.delete(key);
    const cached = this.claudeCache.get(key);
    if (cached && cached.expiresAt > now) return [...await cached.commands];
    const entry = {
      expiresAt: now + CLAUDE_COMMAND_CACHE_TTL_MS,
      commands: this.dependencies.trackAuxiliary(async () => await this.readClaude(executable, cwd)),
    };
    this.claudeCache.set(key, entry);
    try {
      return [...await entry.commands];
    } catch (error) {
      if (this.claudeCache.get(key) === entry) {
        this.claudeCache.delete(key);
        if (!this.dependencies.signal.aborted && !providerCommandIntegrityFailure(error)) {
          this.claudeFailures.set(key, { expiresAt: this.now() + CLAUDE_COMMAND_FAILURE_TTL_MS, error });
        }
      }
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
        this.dependencies.claudeQuery,
        ["commands"],
        {},
        this.dependencies.signal,
      );
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
