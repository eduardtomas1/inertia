import { z } from "zod";
import { CURSOR_SDK_SECRET_REFERENCE } from "../../node/runtime-credential-protocol";
import { CURSOR_SDK_RUN_TIMEOUT_MS, cursorSdkAuthoritySchema, cursorSdkStartResultSchema } from "../../node/cursor-sdk-protocol";
import { providerInstanceId } from "../orchestration-v2/provider-instance";
import { createAgentHarnessEmitter, type AgentHarness, type AgentHarnessCapabilities, type AgentHarnessStartOptions, type AgentHarnessRun } from "./agent-harness";
import { providerRunTerminal, ProviderSteerDeliveryUnknownError, type ProviderRunResult } from "./contracts";
import { ProviderHostToolRuntime } from "./host-tool-runtime";
import { CursorSdkCleanupError, openCursorSdkWorker } from "./cursor-sdk-process";
import { isCursorSdkCleanSteerRefusal } from "./cursor-sdk-session";
import { cursorSdkStateRoot, type CursorSdkConfiguration } from "./cursor-sdk-service";
import { cursorSdkAgentStoreDirectory, cursorSdkStoreDirectory, cursorSdkStoreHasJournal, CursorSdkStoreMissingError } from "./cursor-sdk-store";
import { cursorSdkStorePlan } from "./cursor-sdk-store-plan";
import { providerUnconfirmedCleanup } from "./provider-unconfirmed-cleanup";
import { AcpSecretRedactor } from "./acp-redaction";

export const CURSOR_SDK_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "session" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "process-tree-kill" },
  extension: { kind: "cursor-sdk", protocol: "owned-sdk-worker", approvals: "host-only", questions: "unavailable",
    plans: "unavailable", reasoning: "native", usage: "unavailable", images: "unavailable", authentication: "vault", modelMetadata: "sdk" },
} as const satisfies AgentHarnessCapabilities;

export function createCursorSdkHarness(): AgentHarness {
  return { id: "cursor-sdk", providerId: "cursor", capabilities: CURSOR_SDK_CAPABILITIES,
    supports: (input) => input.harnessId === "cursor-sdk" && input.providerId === "cursor", start: startCursorSdkRun };
}

const eventSchema = z.object({ authority: cursorSdkAuthoritySchema, message: z.object({
  type: z.enum(["system", "assistant", "user", "thinking", "status", "request", "tool_call", "task", "usage"]),
  agent_id: z.string().min(1).max(512), run_id: z.string().min(1).max(512),
}).passthrough() }).strict();
const hostSchema = z.object({ authority: cursorSdkAuthoritySchema, callId: z.string().uuid(), tool: z.string().min(1).max(128), arguments: z.unknown() }).strict();

/** `existing`: the store of the checkout a moved chat's agent was created in; it is opened, never created. */
export type CursorSdkRunStateRootResolver = (configuration: CursorSdkConfiguration, workspace: string, providerInstanceId: string,
  existing?: boolean) => Promise<string>;

const STORAGE_UNAVAILABLE = "Cursor SDK durable storage is unavailable on this platform or workspace.";

async function resolveCursorSdkRunStateRoot(configuration: CursorSdkConfiguration, workspace: string, instance: string,
  existing = false): Promise<string> {
  return await cursorSdkStoreDirectory(await cursorSdkStateRoot(configuration), workspace, instance, existing);
}

/** An agent's own store (`cursorSdkStorePlan`) and whether it holds a journal; `create` makes it, otherwise null when it does not exist. */
export type CursorSdkAgentStateRootResolver = (configuration: CursorSdkConfiguration, providerInstanceId: string, agentId: string,
  create: boolean) => Promise<{ directory: string; journal: boolean } | null>;

async function resolveCursorSdkAgentStateRoot(configuration: CursorSdkConfiguration, instance: string, agentId: string,
  create: boolean): Promise<{ directory: string; journal: boolean } | null> {
  const directory = await cursorSdkAgentStoreDirectory(await cursorSdkStateRoot(configuration), instance, agentId, create);
  return directory === null ? null : { directory, journal: await cursorSdkStoreHasJournal(directory) };
}

export function startCursorSdkRun(options: AgentHarnessStartOptions, dependencies: {
  openWorker?: typeof openCursorSdkWorker; resolveStateRoot?: CursorSdkRunStateRootResolver;
  resolveAgentStateRoot?: CursorSdkAgentStateRootResolver;
} = {}): AgentHarnessRun {
  const { input } = options;
  const emit = createAgentHarnessEmitter("cursor", input.conversationId, options.callbacks, input.runId, input.turnId, input.cwd, "cursor-sdk");
  const controller = new AbortController();
  const authority = { conversationId: input.conversationId, turnId: input.turnId, runId: input.runId,
    providerInstanceId: providerInstanceId("cursor", input.continuationIdentity), workspace: input.cwd };
  const identity = JSON.stringify(authority);
  let worker: Awaited<ReturnType<typeof openCursorSdkWorker>> | undefined;
  let host: ProviderHostToolRuntime | undefined;
  let cancelled = false; let timedOut = false; let finished = false; let live = false;
  let sessionId = input.sessionId; let nativeRun: string | undefined;
  /** The worker's answer to whether Cursor saved a checkpoint for its run (`cursorSdkStartResultSchema`). */
  let checkpoint: { agentId: string; runId: string; checkpointed: boolean } | undefined;
  /**
   * Cursor summarized the conversation during the run (T3 `context.compacted`, set on `summary-completed`). SDK 1.0.38
   * keeps `summary-started` and `summary-completed` out of `run.stream()` and surfaces only the summary itself, as a
   * `task` message (its only source of `task` messages), so that message is the signal here.
   */
  let compacted = false;
  let text = "";
  let uncertainChild: import("node:child_process").ChildProcess | undefined;
  const redact = new AcpSecretRedactor(options.environment);
  const check = (value: unknown): void => {
    if (finished || cancelled || JSON.stringify(value) !== identity) throw new Error("Cursor SDK authority mismatch.");
  };
  const append = (value: string): void => {
    if (Buffer.byteLength(text) + Buffer.byteLength(value) > 8 * 1024 * 1024) throw new Error("Cursor SDK text limit exceeded.");
    text += value; if (value) emit.text(value);
  };
  const cancel = (force: boolean): void => {
    if (finished) return;
    cancelled = true; live = false; host?.settle();
    if (force || !worker) controller.abort();
    else void worker.channel.request("cancel", null, 2000).catch(() => controller.abort());
  };
  const result = (async (): Promise<ProviderRunResult> => {
    let status: ProviderRunResult["status"] = "failed";
    let cleanupConfirmed = true;
    let failure = "Cursor SDK execution failed.";
    let sessionUnavailable = false;
    const watchdog = setTimeout(() => { timedOut = true; cancel(true); }, CURSOR_SDK_RUN_TIMEOUT_MS); watchdog.unref();
    try {
      emit.status("starting");
      if (!options.cursorSdk?.credentials || input.imagePaths?.length || input.skills?.length || options.nativeContinuation
        || input.modelSelection.reasoningEffort || input.reasoningEffort || input.modelSelection.contextWindowOverride
        || !input.modelSelection.modelId || input.modelSelection.modelId === "provider-default") throw new Error("Cursor SDK launch options are unavailable.");
      // Cursor's store is per checkout. A chat that moved here with its agent runs it from the agent's own store,
      // adopted the first time from the store of the checkout it was created in (`storeWorkspace`; T3
      // `cursorStoreCwd`); the agent runs here. See cursorSdkStorePlan.
      const storeWorkspace = input.sessionId && input.sessionOriginCwd && input.sessionOriginCwd !== input.cwd
        ? input.sessionOriginCwd : undefined;
      const resolveStateRoot = dependencies.resolveStateRoot ?? resolveCursorSdkRunStateRoot;
      const resolveAgentStateRoot = dependencies.resolveAgentStateRoot ?? resolveCursorSdkAgentStateRoot;
      const instance = authority.providerInstanceId;
      const configuration = options.cursorSdk;
      const { plan, stateRoot, agentStateRoot, adoptFrom } = await (async () => {
        const agentStore = input.sessionId ? await resolveAgentStateRoot(configuration, instance, input.sessionId, false) : null;
        // Only a store that does not exist is missing; any other lookup failure is a storage error.
        const originStore = storeWorkspace !== undefined && !agentStore?.journal
          ? await resolveStateRoot(configuration, storeWorkspace, instance, true).catch((error: unknown) => {
            if (error instanceof CursorSdkStoreMissingError) return undefined;
            throw error;
          }) : undefined;
        const plan = cursorSdkStorePlan({ resumed: input.sessionId !== undefined, moved: storeWorkspace !== undefined,
          agentJournal: agentStore?.journal === true, originStore: originStore !== undefined });
        if (plan === "unavailable") return { plan, stateRoot: "", agentStateRoot: undefined, adoptFrom: undefined };
        const agentStateRoot = plan === "agent" ? agentStore!.directory
          : plan === "adopt" ? (await resolveAgentStateRoot(configuration, instance, input.sessionId!, true))?.directory : undefined;
        if (plan === "adopt" && !agentStateRoot) throw new Error("Cursor SDK agent store could not be created.");
        return { plan, agentStateRoot, adoptFrom: plan === "adopt" ? originStore : undefined,
          stateRoot: agentStateRoot ?? await resolveStateRoot(configuration, input.cwd, instance) };
      })().catch((error: unknown) => { failure = STORAGE_UNAVAILABLE; throw error; });
      if (plan === "unavailable") {
        // The chat moved, its agent never got a store of its own and the store it was created in is gone: the
        // agent's records no longer exist, so only a new session can continue (decided before any worker starts).
        sessionUnavailable = true;
        failure = "The Cursor SDK session's store no longer exists.";
        throw new Error(failure);
      }
      const apiKey = await options.cursorSdk.credentials.resolve(CURSOR_SDK_SECRET_REFERENCE, controller.signal);
      if (!apiKey) throw new Error("Cursor SDK login is required.");
      redact.addSecrets([apiKey]);
      controller.signal.throwIfAborted();
      if (options.hostTools) host = new ProviderHostToolRuntime({ bridge: options.hostTools,
        conversationId: input.conversationId, turnId: input.turnId, cwd: input.cwd,
        onApproval: (request) => emit.rich({ type: "approval", request }),
        onApprovalResolved: (requestId, decision) => emit.rich({ type: "approval-resolved", requestId, decision }) });
      worker = await (dependencies.openWorker ?? openCursorSdkWorker)({ cwd: input.cwd, environment: options.environment, signal: controller.signal,
        handle: async (method, value) => {
          if (method === "host-tool") {
            const call = hostSchema.parse(value); check(call.authority);
            if (!live || !host) throw new Error("Host tools unavailable.");
            const answer = await host.invoke({ callId: call.callId, tool: call.tool, arguments: call.arguments, signal: controller.signal });
            check(call.authority);
            return { content: [{ type: "text", text: answer.text }, ...(answer.images ?? []).map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))], isError: !answer.success };
          }
          if (method !== "event") throw new Error("Unexpected worker request.");
          const { authority: observed, message } = eventSchema.parse(value); check(observed);
          if (sessionId && message.agent_id !== sessionId || nativeRun && message.run_id !== nativeRun) throw new Error("Cursor SDK native identity mismatch.");
          const first = nativeRun === undefined;
          sessionId = message.agent_id; nativeRun = message.run_id; emit.session(sessionId);
          if (first) emit.nativeBoundary({ nativeConversationId: sessionId, nativeSessionId: sessionId,
            nativeTurnId: nativeRun, persistedHeadId: null, phase: "started" });
          if (message.type === "assistant") {
            const content = z.object({ role: z.literal("assistant"), content: z.array(z.discriminatedUnion("type", [
              z.object({ type: z.literal("text"), text: z.string().max(1024 * 1024) }),
              z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
            ])).max(1024) }).parse(message.message);
            for (const block of content.content) if (block.type === "text") append(redact.assistantChunk(block.text));
          } else if (message.type === "thinking") {
            const thought = z.string().max(1024 * 1024).parse(message.text);
            const safe = redact.reasoningChunk(thought);
            if (safe) emit.activity("reasoning", "info", "Thinking", { outputDelta: safe });
          } else if (message.type === "task") {
            compacted = true;
          } else if (message.type === "tool_call") {
            const tool = z.object({ name: z.string().max(128), status: z.enum(["running", "completed", "error"]), call_id: z.string().max(512) }).parse(message);
            emit.activity("tool", tool.status === "running" ? "started" : tool.status === "completed" ? "completed" : "failed", redact.payload(tool.name));
          }
          return null;
        } });
      live = true; emit.status("running");
      const outcome = cursorSdkStartResultSchema.parse(await worker.channel.request("start", { authority, apiKey, stateRoot,
        prompt: input.prompt, sessionId: input.sessionId, ...(storeWorkspace !== undefined ? { storeWorkspace } : {}),
        ...(agentStateRoot ? { agentStateRoot } : {}), ...(agentStateRoot && adoptFrom ? { adoptFrom } : {}),
        model: input.modelSelection.modelId,
        nativeTools: !options.providerNativeToolsAvailable ? "none" : input.access === "full" && input.interactionMode !== "plan" ? "full" : "read",
        tools: host?.definitions().map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, readOnly })) ?? [],
      }, CURSOR_SDK_RUN_TIMEOUT_MS));
      if (outcome.unverified === true) {
        checkpoint = { agentId: outcome.agentId, runId: outcome.id, checkpointed: outcome.runCheckpointed };
        throw new Error("Cursor SDK execution could not be verified.");
      }
      const completed = outcome;
      if (sessionId && completed.agentId !== sessionId) throw new Error("Cursor SDK terminal session mismatch.");
      sessionId = completed.agentId; emit.session(sessionId);
      if (nativeRun && completed.id !== nativeRun) throw new Error("Cursor SDK terminal mismatch.");
      if (completed.runCheckpointed !== undefined) checkpoint = { agentId: completed.agentId, runId: completed.id, checkpointed: completed.runCheckpointed };
      if (sessionId) emit.nativeBoundary({ nativeConversationId: sessionId, nativeSessionId: sessionId,
        nativeTurnId: completed.id, persistedHeadId: completed.id, phase: "settled" });
      append(redact.finishAssistant());
      status = completed.status === "finished" ? "completed" : completed.status === "cancelled" ? "cancelled" : "failed";
    } catch (error) {
      if (error instanceof CursorSdkCleanupError) { cleanupConfirmed = false; uncertainChild = error.child; }
      status = cancelled && !timedOut ? "cancelled" : "failed";
    }
    finally {
      live = false; host?.settle(); clearTimeout(watchdog);
      try { await worker?.close(); } catch { cleanupConfirmed = false; }
      finished = true;
    }
    // T3 c5fa33b27: Cursor keeps a run in its conversation only once the run saved a checkpoint, so a failed or
    // cancelled run without one dropped its prompt, even after it streamed output. The worker answers after closing
    // its store (`executeCursorSdkRun`). Anything uncertain reports nothing, and settlement keeps its usual evidence:
    // no answer (a killed or crashed worker, a lost channel, a store that could not tell), an answer about another
    // agent or run than the one that streamed, or a worker whose process-tree cleanup is unconfirmed. As in T3, a run
    // during which Cursor summarized the conversation is never reported dropped.
    const promptDropped = (status === "failed" || status === "cancelled") && cleanupConfirmed && !compacted
      && checkpoint?.checkpointed === false && (sessionId === undefined || checkpoint.agentId === sessionId)
      && (nativeRun === undefined || checkpoint.runId === nativeRun);
    emit.status(status, status === "failed" ? failure : undefined, undefined, promptDropped);
    const unavailable = status === "failed" && sessionUnavailable
      ? { reason: "provider-error" as const, message: failure, sessionUnavailable: true as const } : undefined;
    return { ...providerRunTerminal(input, status, unavailable), sessionId, text, textTruncated: false, exitCode: null, signal: null,
      cleanupConfirmed, ...(!cleanupConfirmed && (worker?.child ?? uncertainChild) ? providerUnconfirmedCleanup((worker?.child ?? uncertainChild)!) : {}),
      ...(status === "failed" ? { error: failure } : {}), ...(unavailable ? { failure: unavailable } : {}) };
  })();
  return { harnessId: "cursor-sdk", providerId: "cursor", result, cancel, extension: { kind: "cursor-sdk",
    respondToApproval: (id, decision) => host?.respondToApproval(id, decision) ?? false, respondToInput: () => false,
    steer: async (steer) => {
      if (!live || !worker || cancelled || steer.imagePaths.length) return false;
      let outcome: unknown;
      try { outcome = await worker.channel.request("steer", steer.content); }
      catch (error) {
        if (isCursorSdkCleanSteerRefusal(error)) return false;
        throw new ProviderSteerDeliveryUnknownError(!live);
      }
      if (outcome === "complete_delivered") return true;
      if (outcome === "revert_to_followup") return false;
      throw new ProviderSteerDeliveryUnknownError(!live);
    } } };
}
