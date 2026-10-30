import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { objectValue, type JsonObject } from "../codex/protocol";
import { credentialFreeProviderEnvironment } from "../environment";
import { AcpSecretRedactor } from "./acp-redaction";
import { createAgentHarnessEmitter, type AgentHarnessRun, type AgentHarnessStartOptions } from "./agent-harness";
import { providerRunTerminal, ProviderSteerDeliveryUnknownError, type ProviderRunResult } from "./contracts";
import { createProviderHostToolMcpSession, type ProviderHostToolMcpSession } from "./host-tool-mcp-http";
import { ProviderHostToolRuntime } from "./host-tool-runtime";
import type { OpenCode2EventStream } from "./opencode2-client";
import { OpenCode2Events } from "./opencode2-events";
import { openCode2Data, openCode2Id, openCode2SessionPath, readOpenCode2History } from "./opencode2-history";
import { OpenCode2Interactions } from "./opencode2-interactions";
import { openOwnedOpenCode2Server } from "./opencode2-server";
import { openCode2Images, openCode2Models, openCode2Permissions, openCode2Selection } from "./opencode2-support";
import { providerUnconfirmedCleanup } from "./provider-unconfirmed-cleanup";

export interface OpenCode2HarnessOptions {
  openServer?: typeof openOwnedOpenCode2Server;
  runTimeoutMs?: number;
}

/** V2 uses the same installation identity, but never sends V1 SDK requests. */
export function startOpenCode2Run(options: AgentHarnessStartOptions, dependencies: OpenCode2HarnessOptions = {}): AgentHarnessRun {
  const { input } = options;
  const emit = createAgentHarnessEmitter("opencode", input.conversationId, options.callbacks, input.runId, input.turnId, input.cwd);
  const redact = new AcpSecretRedactor(options.environment);
  const controller = new AbortController();
  const ownedInputs = new Map<string, boolean>();
  let server: Awaited<ReturnType<typeof openOwnedOpenCode2Server>> | undefined;
  let stream: OpenCode2EventStream | undefined;
  let interactions: OpenCode2Interactions | undefined;
  let host: ProviderHostToolRuntime | undefined;
  let mcp: ProviderHostToolMcpSession | undefined;
  let events = new OpenCode2Events(emit, options.environment, redact);
  let sessionId = input.sessionId;
  let live = false; let finished = false; let cancelled = false; let timedOut = false;
  let stopping: Promise<void> | undefined;
  let steerTail: Promise<unknown> = Promise.resolve();
  let executionOutcome: string | undefined;
  let imageInputAvailable = false;
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => { settle = resolve; });
  let rejectFailure!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
  void failed.catch(() => undefined);
  const fail = (): void => { live = false; rejectFailure(new Error("OpenCode 2 run could not be verified.")); };
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      if (!server) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([(async () => {
          // Cancel only inputs admitted by this run before interrupting execution.
          if (!sessionId || !ownedInputs.size) return;
          await Promise.all([...ownedInputs.keys()].map((id) => server!.client.request("DELETE", `${openCode2SessionPath(sessionId!)}/inbox/${id}`)));
          await server.client.request("POST", `${openCode2SessionPath(sessionId)}/interrupt?resume=false`);
        })(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("OpenCode interrupt timed out.")), 2_000); timer.unref(); })]);
      } finally { clearTimeout(timer); controller.abort(); await server.close(); }
    })();
    void stopping.catch(() => undefined); return stopping;
  };
  const cancel = (force: boolean): void => {
    if (finished) return;
    cancelled = true; live = false; interactions?.close(); host?.settle(); fail();
    if (force || !server) {
      controller.abort();
      if (server) { stopping = server.close(); void stopping.catch(() => undefined); }
    } else void stop();
  };
  const result = (async (): Promise<ProviderRunResult> => {
    let status: ProviderRunResult["status"] = "failed"; let error: string | undefined;
    let cleanupConfirmed = true; let hostCleanupFailed = false;
    const watchdog = setTimeout(() => { timedOut = true; cancel(true); }, Math.min(dependencies.runTimeoutMs ?? 30 * 60_000, 30 * 60_000)); watchdog.unref();
    try {
      emit.status("starting");
      if (await realpath(input.cwd) !== resolve(input.cwd)) throw new Error("OpenCode workspace is not canonical.");
      if (options.nativeContinuation || input.skills?.length || input.operation?.instruction) throw new Error("This OpenCode 2 native operation is unsupported.");
      server = await (dependencies.openServer ?? openOwnedOpenCode2Server)({ executable: options.executable, installationVersion: options.installationVersion, environment: options.environment, cwd: input.cwd, signal: controller.signal });
      void server.failure.then(fail);
      const client = server.client; const location = `?directory=${encodeURIComponent(input.cwd)}`;
      redact.addSecrets(server.redactionSecrets);
      const hostName = options.hostTools ? `inertia_${randomUUID().replaceAll("-", "")}` : undefined;
      const permissions = openCode2Permissions(options, hostName);
      let info: JsonObject | undefined;
      if (sessionId) {
        info = objectValue(openCode2Data(await client.request("GET", openCode2SessionPath(sessionId))));
        assertSession(info, sessionId, input.cwd); await requireIdle();
      }
      const nativeModels = await client.request("GET", `/api/model${location}`);
      const defaultModel = info?.model ?? openCode2Data(await client.request("GET", `/api/model/default${location}`));
      const models = openCode2Models(nativeModels, defaultModel);
      const selection = input.modelSelection.modelId || input.model;
      const variant = input.modelSelection.reasoningEffort || input.reasoningEffort;
      const modelId = selection && selection !== "provider-default" ? selection : models.find((model) => model.isDefault)?.id;
      if (!modelId) throw new Error("OpenCode 2 has no available default model.");
      const model = openCode2Selection(modelId, variant, models);
      const images = await openCode2Images(input.imagePaths ?? [], input.attachmentReadRoots, controller.signal);
      const selectedModel = models.find((entry) => entry.id === modelId)!;
      imageInputAvailable = selectedModel.inputModalities.includes("image");
      if (images.length && !selectedModel.inputModalities.includes("image")) throw new Error("The selected OpenCode 2 model does not support images.");
      if (!sessionId) {
        info = objectValue(openCode2Data(await client.request("POST", "/api/session", { location: { directory: input.cwd }, model, agent: input.interactionMode, permissions })));
        if (!openCode2Id(info?.id, "ses_")) throw new Error("OpenCode 2 did not return a session identity.");
        sessionId = info.id; assertSession(info, sessionId, input.cwd);
      } else {
        await client.request("PATCH", openCode2SessionPath(sessionId), { permissions });
        await client.request("POST", `${openCode2SessionPath(sessionId)}/model`, { model });
        await client.request("POST", `${openCode2SessionPath(sessionId)}/agent`, { agent: input.interactionMode });
      }
      await client.request("PUT", `${openCode2SessionPath(sessionId)}/environment`, { variables: credentialFreeProviderEnvironment(options.environment) });
      for (const [key, value] of [["inertia-system", input.systemInstruction], ["inertia-session", input.sessionInstruction]] as const) {
        if (value) await client.request("PUT", `/api/experimental/session/${sessionId}/instructions/entries/${key}`, { value });
        else await client.request("DELETE", `/api/experimental/session/${sessionId}/instructions/entries/${key}`);
      }
      if (options.hostTools && hostName) {
        host = new ProviderHostToolRuntime({ bridge: options.hostTools, conversationId: input.conversationId, turnId: input.turnId, cwd: input.cwd,
          onApproval: (request) => emit.rich({ type: "approval", request }),
          onApprovalResolved: (requestId, decision) => emit.rich({ type: "approval-resolved", requestId, decision }) });
        mcp = createProviderHostToolMcpSession(host, {}, { destructiveHints: true });
        const connection = await mcp.start(); redact.addSecrets([connection.bearerToken]);
        server.redactionSecrets.push(connection.bearerToken);
        await client.request("PUT", `/api/experimental/mcp/${hostName}${location}`, { config: { type: "remote", url: connection.url,
          headers: { Authorization: `Bearer ${connection.bearerToken}` }, oauth: false, codemode: false, protocol: "legacy" } });
        const catalog = openCode2Data(await client.request("GET", `/api/mcp${location}`));
        if (!Array.isArray(catalog) || !catalog.some((raw) => objectValue(raw)?.name === hostName && objectValue(objectValue(raw)?.status)?.status === "connected")) throw new Error("OpenCode 2 host tools did not connect.");
      }
      const nativeModel = (openCode2Data(nativeModels) as unknown[]).map(objectValue).find((raw) => raw?.providerID === model.providerID && raw.id === model.id);
      const context = objectValue(nativeModel?.limit)?.context;
      events = new OpenCode2Events(emit, options.environment, redact, typeof context === "number" ? context : undefined, server.redactionSecrets);
      interactions = new OpenCode2Interactions(client, emit, redact, fail);
      if (redact.payload(sessionId) !== sessionId) throw new Error("OpenCode 2 returned an unsafe session identity.");
      emit.session(sessionId);
      emit.rich({ type: "metadata", metadata: { models: redact.payload(models) }, source: "session", complete: true });
      emit.capability("plans", false);
      emit.capability("subagent-create", false);
      emit.capability("images", selectedModel.inputModalities.includes("image"));
      stream = await client.events((event) => {
        const data = objectValue(event.data); const form = objectValue(data?.form);
        if (!data || (data.sessionID ?? form?.sessionID) !== sessionId) return;
        const directory = objectValue(event.location)?.directory;
        if (directory !== undefined && directory !== input.cwd) throw new Error("OpenCode 2 event changed workspace.");
        if (["session.moved", "session.deleted", "session.reverted", "session.forked"].includes(String(event.type))) throw new Error("OpenCode 2 session changed while active.");
        if (event.type === "session.inbox.enqueued" || event.type === "session.inbox.delivered") {
          if (typeof data.inboxID !== "string" || !ownedInputs.has(data.inboxID)) throw new Error("OpenCode 2 session received unrelated input.");
          if (event.type === "session.inbox.delivered") ownedInputs.set(data.inboxID, true);
        }
        if (event.type === "session.execution.started") executionOutcome = undefined;
        if (/^session\.execution\.(succeeded|failed|interrupted)$/u.test(String(event.type)) && ownedInputs.size && [...ownedInputs.values()].every(Boolean)) {
          executionOutcome = String(event.type).split(".").at(-1); live = false; settle();
        }
        if (event.type === "session.renamed" && typeof data.title === "string") emit.sessionTitle(sessionId!, redact.payload(data.title.slice(0, 240)));
        if (interactions!.receive(String(event.type), data, sessionId!)) return;
        if ([...ownedInputs.values()].some(Boolean)) events.receive(event);
      });
      void stream.done.catch(fail);
      await requireIdle();
      const before = await readOpenCode2History(client, sessionId);
      if (before.some((message) => redact.payload(message.id) !== message.id)) throw new Error("OpenCode 2 returned an unsafe history identity.");
      emit.nativeBoundary({ nativeConversationId: sessionId, nativeSessionId: sessionId, nativeTurnId: null, persistedHeadId: (before.at(-1)?.id as string | undefined) ?? null, phase: "started" });
      const id = `msg_${randomUUID().replaceAll("-", "")}`; ownedInputs.set(id, false);
      emit.status("running"); live = true;
      const compact = input.operation?.kind === "compact";
      const receipt = openCode2Data(await Promise.race([client.request("POST", `${openCode2SessionPath(sessionId)}/${compact ? "compact" : "prompt"}`,
        { id, delivery: "steer", ...(compact ? {} : { text: input.prompt, ...(images.length ? { files: images } : {}) }) }), failed]));
      assertReceipt(receipt, id, sessionId, compact ? "compaction" : "user");
      await Promise.race([settled, failed]); await steerTail; await interactions.drain();
      await requireIdle(); controller.signal.throwIfAborted();
      const history = await readOpenCode2History(client, sessionId);
      const head = history.at(-1);
      assertSession(objectValue(openCode2Data(await client.request("GET", openCode2SessionPath(sessionId)))), sessionId, input.cwd);
      const priorHead = before.at(-1)?.id;
      const priorIndex = priorHead === undefined ? -1 : history.findIndex((message) => message.id === priorHead);
      if (!head || head.type !== "idle" || head.outcome !== executionOutcome || redact.payload(head.id) !== head.id
        || priorHead !== undefined && priorIndex < 0
        || ![...ownedInputs.keys()].every((inputId) => history.findIndex((message) => message.id === inputId) > priorIndex)) throw new Error("OpenCode 2 did not persist the exact completed input.");
      emit.nativeBoundary({ nativeConversationId: sessionId, nativeSessionId: sessionId, nativeTurnId: head.id as string, persistedHeadId: head.id as string, phase: "settled" });
      if (executionOutcome !== "succeeded") throw new Error("OpenCode 2 execution did not succeed.");
      status = "completed";

      async function requireIdle(): Promise<void> {
        if (!sessionId) throw new Error("OpenCode 2 has no session.");
        const active = objectValue(openCode2Data(await client.request("GET", "/api/session/active")));
        const inbox = openCode2Data(await client.request("GET", `${openCode2SessionPath(sessionId)}/inbox`));
        if (!active || Object.hasOwn(active, sessionId) || !Array.isArray(inbox) || inbox.length) throw new Error("OpenCode 2 session has unfinished work.");
      }
    } catch {
      status = cancelled && !timedOut ? "cancelled" : "failed";
      if (timedOut) error = "OpenCode 2 exceeded the bounded run deadline.";
      else if (!cancelled) error = "OpenCode 2 could not verify completion. Check its model, authentication, and session state.";
    } finally {
      finished = true; live = false; clearTimeout(watchdog); interactions?.close(); host?.settle();
      // Begin stream cancellation, but do not let draining the network reader
      // delay termination of its owned server. Closing that server also releases
      // readers whose cancellation is waiting for the peer to disconnect.
      const streamClosed = stream?.close().catch(() => undefined);
      try { if (stopping) await stopping; else if (status !== "completed") await stop(); await server?.close(); }
      catch { cleanupConfirmed = false; }
      controller.abort();
      await streamClosed;
      try { await mcp?.close(); } catch { cleanupConfirmed = false; hostCleanupFailed = true; }
      events.finish();
    }
    emit.status(status, error);
    return { ...providerRunTerminal(input, status), sessionId, text: events.text.toString(), textTruncated: events.text.truncated,
      exitCode: server?.child.exitCode ?? null, signal: server?.child.signalCode ?? null, cleanupConfirmed,
      ...(!cleanupConfirmed && !hostCleanupFailed && server ? providerUnconfirmedCleanup(server.child) : {}), ...(error ? { error } : {}) };
  })();
  return { harnessId: "opencode-sdk", providerId: "opencode", result, cancel,
    extension: { kind: "opencode-sdk", respondToApproval: (id, decision) => host?.respondToApproval(id, decision) || interactions?.approval(id, decision) || false,
      respondToInput: (id, answers) => interactions?.input(id, answers) ?? false,
      steer: (steer) => {
        if (!live || cancelled || !server || !sessionId || input.operation || steer.imagePaths.length && !imageInputAvailable) return Promise.resolve(false);
        const work = steerTail.then(async () => {
          if (!live || cancelled || !server || !sessionId) return false;
          const files = await openCode2Images(steer.imagePaths, input.attachmentReadRoots, controller.signal);
          if (!live || cancelled) return false;
          if (ownedInputs.size >= 128) return false;
          const id = `msg_${randomUUID().replaceAll("-", "")}`; ownedInputs.set(id, false); executionOutcome = undefined;
          try {
            const receipt = openCode2Data(await server.client.request("POST", `${openCode2SessionPath(sessionId)}/prompt`, { id, text: steer.content, delivery: "steer", ...(files.length ? { files } : {}) }));
            assertReceipt(receipt, id, sessionId, "user"); return true;
          } catch { fail(); throw new ProviderSteerDeliveryUnknownError(!live); }
        });
        steerTail = work.catch(() => undefined); return work;
      } },
  };
}

function assertSession(info: JsonObject | undefined, id: string, cwd: string): void {
  if (!info || info.id !== id || objectValue(info.location)?.directory !== cwd || info.revert !== undefined && info.revert !== null) throw new Error("OpenCode 2 session identity or history changed.");
}
function assertReceipt(value: unknown, id: string, sessionId: string, type: string): void {
  const receipt = objectValue(value);
  if (!receipt || receipt.id !== id || receipt.sessionID !== sessionId || receipt.type !== type || receipt.delivery !== "steer") throw new Error("OpenCode 2 did not acknowledge the exact input.");
}
