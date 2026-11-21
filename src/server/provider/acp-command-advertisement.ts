import type { ProviderSlashCommand } from "../../shared/contracts";
import type { ProviderId } from "../../shared/provider";
import type { AgentHarnessEmitter } from "./agent-harness";
import { parseAcpSessionNotification } from "./acp-json-rpc";
import { acpSlashCommands } from "./provider-slash-commands";

const MAX_PENDING_ADVERTISED_SESSIONS = 8;

function commandAdvertisementUpdate(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const update = (value as { update?: unknown }).update;
  return typeof update === "object"
    && update !== null
    && (update as { sessionUpdate?: unknown }).sessionUpdate === "available_commands_update";
}

export function parseAcpSessionNotificationOrIgnoredCommands(
  value: unknown,
): ReturnType<typeof parseAcpSessionNotification> | null {
  try {
    return parseAcpSessionNotification(value);
  } catch (error) {
    if (commandAdvertisementUpdate(value)) return null;
    throw error;
  }
}

export class AcpCommandAdvertisements {
  private readonly pending = new Map<string, ProviderSlashCommand[]>();
  private sessionId: string | null = null;

  constructor(
    private readonly providerId: ProviderId,
    private readonly emitter: Pick<AgentHarnessEmitter, "rich">,
    knownSessionId?: string,
  ) {
    if (knownSessionId) this.sessionId = knownSessionId;
  }

  observe(sessionId: string, availableCommands: readonly unknown[]): void {
    const commands = acpSlashCommands(this.providerId, availableCommands);
    if (this.sessionId !== null) {
      if (sessionId === this.sessionId) this.publish(commands);
      return;
    }
    this.pending.delete(sessionId);
    this.pending.set(sessionId, commands);
    while (this.pending.size > MAX_PENDING_ADVERTISED_SESSIONS) {
      this.pending.delete(this.pending.keys().next().value!);
    }
  }

  establish(sessionId: string): void {
    if (this.sessionId !== null || !sessionId) return;
    this.sessionId = sessionId;
    const commands = this.pending.get(sessionId);
    this.pending.clear();
    if (commands) this.publish(commands);
  }

  private publish(commands: ProviderSlashCommand[]): void {
    this.emitter.rich({
      type: "metadata",
      metadata: { commands },
      source: "session",
      complete: true,
    });
  }
}
