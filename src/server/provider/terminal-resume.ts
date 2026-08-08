import type { ProviderId } from "./contracts";
import { isProviderTerminalSessionId } from "../../shared/provider-terminal-resume";
import {
  providerProcessInvocation,
  providerPtyArguments,
  type ProviderProcessInvocation,
} from "./process";

export interface ProviderTerminalResumeLaunch {
  executable: string;
  args: readonly string[] | string;
  env: NodeJS.ProcessEnv;
}

export class ProviderTerminalResumeRegistry {
  private readonly conversationIds = new Set<string>();

  isActive(conversationId: string): boolean {
    return this.conversationIds.has(conversationId);
  }

  acquire(conversationId: string): boolean {
    if (this.conversationIds.has(conversationId)) return false;
    this.conversationIds.add(conversationId);
    return true;
  }

  release(conversationId: string): void {
    this.conversationIds.delete(conversationId);
  }
}

export function providerTerminalResumeArguments(
  providerId: ProviderId,
  sessionId: string,
): string[] {
  if (!isProviderTerminalSessionId(sessionId)) {
    throw new Error("The saved provider session ID is invalid or stale.");
  }
  switch (providerId) {
    case "codex":
      return ["resume", sessionId];
    case "claude":
    case "cursor":
      return ["--resume", sessionId];
    case "opencode":
      return ["--session", sessionId];
  }
}

export function providerTerminalResumeProcessInvocation(
  executable: string,
  providerId: ProviderId,
  sessionId: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ProviderProcessInvocation {
  return providerProcessInvocation(
    executable,
    providerTerminalResumeArguments(providerId, sessionId),
    environment,
    platform,
  );
}

export function providerTerminalResumeLaunch(
  executable: string,
  providerId: ProviderId,
  sessionId: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): ProviderTerminalResumeLaunch {
  const invocation = providerTerminalResumeProcessInvocation(
    executable,
    providerId,
    sessionId,
    environment,
    platform,
  );
  return {
    executable: invocation.command,
    args: providerPtyArguments(invocation),
    env: environment,
  };
}
