import type { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { objectValue, type JsonObject } from "../codex/protocol";
import type { ProcessTreeTerminator } from "../process-lifecycle";
import { AcpSecretRedactor } from "./acp-redaction";
import { createAgentHarnessEmitter, type AgentHarness, type AgentHarnessRun, type AgentHarnessStartOptions, type PiRpcHarnessCapabilities } from "./agent-harness";
import { providerRunTerminal, ProviderSteerDeliveryUnknownError, type ProviderRunResult } from "./contracts";
import { createProviderHostToolMcpSession, type ProviderHostToolMcpSession } from "./host-tool-mcp-http";
import { ProviderHostToolRuntime } from "./host-tool-runtime";
import { trackNativeConversationRun } from "./native-conversation-run-tracking";
import { createPiNativeConversationOperations, piActiveEntries } from "./pi-native-conversation";
import { PiDialogs } from "./pi-dialogs";
import { PiEvents } from "./pi-events";
import { piLaunchConfiguration, piNativeTools, piRpcArguments, validatePiLaunchResources } from "./pi-launch";
import { piModels, piUsage } from "./pi-models";
import { piImages, stagePiBridge } from "./pi-resources";
import { openPiRpcConnection, type PiRpcConnection } from "./pi-rpc";
import { ensurePiSessionDirectory, findPiSessionFile, piSessionState, requireUnusedPiSessionId } from "./pi-session";
import { providerUnconfirmedCleanup } from "./provider-unconfirmed-cleanup";
import { validatePiSkills } from "./pi-skills";

export const PI_RPC_CAPABILITIES = {
  lifecycle: { events: "push", terminalStatuses: ["completed", "failed", "cancelled"] },
  session: { resume: "native", identity: "session" },
  cancellation: { graceful: "protocol-interrupt", forceFallback: "process-tree-kill" },
  extension: { kind: "pi-rpc", protocol: "pi-jsonl-rpc-v1", approvals: "managed-extension", questions: "extension-ui",
    plans: "unavailable", reasoning: "native", usage: "native", images: "structured-base64-input", authentication: "pi-native", modelMetadata: "rpc" },
} as const satisfies PiRpcHarnessCapabilities;

export interface PiRpcHarnessOptions {
  spawnProcess?: typeof spawn;
  terminateProcessTree?: ProcessTreeTerminator;
  startupTimeoutMs?: number;
  runTimeoutMs?: number;
}

export function createPiRpcHarness(dependencies: PiRpcHarnessOptions = {}): AgentHarness {
  const active = new Set<string>();
  return { id: "pi-rpc", providerId: "pi", capabilities: PI_RPC_CAPABILITIES,
    nativeConversation: createPiNativeConversationOperations(active, dependencies),
    supports: (input) => input.providerId === "pi" && input.harnessId === "pi-rpc" && input.backendProfile.source !== "custom",
    start: (options) => trackNativeConversationRun(active, options, (launch) => startPiRun(launch, dependencies)) };
}

function startPiRun(options: AgentHarnessStartOptions, dependencies: PiRpcHarnessOptions): AgentHarnessRun {
  const { input } = options;
  const emit = createAgentHarnessEmitter("pi", input.conversationId, options.callbacks, input.runId, input.turnId, input.cwd);
  let connection: PiRpcConnection | undefined;
  let dialogs: PiDialogs | undefined;
  let host: ProviderHostToolRuntime | undefined;
  let mcp: ProviderHostToolMcpSession | undefined;
  let resources: Awaited<ReturnType<typeof stagePiBridge>> | undefined;
  let cancelled = false; let live = false; let finished = false;
  let timedOut = false; let uncertainSteer = false; let imageInputAvailable = false;
  let sessionId = input.sessionId;
  let stopped: Promise<void> | undefined;
  let steerTail: Promise<unknown> = Promise.resolve();
  const controller = new AbortController();
  let events = new PiEvents(emit, options.environment);
  const cancellation = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("Pi was cancelled.")), { once: true });
  });
  void cancellation.catch(() => undefined);
  const redact = new AcpSecretRedactor(options.environment);
  let ready!: () => void; const bridgeReady = new Promise<void>((resolve) => { ready = resolve; });
  let settled!: () => void;
  let settlement = new Promise<void>((resolve) => { settled = resolve; });
  const resetSettlement = (): void => { settlement = new Promise<void>((resolve) => { settled = resolve; }); };
  const cancel = (force: boolean): void => {
    if (finished) return;
    cancelled = true; live = false; controller.abort(); dialogs?.close(); host?.settle();
    if (!connection) return;
    if (force) { stopped = connection.close(true); void stopped.catch(() => undefined); return; }
    stopped ??= (async () => {
      try { await connection!.request("clear_queue", {}, 2_000); await connection!.request("abort", {}, 2_000); }
      finally { await connection!.close(true); }
    })();
    void stopped.catch(() => undefined); settled();
  };
  const result = (async (): Promise<ProviderRunResult> => {
    let status: ProviderRunResult["status"] = "failed";
    let error: string | undefined; let cleanupConfirmed = true;
    let hostCleanupFailed = false;
    const watchdog = setTimeout(() => { timedOut = true; cancel(true); }, dependencies.runTimeoutMs ?? 30 * 60_000); watchdog.unref();
    let startupTimer: NodeJS.Timeout | undefined;
    try {
      emit.status("starting");
      if (await realpath(input.cwd) !== resolve(input.cwd)) throw new Error("Pi workspace is not canonical.");
      const continuation = options.nativeContinuation;
      if (continuation && (continuation.kind !== "new-session" || continuation.nativeConversationId !== input.sessionId)) throw new Error("This Pi continuation recipe is unsupported.");
      const config = piLaunchConfiguration(options.environment, options.executable);
      const selectedSkills = await validatePiSkills(input.skills ?? [], options.environment, input.cwd);
      for (const path of selectedSkills) config.args.push("--skill", path);
      await validatePiLaunchResources(config);
      const root = await ensurePiSessionDirectory(config.sessionDirectory, controller.signal);
      if (continuation) await requireUnusedPiSessionId(root, continuation.nativeConversationId, controller.signal);
      const sessionFile = input.sessionId && !continuation ? await findPiSessionFile(root, input.sessionId, input.cwd, controller.signal) : undefined;
      if (options.hostTools) {
        host = new ProviderHostToolRuntime({ bridge: options.hostTools, conversationId: input.conversationId, turnId: input.turnId,
          cwd: input.cwd, onApproval: (request) => emit.rich({ type: "approval", request }),
          onApprovalResolved: (requestId, decision) => emit.rich({ type: "approval-resolved", requestId, decision }) });
        mcp = createProviderHostToolMcpSession(host);
      }
      resources = await stagePiBridge(options, await mcp?.start());
      events = new PiEvents(emit, resources.environment);
      redact.addSecrets(Object.values(resources.environment).filter((value): value is string => !!value && value === resources?.environment.INERTIA_PI_MCP_TOKEN));
      controller.signal.throwIfAborted();
      const onEvent = (event: JsonObject): void => {
        if (event.type === "extension_ui_request") {
          if (event.method === "notify" && event.message === `inertia-ready:${resources!.nonce}`) { ready(); return; }
          if (dialogs?.receive(event)) return;
          const safe = redact.payload(event);
          if (event.method === "setTitle" && sessionId && typeof safe.title === "string") emit.sessionTitle(sessionId, safe.title.slice(0, 240));
          else if (["notify", "setStatus", "setWidget", "set_editor_text"].includes(String(event.method))) {
            const text = safe.message ?? safe.statusText ?? safe.text ?? (Array.isArray(safe.widgetLines) ? safe.widgetLines.join("\n") : "");
            if (typeof text === "string" && text) emit.activity("tool", "completed", "Pi extension", { detail: text.slice(0, 16_384) });
          }
          return;
        }
        events.receive(event);
        if (event.type === "agent_settled") { live = false; settled(); }
      };
      connection = openPiRpcConnection({ executable: config.executable, args: piRpcArguments(config, {
        sessionFile, newSessionId: continuation?.nativeConversationId, extensionFile: resources.file,
        tools: options.providerNativeToolsAvailable ? piNativeTools() : [],
      }), environment: resources.environment, cwd: input.cwd, onEvent,
      spawnProcess: dependencies.spawnProcess, terminateProcessTree: dependencies.terminateProcessTree });
      dialogs = new PiDialogs(emit, redact, (record) => connection!.send(record), `Inertia tool approval:${resources.nonce}`);
      const startup = new Promise<never>((_resolve, reject) => {
        startupTimer = setTimeout(() => reject(new Error("Pi managed extension did not become ready.")), dependencies.startupTimeoutMs ?? 15_000);
        startupTimer.unref();
      });
      const transportFailed = connection.failure.then((reason) => { throw reason; });
      // Attach both outcomes immediately; late failures are observed by every lifecycle wait.
      void transportFailed.catch(() => undefined);
      await Promise.race([bridgeReady, startup, transportFailed, cancellation]); clearTimeout(startupTimer);
      const state = piSessionState(await connection.request("get_state"), root, input.sessionId);
      if (state.streaming || state.compacting || state.pending) throw new Error("Pi session is already active.");
      if (redact.payload(state.id) !== state.id) throw new Error("Pi returned an unsafe native identity.");
      sessionId = state.id; emit.session(sessionId);
      emit.nativeBoundary({ nativeConversationId: sessionId, nativeSessionId: sessionId, nativeTurnId: null, persistedHeadId: null, phase: "started" });
      const models = piModels(await connection.request("get_available_models"), state.model);
      emit.rich({ type: "metadata", metadata: { models: redact.payload(models) }, source: "session", complete: true });
      const selected = input.modelSelection.modelId || input.model;
      if (selected && selected !== "provider-default") {
        if (!models.some((model) => model.id === selected)) throw new Error("The selected Pi model is unavailable.");
        const slash = selected.indexOf("/");
        await connection.request("set_model", { provider: selected.slice(0, slash), modelId: selected.slice(slash + 1) });
      }
      const thinking = input.modelSelection.reasoningEffort || input.reasoningEffort;
      if (thinking) {
        const levels = objectValue(await connection.request("get_available_thinking_levels"))?.levels;
        if (!Array.isArray(levels) || !levels.includes(thinking)) throw new Error("The selected Pi thinking level is unavailable.");
        await connection.request("set_thinking_level", { level: thinking });
      }
      const images = await piImages(input.imagePaths ?? [], input.attachmentReadRoots, controller.signal);
      const model = selected && selected !== "provider-default" ? models.find((candidate) => candidate.id === selected) : models.find((candidate) => candidate.isDefault);
      imageInputAvailable = model?.inputModalities.includes("image") === true;
      if (images.length && !imageInputAvailable) throw new Error("The selected Pi model does not advertise image input.");
      emit.status("running"); live = true; resetSettlement();
      if (input.operation?.kind === "compact") {
        live = false;
        await connection.request("compact", input.operation.instruction ? { customInstructions: input.operation.instruction } : {}, 300_000);
      } else {
        const response = objectValue(await connection.request("prompt", { message: input.prompt, ...(images.length ? { images } : {}) }, 300_000));
        if (!["started", "queued", "handled"].includes(String(response?.disposition))) throw new Error("Pi did not confirm prompt acceptance.");
        if (response?.disposition !== "handled") await Promise.race([settlement, transportFailed, cancellation]);
      }
      live = false; await steerTail;
      controller.signal.throwIfAborted();
      const finalState = piSessionState(await connection.request("get_state"), root, sessionId);
      if (finalState.streaming || finalState.compacting || finalState.pending) throw new Error("Pi reported settlement with pending work.");
      emit.rich({ type: "usage", usage: piUsage(await connection.request("get_session_stats")) });
      let head: string | null = null;
      try {
        const nativeHead = piActiveEntries(await connection.request("get_entries")).leafId;
        if (nativeHead !== null && redact.payload(nativeHead) !== nativeHead) throw new Error("Pi returned an unsafe native anchor.");
        head = nativeHead;
      } catch { /* Unproved anchors require portable continuation. */ }
      emit.nativeBoundary({ nativeConversationId: sessionId, nativeSessionId: sessionId, nativeTurnId: head, persistedHeadId: head, phase: "settled" });
      if (events.failed) throw new Error("Pi did not complete the request successfully.");
      status = "completed";
    } catch {
      status = cancelled && !timedOut && !uncertainSteer ? "cancelled" : "failed";
      if (timedOut) error = "Pi exceeded the bounded run deadline.";
      else if (uncertainSteer) error = "Pi could not confirm follow-up delivery.";
      else if (!cancelled) error = "Pi could not complete the request. Check its model, authentication, and native session configuration.";
    } finally {
      finished = true; live = false; clearTimeout(watchdog); clearTimeout(startupTimer);
      dialogs?.close(); host?.settle();
      if (connection) {
        try { if (stopped) await stopped; await connection.close(true); }
        catch { cleanupConfirmed = false; }
      }
      try { await mcp?.close(); } catch { cleanupConfirmed = false; hostCleanupFailed = true; }
      if (cleanupConfirmed) await resources?.dispose().catch(() => undefined);
      else if (connection && resources) {
        const retained = resources; void providerUnconfirmedCleanup(connection.child).cleanupConfirmation.then((confirmed) => {
          if (confirmed) return retained.dispose(); return undefined;
        }).catch(() => undefined);
      }
      events.finish();
    }
    emit.status(status, error);
    return { ...providerRunTerminal(input, status), sessionId, text: events.text.toString(), textTruncated: events.text.truncated,
      exitCode: connection?.child.exitCode ?? null, signal: connection?.child.signalCode ?? null,
      cleanupConfirmed, ...(!cleanupConfirmed && !hostCleanupFailed && connection ? providerUnconfirmedCleanup(connection.child) : {}), ...(error ? { error } : {}) };
  })();
  return { harnessId: "pi-rpc", providerId: "pi", result, cancel,
    extension: { kind: "pi-rpc", respondToApproval: (id, decision) => host?.respondToApproval(id, decision) || dialogs?.approval(id, decision) || false,
      respondToInput: (id, answers) => dialogs?.input(id, answers) ?? false,
      steer: (steer) => {
        if (!live || !connection || cancelled || steer.imagePaths.length && !imageInputAvailable) return Promise.resolve(false);
        const work = steerTail.then(async () => {
          if (!live || !connection || cancelled) return false;
          const images = await piImages(steer.imagePaths, input.attachmentReadRoots, controller.signal);
          if (!live || cancelled) return false;
          try {
            const response = objectValue(await connection.request("steer", { message: steer.content, ...(images.length ? { images } : {}) }));
            if (!["queued", "handled"].includes(String(response?.disposition))) throw new ProviderSteerDeliveryUnknownError();
            return true;
          } catch {
            const settledBeforeResponse = !live;
            uncertainSteer = true; cancel(false);
            throw new ProviderSteerDeliveryUnknownError(settledBeforeResponse);
          }
        });
        steerTail = work.catch(() => undefined); return work;
      } },
  };
}
