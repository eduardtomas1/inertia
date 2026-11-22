import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BackendCompatibilityProbeRequest,
  BackendCompatibilityProbeResult,
} from "../../src/shared/backend-probe";
import type { ModelBackendProfileDraft } from "../../src/shared/backend-profile-settings";
import { createKimiClaudeBackendProfile, KIMI_CODING_MODELS } from "../../src/shared/claude-backend-profiles";
import type { ModelSelection, ProviderInfo, ProviderModel } from "../../src/shared/contracts";
import {
  MODEL_CAPABILITY_IDS,
  providerIdForHarness,
  providerNativeBackendProfile,
  providerNativeModelSelection,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import type { ProviderHostToolCall } from "../../src/server/provider/contracts";
import {
  MAX_LISTED_MODELS_PER_BACKEND,
  MODEL_LIST_TOOL_DEFINITION,
  listModelRoutes,
} from "../../src/server/runtime/agent-model-routes";
import { AgentThreadManager } from "../../src/server/runtime/agent-thread-manager";
import { ConversationContextRequestCoordinator } from "../../src/server/runtime/conversation-context-request-coordinator";

const probeCompatibility = vi.hoisted(() =>
  vi.fn<(request: BackendCompatibilityProbeRequest) => Promise<BackendCompatibilityProbeResult>>());

vi.mock(
  "../../src/server/runtime/backends/backend-compatibility-probe",
  () => ({ probeBackendCompatibility: probeCompatibility }),
);

import { BackendProfileController } from "../../src/server/runtime/backends/backend-profile-controller";

const directories: string[] = [];
const stores: RuntimeStore[] = [];
const RESULT_CAP = 32 * 1024;
const GATEWAY = "gateway.example.test";
const STATUS_SECRET = "someone@example.com signed in from /Users/alice/.config";

afterEach(async () => {
  probeCompatibility.mockReset();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function probe(request: BackendCompatibilityProbeRequest, ok: boolean): BackendCompatibilityProbeResult {
  const at = new Date().toISOString();
  return {
    profileId: request.profile.id,
    backendConfigurationRevision: request.profile.configurationRevision,
    endpointIdentity: request.profile.endpointIdentity,
    protocol: request.profile.protocol,
    modelId: request.modelId,
    compatibility: ok ? "protocol-compatible" : "unavailable",
    protocolVerified: ok,
    modelVerified: ok,
    capabilities: MODEL_CAPABILITY_IDS.map((id) => ({ id, state: "verified", provenance: "probe", detail: null, checkedAt: at })),
    contextWindow: { tokens: 200_000, state: "verified", provenance: "probe", detail: null, checkedAt: at },
    failure: ok ? null : { code: "invalid-credentials", message: `${GATEWAY} rejected the key.`, retryAfterSeconds: null },
    checkedAt: at,
  };
}

function model(id: string, efforts: string[], isDefault = false): ProviderModel {
  return {
    id,
    label: id.toUpperCase(),
    description: "",
    isDefault,
    inputModalities: ["text"],
    reasoningOptions: efforts.map((value) => ({ value, label: value, description: value })),
    defaultReasoningEffort: efforts[0] ?? "",
  } as ProviderModel;
}

function provider(id: ProviderInfo["id"], overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  const state = (freshness: "fresh" | "unavailable") => ({
    freshness, provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false,
  });
  return {
    id,
    label: id,
    command: id,
    available: true,
    version: "9.9.9",
    executable: `/opt/bin/${id}`,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: STATUS_SECRET,
    models: [],
    rateLimits: [],
    metadataState: { models: state("fresh"), rateLimits: state("unavailable") },
    ...overrides,
  } as ProviderInfo;
}

const PROVIDERS: ProviderInfo[] = [
  provider("codex", { models: [model("gpt-a", ["low", "medium", "high"], true), model("gpt-b", [])] }),
  provider("claude", { models: [model("claude-x", ["low", "high"], true)] }),
  provider("cursor", { authState: "unauthenticated", canRun: false }),
  provider("opencode", { canRun: false, updateRequired: { installedVersion: "1.0.0", minimumVersion: "1.18.22" } }),
];

function gatewayDraft(displayName: string): ModelBackendProfileDraft {
  return {
    displayName,
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    preset: "custom",
    baseUrl: `https://${GATEWAY}/v1/`,
    allowInsecureLocalhost: false,
    models: [
      { id: "alpha", displayName: "Model alpha", contextWindowTokens: null, capabilities: [], reasoningOptions: [
        { value: "low", label: "Low", description: "Low" },
        { value: "high", label: "High", description: "High" },
      ] },
      { id: "beta", displayName: "beta", contextWindowTokens: null, capabilities: [], reasoningOptions: [] },
    ],
    routing: { mode: "simple", primaryModelId: "alpha" },
    capabilityHints: [],
  };
}

async function runtime() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-model-list-"));
  directories.push(directory);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), directory);
  stores.push(store);
  const credentials = {
    resolve: async () => "test-credential-value",
    status: async () => ({ hasSecret: true, credentialGeneration: "generation:one" }),
    forget: async () => true,
  };
  const kimi = createKimiClaudeBackendProfile({
    id: "kimi:listed",
    secretReference: "secret:kimi-listed",
    primaryModelId: KIMI_CODING_MODELS[0]!.id,
  });
  const controller = await BackendProfileController.create({ store, credentials, builtInClaudeProfiles: [kimi] });
  controller.profiles(PROVIDERS);
  // A tested gateway: alpha passed its connection test, beta failed it.
  const gateway = await controller.createProfile(gatewayDraft("Team gateway"));
  await controller.reconcileCredentialRevision(gateway.id, "generation:one");
  probeCompatibility.mockImplementation(async (request) => probe(request, request.modelId === "alpha"));
  await controller.probe(gateway.id);
  await controller.updateProfile(gateway.id, { enabled: true });
  // A gateway that was never turned on.
  const disabled = await controller.createProfile(gatewayDraft("Spare gateway"));
  probeCompatibility.mockReset();

  const project = store.createProject("Model list", directory);
  const source = store.createConversation(project.id, "Parent chat", {
    accessMode: "supervised",
    modelSelection: providerNativeModelSelection({ providerId: "codex", modelId: "gpt-a", alias: "GPT-A", reasoningEffort: "high" }),
  });
  const beginTurn = () => store.beginAgentTurn({
    id: randomUUID(),
    conversationId: source.id,
    runId: randomUUID(),
    content: "Pick a route",
    activateConversation: false,
    providerId: "codex",
    harnessId: source.modelSelection.harnessId,
    backendProfileId: source.modelSelection.backendProfileId,
    model: source.modelSelection.modelId,
    modelAlias: source.modelSelection.alias,
    reasoningEffort: source.modelSelection.reasoningEffort ?? "",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    usageAtStart: null,
    configurationRevision: source.modelSelection.backendConfigurationRevision,
    association: "authoritative",
  }).turn;
  const manager = new AgentThreadManager({
    store,
    providers: {
      resolveModelRoute: (selection: ModelSelection) => ({ providerId: providerIdForHarness(selection.harnessId) }),
    } as never,
    backendProfileController: controller,
    creation: { create: vi.fn() } as never,
    turns: { activeConversationIds: () => [], isActive: () => false } as never,
    providerTerminalResumes: { isActive: () => false, acquire: () => true, release: () => undefined },
    contextRequests: new ConversationContextRequestCoordinator({
      pendingInputs: new Map(),
      contextPackets: store.contextPackets,
      broadcast: vi.fn(),
      broadcastConversationShell: vi.fn(),
    }),
    providerInfo: () => PROVIDERS,
    broadcastSnapshot: vi.fn(),
    broadcastConversationShell: vi.fn(),
    broadcast: vi.fn(),
  });
  const invoke = async (tool: string, args: unknown) => {
    const call: ProviderHostToolCall = {
      providerThreadId: "provider-thread",
      providerTurnId: "provider-turn",
      toolCallId: randomUUID(),
      tool,
      arguments: args,
      signal: new AbortController().signal,
      requestApproval: vi.fn(async () => "deny" as const),
    };
    // A fresh turn per call keeps the per-turn creation allowance out of the way.
    const result = await manager.bridgeFor({ conversation: source, turn: beginTurn() }).invoke(call);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(RESULT_CAP);
    return { success: result.success, value: JSON.parse(result.text) as Record<string, unknown>, call };
  };
  return { store, controller, manager, gateway, disabled, kimi, source, beginTurn, invoke };
}

interface Listed {
  current: { backendProfileId: string; modelId: string; reasoningEffort: string | null };
  backends: Array<{
    backendProfileId: string;
    name: string;
    providerId: string;
    routeKind: string;
    usable: boolean;
    reason?: string;
    primaryModelId: string;
    models: Array<{ modelId: string; label?: string; reasoningEfforts?: string[]; usable?: false; reason?: string; current?: true }>;
  }>;
  truncated: boolean;
  next: string;
}

const SELECTION_ERRORS = /does not match|unavailable on this backend|Reasoning level|reasoning choices|no longer offered|Refresh provider models/u;

describe("inertia_list_models", () => {
  it("is a small read-only orchestration tool that takes only an optional backend filter", async () => {
    expect(MODEL_LIST_TOOL_DEFINITION).toMatchObject({ readOnly: true, inputSchema: { type: "object", additionalProperties: false } });
    expect(Object.keys(MODEL_LIST_TOOL_DEFINITION.inputSchema.properties as object)).toEqual(["backendProfileId"]);
    expect(MODEL_LIST_TOOL_DEFINITION.inputSchema.required).toBeUndefined();
    expect(MODEL_LIST_TOOL_DEFINITION.description.length).toBeLessThanOrEqual(300);
    const env = await runtime();
    const pack = env.manager.capabilityManifest().packs.find(({ id }) => id === "inertia.orchestration");
    expect(pack).toMatchObject({ revision: 5 });
    expect(pack?.toolNames).toContain("inertia_list_models");
    const create = env.manager.bridgeFor({ conversation: env.source, turn: env.beginTurn() }).definitions
      .find(({ name }) => name === "inertia_create_conversation");
    expect(create?.description).toContain("inertia_list_models");
    const { success, call } = await env.invoke("inertia_list_models", {});
    expect(success).toBe(true);
    expect(call.requestApproval).not.toHaveBeenCalled();
  });

  it("lists every route the user can take, marks the current one and what cannot run, and leaks no endpoint or account detail", async () => {
    const env = await runtime();
    const { success, value } = await env.invoke("inertia_list_models", {});
    expect(success).toBe(true);
    const listed = value as unknown as Listed;
    const byId = new Map(listed.backends.map((backend) => [backend.backendProfileId, backend]));
    const native = (id: ProviderInfo["id"]) => byId.get(providerNativeBackendProfile(id).id)!;

    expect(listed.current).toEqual({ backendProfileId: providerNativeBackendProfile("codex").id, modelId: "gpt-a", reasoningEffort: "high" });
    expect(native("codex")).toMatchObject({ providerId: "codex", routeKind: "account", usable: true, primaryModelId: "provider-default" });
    expect(native("codex").models).toEqual([
      { modelId: "provider-default", label: "Provider default", reasoningEfforts: ["low", "medium", "high"] },
      { modelId: "gpt-a", label: "GPT-A", reasoningEfforts: ["low", "medium", "high"], current: true },
      { modelId: "gpt-b", label: "GPT-B" },
    ]);
    expect(native("cursor")).toMatchObject({ usable: false, reason: "The user has not signed in to it." });
    expect(native("opencode")).toMatchObject({ usable: false, reason: "Its agent CLI needs an update." });
    expect(native("grok")).toMatchObject({ usable: false, reason: "Its agent CLI is not installed or could not start." });
    // Grok's built-in catalog is shown in Settings, but the route check accepts only provider-default.
    expect(native("grok").models.map(({ modelId }) => modelId)).toEqual(["provider-default"]);

    // The Kimi key route runs on the Claude harness, so its route providerId is claude.
    expect(byId.get(env.kimi.id)).toMatchObject({ providerId: "claude", routeKind: "api-key", usable: true });
    expect(byId.get(env.gateway.id)).toMatchObject({ name: "Team gateway", providerId: "claude", usable: true, primaryModelId: "alpha" });
    expect(byId.get(env.gateway.id)!.models).toEqual([
      { modelId: "alpha", label: "Model alpha", reasoningEfforts: ["low", "high"] },
      { modelId: "beta", usable: false, reason: "Its last connection test failed; the user can test it again in Settings." },
    ]);
    expect(byId.get(env.disabled.id)).toMatchObject({ usable: false, reason: "It is turned off in Settings." });

    const firstUnusable = listed.backends.findIndex(({ usable }) => !usable);
    expect(listed.backends.slice(firstUnusable).every(({ usable }) => !usable)).toBe(true);
    expect(listed.truncated).toBe(false);
    expect(listed.next).toContain("inertia_create_conversation");
    const text = JSON.stringify(value);
    for (const hidden of [GATEWAY, "api.kimi.com", "/opt/bin", "someone@example.com", "alice", "test-credential-value", "generation:one", "secret:"]) {
      expect(text).not.toContain(hidden);
    }
  });

  it("returns only routes inertia_create_conversation accepts, and its readiness check agrees with usable", async () => {
    const env = await runtime();
    const listed = (await env.invoke("inertia_list_models", {})).value as unknown as Listed;
    let checked = 0;
    for (const backend of listed.backends) {
      for (const entry of backend.models) {
        for (const reasoningEffort of [null, ...(entry.reasoningEfforts ?? [])]) {
          const route = { providerId: backend.providerId, backendProfileId: backend.backendProfileId, modelId: entry.modelId, reasoningEffort };
          const { success, value } = await env.invoke("inertia_create_conversation", { title: "Child", prompt: "Work", route });
          expect(success, JSON.stringify(route)).toBe(false);
          const error = value.error as { code: string; message: string };
          // Deny is answered only after the route passed validation and readiness.
          if (backend.usable && entry.usable !== false) {
            expect(error.code, `${JSON.stringify(route)}: ${error.message}`).toBe("user_denied");
          } else {
            expect(error.code, JSON.stringify(route)).toBe("host_tool_failed");
            expect(error.message, JSON.stringify(route)).not.toMatch(SELECTION_ERRORS);
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("resolves a create route through the real profile controller and names the field of a wrong one", async () => {
    const env = await runtime();
    const create = async (route: Record<string, unknown>) => (await env.invoke("inertia_create_conversation", {
      title: "Child", prompt: "Work", route,
    })).value.error as { code: string; message: string };
    // The controller's profile view used to be parsed as a stored profile, which refused every route.
    for (const route of [
      { backendProfileId: env.gateway.id, modelId: "alpha", reasoningEffort: "high" },
      { backendProfileId: env.gateway.id },
      { modelId: "gpt-b", reasoningEffort: null },
      { reasoningEffort: "low" },
      { providerId: "claude", backendProfileId: env.kimi.id, modelId: KIMI_CODING_MODELS[0]!.id, reasoningEffort: "max" },
    ]) {
      expect(await create(route), JSON.stringify(route)).toMatchObject({ code: "user_denied" });
    }
    for (const [route, message] of [
      [{ backendProfileId: "custom:missing" }, "route.backendProfileId: no such backend; call inertia_list_models for valid routes."],
      [{ backendProfileId: env.gateway.id, modelId: "gamma" }, "route.modelId: not a model of this backend; call inertia_list_models for valid routes."],
      [{ providerId: "kimi", backendProfileId: env.kimi.id }, "route.providerId: does not match the backend's provider; call inertia_list_models for valid routes."],
    ] as const) {
      expect(await create(route)).toEqual({ code: "host_tool_failed", message });
    }
  });

  it("lists one backend in full with backendProfileId and rejects bad arguments in the shared format", async () => {
    const env = await runtime();
    const one = (await env.invoke("inertia_list_models", { backendProfileId: env.gateway.id })).value as unknown as Listed;
    expect(one.backends.map(({ backendProfileId }) => backendProfileId)).toEqual([env.gateway.id]);
    for (const [args, lines] of [
      [{ backendProfileId: "custom:missing" }, ["backendProfileId: no such backend; omit it to list every backend"]],
      [{ backendProfileId: 7 }, ["backendProfileId: expected string"]],
      [{ providerId: "codex" }, ["\"providerId\": unknown field; accepted: backendProfileId"]],
    ] as const) {
      const { success, value } = await env.invoke("inertia_list_models", args);
      expect(success).toBe(false);
      expect(value.error).toEqual({
        code: "invalid_arguments",
        message: [...lines, "Fix it and call inertia_list_models again."].join("\n"),
      });
    }
  });
});

describe("listModelRoutes limits", () => {
  const conversation = {
    modelSelection: { backendProfileId: "custom:b0", modelId: "m0", reasoningEffort: null },
  } as never;

  function view(index: number, models: number, usable = true) {
    return {
      id: `custom:b${index}`,
      displayName: `Backend ${index} ${"x".repeat(80)}`,
      harnessId: "claude-agent-sdk",
      preset: "custom",
      source: "custom",
      protocol: "anthropic-messages",
      endpointHost: GATEWAY,
      enabled: usable,
      authState: "configured",
      connectionState: "connected",
      routeKind: "api-key",
      compatibility: { reasonCode: "anthropic-probe-verified", state: "verified" },
      routing: { primaryModelId: "m0" },
      models: Array.from({ length: models }, (_, model) => ({
        id: `m${model}`,
        displayName: `Model ${model} ${"y".repeat(100)}`,
        reasoningOptions: [{ value: "low" }, { value: "high" }],
        compatibility: { reasonCode: "anthropic-probe-verified", state: "verified" },
      })),
    };
  }

  const dependencies = (views: unknown[]) => ({
    profiles: () => views as never,
    providerInfo: () => [provider("claude")],
    accepts: () => true,
  });

  const signal = new AbortController().signal;

  it("caps each backend's models, keeps usable backends first, and cuts whole backends at the result limit", async () => {
    const views = [view(0, 60, false), ...Array.from({ length: 40 }, (_, index) => view(index + 1, 60))];
    const result = await listModelRoutes(conversation, {}, dependencies(views), signal);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(31 * 1024);
    const listed = JSON.parse(result.text) as Listed & { backends: Array<{ modelsTruncated?: boolean; totalModels?: number }> };
    expect(listed.truncated).toBe(true);
    expect(listed.backends.length).toBeGreaterThan(0);
    expect(listed.backends.length).toBeLessThan(41);
    expect(listed.backends.every(({ usable }) => usable)).toBe(true);
    expect(listed.backends[0]).toMatchObject({ modelsTruncated: true, totalModels: 60 });
    expect(listed.backends[0]!.models).toHaveLength(MAX_LISTED_MODELS_PER_BACKEND);
    expect(listed.next).toContain("with a backendProfileId");
  });

  it("fits as many models of one filtered backend as the limit allows", async () => {
    const wide = view(0, 128);
    // Labels are capped, but model ids are returned whole.
    for (const entry of wide.models) entry.id = `${entry.id}-${"z".repeat(250)}`;
    const result = await listModelRoutes(conversation, { backendProfileId: "custom:b0" }, dependencies([wide]), signal);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(31 * 1024);
    const listed = JSON.parse(result.text) as Listed & { backends: Array<{ modelsTruncated?: boolean; totalModels?: number }> };
    expect(listed.backends[0]).toMatchObject({ modelsTruncated: true, totalModels: 128 });
    expect(listed.backends[0]!.models.length).toBeGreaterThan(MAX_LISTED_MODELS_PER_BACKEND);
    expect(listed.next).toBe("This backend's models were cut at the result size limit.");
  });

  it("yields between route checks and stops once the call is cancelled", async () => {
    const controller = new AbortController();
    const accepts = vi.fn(() => {
      if (accepts.mock.calls.length === 100) controller.abort();
      return true;
    });
    const result = await listModelRoutes(conversation, {}, { ...dependencies([view(0, 128)]), accepts }, controller.signal);
    expect(JSON.parse(result.text)).toEqual({ error: { code: "call_cancelled", message: "The host tool call was cancelled." } });
    expect(accepts.mock.calls.length).toBeLessThan(110);
  });
});
