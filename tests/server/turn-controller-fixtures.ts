import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProviderInfo } from "../../src/shared/contracts";
import type { ProviderEvent } from "../../src/server/provider/contracts";
import { FakeTurnProvider } from "../support/fake-turn-provider";

export function providerInfo(): ProviderInfo {
  const field = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id: "codex", label: "Codex", command: "fake-codex", available: true,
    version: "test", executable: "fake-codex", installState: "installed",
    authState: "authenticated", canRun: true, statusMessage: null,
    models: [{
      id: "gpt-test", label: "GPT Test", description: "Fake model", isDefault: true,
      inputModalities: ["text", "image"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
      fastMode: { providerValue: "priority", label: "Fast", description: "Faster responses", isDefault: false },
    }, {
      id: "gpt-next", label: "GPT Next", description: "Second fake model", isDefault: false,
      inputModalities: ["text", "image"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
      fastMode: { providerValue: "priority", label: "Fast", description: "Faster responses", isDefault: false },
    }],
    rateLimits: [],
    metadataState: { models: field, rateLimits: field },
  };
}

interface RuntimeIdentitySource {
  provider: FakeTurnProvider;
  conversationId: string;
}

export async function testAttachment(
  runtime: { workspace: string }, id: string, name = `${id}.png`,
) {
  const path = join(runtime.workspace, name);
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  await writeFile(path, bytes);
  return { id, name, path, mimeType: "image/png" as const, size: bytes.byteLength };
}

export function identity(runtime: RuntimeIdentitySource) {
  const input = runtime.provider.input;
  if (!input?.runId || !input.turnId) throw new Error("Turn is not started.");
  return {
    providerId: input.providerId,
    conversationId: runtime.conversationId,
    runId: input.runId,
    turnId: input.turnId,
  } as const;
}

type TestSubagentEvent = Extract<ProviderEvent, { type: "subagent" }>;
type TestSubagentUpdate = Partial<TestSubagentEvent> & Pick<
  TestSubagentEvent, "sequence" | "providerTaskId" | "status" | "isLive">;

export function emitSubagent(runtime: RuntimeIdentitySource, event: TestSubagentUpdate): void {
  runtime.provider.emit({
    ...identity(runtime),
    type: "subagent",
    providerAgentId: null, parentProviderAgentId: null,
    parentProviderToolUseId: null, providerToolUseId: null,
    providerRole: null, providerName: null, providerStatus: null,
    description: null, progress: null, result: null,
    ...event,
  });
}
