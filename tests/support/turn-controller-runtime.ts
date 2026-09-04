import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  ModelSelection,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import type { ProviderEvent } from "../../src/server/provider/contracts";
import {
  TurnController,
  type TurnControllerHooks,
  type TurnProviderRuntime,
} from "../../src/server/runtime/turns/turn-controller";
import {
  FakeTurnProvider,
  FakeTurnScheduler,
} from "./fake-turn-provider";

const directories: string[] = [];

export function turnControllerTestProviderInfo(): ProviderInfo {
  const field = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id: "codex",
    label: "Codex",
    command: "fake-codex",
    available: true,
    version: "test",
    executable: "fake-codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: "gpt-test",
      label: "GPT Test",
      description: "Fake model",
      isDefault: true,
      inputModalities: ["text", "image"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
      fastMode: {
        providerValue: "priority",
        label: "Fast",
        description: "Faster responses",
        isDefault: false,
      },
    }, {
      id: "gpt-next",
      label: "GPT Next",
      description: "Second fake model",
      isDefault: false,
      inputModalities: ["text", "image"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
      fastMode: {
        providerValue: "priority",
        label: "Fast",
        description: "Faster responses",
        isDefault: false,
      },
    }],
    rateLimits: [],
    metadataState: { models: field, rateLimits: field },
    capabilityContract: {
      schemaVersion: 1,
      harnessId: "codex-app-server",
      manifestDigest: "a".repeat(64),
      installationVerified: true,
      installedVersion: "test",
      currentlyAvailableCount: 28,
      declaredCapabilityCount: 28,
      hostToolBridgeAvailable: true,
    },
  };
}

export interface TurnControllerTestRuntime {
  directory: string;
  workspace: string;
  store: RuntimeStore;
  provider: FakeTurnProvider;
  scheduler: FakeTurnScheduler;
  controller: TurnController;
  conversationId: string;
  events: ServerEvent[];
  settled: string[];
  gitArtifacts: string[];
  metadataRefreshes: string[];
  attachmentReleases: string[][];
}

export function turnControllerTestContinuationState(
  store: RuntimeStore,
  conversationId: string,
) {
  const conversation = store.conversation(conversationId);
  return {
    providerSessionId: conversation.providerSessionId,
    continuationIdentity: conversation.continuationIdentity,
  };
}

interface TurnControllerTestRuntimeOptions {
  interactionMode?: "build" | "plan";
  modelSelection?: ModelSelection;
  resolveModelRoute?: TurnProviderRuntime["resolveModelRoute"];
}

export async function createTurnControllerTestRuntime(
  hookOverrides: Partial<TurnControllerHooks> = {},
  options: TurnControllerTestRuntimeOptions = {},
): Promise<TurnControllerTestRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-turn-controller-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  directories.push(directory);
  const store = new RuntimeStore(
    join(directory, "inertia.sqlite"),
    workspace,
    { recoverInterruptedRuns: false },
  );
  const project = store.createProject("Turn project", workspace);
  const conversation = store.createConversation(project.id, "Turn conversation", {
    ...(options.modelSelection
      ? { modelSelection: options.modelSelection }
      : {
          providerId: "codex" as const,
          model: "gpt-test",
          reasoningEffort: "high",
        }),
    interactionMode: options.interactionMode ?? "build",
    accessMode: "supervised",
  });
  const provider = new FakeTurnProvider();
  if (options.resolveModelRoute) {
    provider.resolveModelRoute = options.resolveModelRoute;
  }
  const scheduler = new FakeTurnScheduler();
  const events: ServerEvent[] = [];
  const settled: string[] = [];
  const gitArtifacts: string[] = [];
  const metadataRefreshes: string[] = [];
  const attachmentReleases: string[][] = [];
  const pendingApprovals = new Map<string, AgentApprovalRequest>();
  const pendingInputs = new Map<string, AgentInputRequest>();
  const plans = new Map<string, AgentPlan>();
  let sequence = 0;
  let clockMs = Date.parse("2030-01-01T00:00:00.000Z");
  const controller = new TurnController(
    store,
    provider,
    pendingApprovals,
    pendingInputs,
    plans,
    {
      broadcast: (event) => events.push(event),
      broadcastSnapshot: () => undefined,
      providerInfo: () => [turnControllerTestProviderInfo()],
      captureStructuredContext: ({ content }) => ({ visibleRequest: content }),
      onStructuredContextCaptured: ({ turn }) => {
        settled.push(`context:${turn.id}`);
      },
      captureGitArtifacts: ({ turn }) => {
        gitArtifacts.push(turn.id);
      },
      refreshProviderMetadata: ({ turnId }) => {
        metadataRefreshes.push(turnId);
      },
      releaseTurnAttachments: ({ attachmentIds }) => {
        attachmentReleases.push([...attachmentIds]);
      },
      onTurnSettled: (turn) => {
        settled.push(`${turn.status}:${turn.id}`);
      },
      ...hookOverrides,
    },
    {
      scheduler,
      clock: () => new Date(clockMs++),
      id: () => `controller-id-${++sequence}`,
      turnTimeoutMs: 1_000,
    },
  );
  return {
    directory,
    workspace,
    store,
    provider,
    scheduler,
    controller,
    conversationId: conversation.id,
    events,
    settled,
    gitArtifacts,
    metadataRefreshes,
    attachmentReleases,
  };
}

export async function turnControllerTestAttachment(
  runtime: Pick<TurnControllerTestRuntime, "workspace">,
  id: string,
  name = `${id}.png`,
) {
  const path = join(runtime.workspace, name);
  const bytes = Buffer.from("89504e470d0a1a0a", "hex");
  await writeFile(path, bytes);
  return {
    id,
    name,
    path,
    mimeType: "image/png" as const,
    size: bytes.byteLength,
  };
}

export function turnControllerTestIdentity(runtime: TurnControllerTestRuntime) {
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
  TestSubagentEvent,
  "sequence" | "providerTaskId" | "status" | "isLive"
>;

export function emitTurnControllerTestSubagent(
  runtime: TurnControllerTestRuntime,
  event: TestSubagentUpdate,
): void {
  runtime.provider.emit({
    ...turnControllerTestIdentity(runtime),
    type: "subagent",
    providerAgentId: null,
    parentProviderAgentId: null,
    parentProviderToolUseId: null,
    providerToolUseId: null,
    providerRole: null,
    providerName: null,
    providerStatus: null,
    description: null,
    progress: null,
    result: null,
    ...event,
  });
}

export async function flushTurnControllerTestPromises(): Promise<void> {
  // Provider cleanup now joins the exact stopOwned receipt, terminal
  // persistence, follow-up drain, and attachment release before its barrier
  // settles. Drain the complete bounded microtask chain for test assertions.
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

export async function cleanupTurnControllerTestDirectories(): Promise<void> {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
}
