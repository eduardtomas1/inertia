import {
  customAgentHandleFromNativeName,
  customAgentNativeName,
  type CustomAgentCallAttribution,
} from "../../../shared/custom-agents";
import type { ProviderId, ProviderSubagentEvent } from "../../provider/contracts";

type TraceIdentity = Pick<
  ProviderSubagentEvent,
  | "providerTaskId"
  | "providerAgentId"
  | "providerToolUseId"
  | "parentProviderAgentId"
  | "parentProviderToolUseId"
  | "providerRole"
  | "providerName"
>;

const ROLE_ATTESTED_PROVIDERS: ReadonlySet<ProviderId> = new Set(["claude"]);

export class CustomAgentTraceAttribution {
  private readonly byTask = new Map<string, string | null>();
  private readonly byAgent = new Map<string, string | null>();
  private readonly byToolUse = new Map<string, string | null>();
  private readonly nativeName: string;
  private readonly fallback: boolean;
  private attributed = false;

  constructor(
    private readonly call: Pick<CustomAgentCallAttribution, "agentId" | "handle">,
    providerId: ProviderId,
  ) {
    this.nativeName = customAgentNativeName(call.handle);
    this.fallback = !ROLE_ATTESTED_PROVIDERS.has(providerId);
  }

  resolve(trace: TraceIdentity): string | null {
    const known = this.known(trace);
    if (known) return known;
    const parent = this.parent(trace);
    const customAgentId = this.matches(trace)
      ? this.call.agentId
      : parent !== undefined
        ? parent
        : this.fallback && !this.attributed
          ? this.call.agentId
          : null;
    this.record(trace, customAgentId);
    return customAgentId;
  }

  private matches(trace: TraceIdentity): boolean {
    return [trace.providerRole, trace.providerName].some((value) => {
      const normalized = value?.trim().toLowerCase();
      return normalized === this.nativeName
        || customAgentHandleFromNativeName(normalized) === this.call.handle;
    });
  }

  private known(trace: TraceIdentity): string | null {
    return (trace.providerTaskId ? this.byTask.get(trace.providerTaskId) : null)
      ?? (trace.providerAgentId ? this.byAgent.get(trace.providerAgentId) : null)
      ?? (trace.providerToolUseId ? this.byToolUse.get(trace.providerToolUseId) : null)
      ?? null;
  }

  private parent(trace: TraceIdentity): string | null | undefined {
    if (trace.parentProviderAgentId && this.byAgent.has(trace.parentProviderAgentId)) {
      return this.byAgent.get(trace.parentProviderAgentId);
    }
    if (trace.parentProviderToolUseId && this.byToolUse.has(trace.parentProviderToolUseId)) {
      return this.byToolUse.get(trace.parentProviderToolUseId);
    }
    return undefined;
  }

  private record(trace: TraceIdentity, customAgentId: string | null): void {
    if (customAgentId) this.attributed = true;
    const entries: Array<[Map<string, string | null>, string | null]> = [
      [this.byTask, trace.providerTaskId],
      [this.byAgent, trace.providerAgentId],
      [this.byToolUse, trace.providerToolUseId],
    ];
    for (const [map, key] of entries) {
      if (key && (customAgentId || !map.has(key))) map.set(key, customAgentId);
    }
  }
}
