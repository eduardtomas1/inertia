import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { objectValue, type JsonObject } from "../codex/protocol";
import { controlNativeConversation } from "./native-conversation-control";
import { NativeConversationRejection, retainedNativeHead, type NativeConversationOperations } from "./native-conversation-operations";
import { openCode2Data, openCode2Id, openCode2SessionPath, openCode2SettledMessage, readOpenCode2History, type OpenCode2Api } from "./opencode2-history";
import { openOwnedOpenCode2Server } from "./opencode2-server";

async function session(client: OpenCode2Api, id: string, cwd: string): Promise<JsonObject> {
  const info = objectValue(openCode2Data(await client.request("GET", openCode2SessionPath(id))));
  if (!info || info.id !== id || objectValue(info.location)?.directory !== cwd) throw new NativeConversationRejection("rejected", "native-session-workspace-mismatch");
  if (info.revert !== undefined && info.revert !== null) throw new NativeConversationRejection("rejected", "native-revert-already-staged");
  return info;
}
async function requireIdle(client: OpenCode2Api, id: string): Promise<void> {
  const active = objectValue(openCode2Data(await client.request("GET", "/api/session/active")));
  const inbox = openCode2Data(await client.request("GET", `${openCode2SessionPath(id)}/inbox`));
  if (!active || !Array.isArray(inbox)) throw new Error("Invalid OpenCode 2 execution state.");
  if (Object.hasOwn(active, id) || inbox.length) throw new NativeConversationRejection("rejected", "conversation-busy");
}
function messageContents(history: JsonObject[]): JsonObject[] {
  return history.map(({ id: _id, ...message }) => message);
}

export function createOpenCode2NativeConversationOperations(active: ReadonlySet<string>,
  open: typeof openOwnedOpenCode2Server = openOwnedOpenCode2Server): NativeConversationOperations {
  return { capabilities: { fork: "native", rollback: "native-revert" },
    execute: (request, launch) => controlNativeConversation(request, launch, active, true, async (signal, progress) => {
      const sourceId = request.source.nativeConversationId;
      if (!openCode2Id(sourceId, "ses_")) throw new NativeConversationRejection("rejected", "invalid-native-session-id");
      const sourceCwd = launch.sourceCwd ?? launch.cwd;
      if (await realpath(sourceCwd) !== resolve(sourceCwd)) throw new NativeConversationRejection("rejected", "source-workspace-not-canonical");
      const server = await open({ ...launch, cwd: sourceCwd, signal });
      const client = server.client;
      try {
        const info = await session(client, sourceId, sourceCwd);
        await requireIdle(client, sourceId);
        const history = await readOpenCode2History(client, sourceId);
        const head = history.at(-1)?.id as string | undefined;
        if ((head ?? null) !== request.source.expectedHeadId) throw new NativeConversationRejection("rejected", "native-head-changed");
        const retained = retainedNativeHead(request.boundary);
        const index = retained === null ? -1 : history.findIndex((message) => message.id === retained);
        if (retained !== null && index < 0) throw new NativeConversationRejection("rejected", "boundary-not-in-native-history");
        if (index >= 0 && !openCode2SettledMessage(history[index]!)) throw new NativeConversationRejection("unsupported", "boundary-is-not-a-complete-native-turn");
        const expected = history.slice(0, index + 1); const before = history[index + 1]?.id;
        if (request.kind === "rollback" && retained === (head ?? null)) {
          return { status: "completed", effect: "unchanged", backing: { nativeConversationId: sourceId, headId: retained, persistedHeadId: retained } };
        }
        await requireIdle(client, sourceId);
        if (!isDeepStrictEqual(await readOpenCode2History(client, sourceId), history)) throw new NativeConversationRejection("rejected", "native-head-changed");
        signal.throwIfAborted();
        progress.mutationMayHaveOccurred = true;
        if (request.kind === "fork") {
          const raw = history.length ? await client.request("POST", `${openCode2SessionPath(sourceId)}/fork`, before ? { before } : {})
            : await client.request("POST", "/api/session", { location: { directory: launch.cwd }, ...(info.model ? { model: info.model } : {}), ...(info.agent ? { agent: info.agent } : {}) });
          const fork = objectValue(openCode2Data(raw));
          if (!fork || !openCode2Id(fork.id, "ses_") || fork.id === sourceId) throw new Error("OpenCode 2 did not create a distinct fork.");
          progress.createdNativeConversationId = fork.id;
          const cloned = await readOpenCode2History(client, fork.id);
          // OpenCode assigns new message IDs while preserving copied message bodies.
          if (!isDeepStrictEqual(messageContents(cloned), messageContents(expected))) throw new Error("OpenCode 2 fork did not retain the exact requested history.");
          const targetHead = (cloned.at(-1)?.id as string | undefined) ?? null;
          if (objectValue(fork.location)?.directory !== launch.cwd) {
            await client.request("POST", `${openCode2SessionPath(fork.id)}/move`, { directory: launch.cwd });
            await client.request("POST", `/api/experimental/session/${encodeURIComponent(fork.id)}/wait`);
          }
          await session(client, fork.id, launch.cwd); await requireIdle(client, fork.id);
          const targetHistory = await readOpenCode2History(client, fork.id);
          if (!isDeepStrictEqual(targetHistory.slice(0, cloned.length), cloned)
            || targetHistory.slice(cloned.length).some((message) => !(message.type === "idle" && message.outcome === "succeeded")
              && (message.type !== "location-switched" || objectValue(message.location)?.directory !== launch.cwd))) throw new Error("OpenCode 2 fork changed while relocating.");
          return { status: "completed", effect: "native-fork", backing: { nativeConversationId: fork.id, headId: targetHead, persistedHeadId: (targetHistory.at(-1)?.id as string | undefined) ?? null } };
        }
        if (!openCode2Id(before, "msg_")) throw new Error("OpenCode 2 rollback has no exact discard boundary.");
        const staged = objectValue(openCode2Data(await client.request("POST", `${openCode2SessionPath(sourceId)}/revert/stage`, { messageID: before, files: false })));
        if (staged?.messageID !== before) throw new Error("OpenCode 2 staged a different rollback boundary.");
        await client.request("POST", `${openCode2SessionPath(sourceId)}/revert/commit`);
        await session(client, sourceId, sourceCwd);
        if (!isDeepStrictEqual(await readOpenCode2History(client, sourceId), expected)) throw new Error("OpenCode 2 rollback did not retain the exact requested history.");
        return { status: "completed", effect: "native-revert", backing: { nativeConversationId: sourceId, headId: retained, persistedHeadId: retained } };
      } finally { await server.close(); }
    }),
  };
}
