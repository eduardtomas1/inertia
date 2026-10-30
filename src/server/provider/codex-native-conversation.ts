import { withCodexControlClient, type CodexControlClient } from "../codex/control-client";
import { objectValue, type JsonObject } from "../codex/protocol";
import { validateCodexModelProvider } from "../codex/app-server-config";
import { codexModelProviderThreadConfig } from "../codex/model-provider-config";
import { controlNativeConversation } from "./native-conversation-control";
import {
  nativeId, NativeConversationRejection, retainedNativeHead,
  type NativeConversationBacking, type NativeConversationOperations,
} from "./native-conversation-operations";

const MAX_HISTORY_TURNS = 10_000;
const TERMINAL = new Set(["completed", "interrupted", "failed"]);

function threadMetadata(response: JsonObject, expectedId: string): JsonObject {
  const thread = objectValue(response.thread);
  if (!thread || thread.id !== expectedId
    || (thread.sessionId !== undefined && !nativeId(thread.sessionId))) {
    throw new Error("Invalid native thread identity.");
  }
  const status = objectValue(thread.status)?.type;
  if (status !== "idle" && status !== "notLoaded") {
    throw new NativeConversationRejection("rejected", "native-thread-not-idle");
  }
  return thread;
}

async function history(client: CodexControlClient, threadId: string, signal: AbortSignal): Promise<string[]> {
  const ids: string[] = [];
  const seenIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await client.request("thread/turns/list", {
      threadId, limit: 100, sortDirection: "desc", itemsView: "summary", ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page.data) || page.data.length > 100) throw new Error("Invalid native history page.");
    for (const value of page.data) {
      const turn = objectValue(value);
      if (!turn || !nativeId(turn.id) || seenIds.has(turn.id)) throw new Error("Invalid native history turn.");
      if (typeof turn.status !== "string" || !TERMINAL.has(turn.status)) {
        throw new NativeConversationRejection("rejected", "native-turn-not-stable");
      }
      seenIds.add(turn.id);
      ids.push(turn.id);
    }
    if (page.nextCursor !== null && page.nextCursor !== undefined && !nativeId(page.nextCursor)) {
      throw new Error("Invalid native history cursor.");
    }
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    if (cursor && (cursors.has(cursor) || page.data.length === 0)) throw new Error("Native history pagination did not advance.");
    if (cursor) cursors.add(cursor);
    if (ids.length > MAX_HISTORY_TURNS || (cursor && ids.length === MAX_HISTORY_TURNS)) {
      throw new NativeConversationRejection("unsupported", "native-history-limit");
    }
  } while (cursor);
  return ids;
}

export function createCodexNativeConversationOperations(
  active: ReadonlySet<string>,
  control: typeof withCodexControlClient = withCodexControlClient,
): NativeConversationOperations {
  return {
    capabilities: { fork: "native", rollback: "native-revert" },
    execute: async (request, launch) => await controlNativeConversation(request, launch, active, true, async (signal, progress) => {
      if (launch.harnessConfiguration && launch.harnessConfiguration.kind !== "codex-responses") {
        throw new NativeConversationRejection("rejected", "incompatible-harness-configuration");
      }
      const modelProvider = validateCodexModelProvider({ environment: launch.environment, modelProvider: launch.harnessConfiguration });
      return await control({ ...launch, signal, processLabel: "Codex native conversation control" }, async (client) => {
        const sourceId = request.source.nativeConversationId;
        const thread = threadMetadata(await client.request("thread/read", { threadId: sourceId, includeTurns: false }), sourceId);
        if (request.source.nativeSessionId !== undefined && thread.sessionId !== request.source.nativeSessionId) {
          throw new NativeConversationRejection("rejected", "native-session-mismatch");
        }
        if (thread.historyMode !== "paginated") {
          throw new NativeConversationRejection("unsupported", "paginated-native-history-required");
        }
        const turns = await history(client, sourceId, signal);
        const headId = turns[0] ?? null;
        if (headId !== request.source.expectedHeadId) throw new NativeConversationRejection("rejected", "native-head-changed");
        const kept = retainedNativeHead(request.boundary);
        if (kept !== null && !turns.includes(kept)) throw new NativeConversationRejection("rejected", "native-boundary-not-found");
        const backing: NativeConversationBacking = {
          nativeConversationId: sourceId,
          ...(typeof thread.sessionId === "string" ? { nativeSessionId: thread.sessionId } : {}),
          headId: kept,
          persistedHeadId: kept,
        };
        if (request.kind === "rollback" && kept === headId) return { status: "completed", effect: "unchanged", backing };
        if (request.kind === "fork" && kept === null) throw new NativeConversationRejection("unsupported", "empty-native-fork-boundary");
        signal.throwIfAborted();
        // Control requests never authorize tools or execute a prompt. A normal
        // subsequent run supplies its own current route and permission policy.
        const config: JsonObject = { cwd: launch.cwd, approvalPolicy: "never", sandbox: "read-only", excludeTurns: true };
        if (modelProvider) {
          const effective = modelProvider.credentialEnvironmentKey
            ? await client.request("config/read", { includeLayers: false, cwd: launch.cwd }) : null;
          config.modelProvider = modelProvider.providerId;
          config.config = codexModelProviderThreadConfig(modelProvider, effective);
        }
        signal.throwIfAborted();
        if (request.kind === "fork") {
          progress.mutationMayHaveOccurred = true;
          const result = await client.request("thread/fork", { ...config, threadId: sourceId, lastTurnId: kept });
          const fork = objectValue(result.thread);
          if (nativeId(fork?.id) && fork.id !== sourceId) progress.createdNativeConversationId = fork.id;
          if (!fork || !nativeId(fork.id) || fork.id === sourceId
            || (fork.forkedFromId !== undefined && fork.forkedFromId !== sourceId)
            || (thread.sessionId !== undefined && fork.sessionId !== thread.sessionId)) {
            throw new Error("Invalid native fork identity.");
          }
          const checked = threadMetadata(await client.request("thread/read", { threadId: fork.id, includeTurns: false }), fork.id);
          if (checked.historyMode !== "paginated" || checked.sessionId !== fork.sessionId
            || (await history(client, fork.id, signal))[0] !== kept) {
            throw new Error("Native fork boundary was not confirmed.");
          }
          return { status: "completed", effect: "native-fork", backing: {
            nativeConversationId: fork.id,
            ...(typeof fork.sessionId === "string" ? { nativeSessionId: fork.sessionId } : {}), headId: kept, persistedHeadId: kept,
          } };
        }
        if (objectValue(thread.status)?.type === "notLoaded") {
          const resumed = threadMetadata(await client.request("thread/resume", { ...config, threadId: sourceId }), sourceId);
          if (resumed.historyMode !== "paginated" || resumed.sessionId !== thread.sessionId) throw new Error("Native history changed while resuming.");
          if ((await history(client, sourceId, signal))[0] !== headId) throw new NativeConversationRejection("rejected", "native-head-changed");
        }
        const beforeTurnId = kept === null ? turns.at(-1) : turns[turns.indexOf(kept) - 1];
        if (!beforeTurnId) throw new Error("Native revert boundary is missing.");
        signal.throwIfAborted();
        progress.mutationMayHaveOccurred = true;
        const reverted = threadMetadata(await client.request("thread/revert", { threadId: sourceId, beforeTurnId }), sourceId);
        if (reverted.historyMode !== "paginated" || reverted.sessionId !== thread.sessionId
          || ((await history(client, sourceId, signal))[0] ?? null) !== kept) {
          throw new Error("Native revert boundary was not confirmed.");
        }
        return { status: "completed", effect: "native-revert", backing };
      });
    }),
  };
}
