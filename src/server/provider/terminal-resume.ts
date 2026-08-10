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

export interface ProviderTerminalResumeAuthority {
  reserve(conversationId: string): boolean;
  reserveAtCheckout(
    reservationId: string,
    projectId: string,
    checkoutPath: string,
  ): boolean;
  release(conversationId: string): void;
}

export class ProviderTerminalResumeRegistry {
  private readonly conversationIds = new Set<string>();

  constructor(
    private readonly authority?: ProviderTerminalResumeAuthority,
  ) {}

  isActive(conversationId: string): boolean {
    return this.conversationIds.has(conversationId);
  }

  acquire(conversationId: string): boolean {
    if (this.conversationIds.has(conversationId)) return false;
    if (this.authority && !this.authority.reserve(conversationId)) {
      return false;
    }
    this.conversationIds.add(conversationId);
    return true;
  }

  acquireAtCheckout(
    conversationId: string,
    projectId: string,
    checkoutPath: string,
  ): boolean {
    if (this.conversationIds.has(conversationId)) return false;
    if (
      this.authority
      && !this.authority.reserveAtCheckout(
        conversationId,
        projectId,
        checkoutPath,
      )
    ) return false;
    this.conversationIds.add(conversationId);
    return true;
  }

  release(conversationId: string): void {
    if (!this.conversationIds.delete(conversationId)) return;
    this.authority?.release(conversationId);
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
