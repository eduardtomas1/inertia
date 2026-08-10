import { randomUUID } from "node:crypto";

import type WebSocket from "ws";

import type { ServerEvent } from "../../src/shared/contracts";
import type { RuntimeEventQueue } from "./runtime-event-queue";

export async function requestRuntimeGit(
  socket: WebSocket,
  events: RuntimeEventQueue,
  type: string,
  payload: object,
  kind: string,
  deadlineAt: number,
): Promise<Extract<ServerEvent, { type: "request.result" }>> {
  const requestId = randomUUID();
  socket.send(JSON.stringify({ type, requestId, payload }));
  return await events.nextForRequest(
    requestId,
    (event): event is Extract<ServerEvent, { type: "request.result" }> =>
      event.type === "request.result"
      && event.requestId === requestId
      && event.result.kind === kind,
    deadlineAt,
  );
}

export async function refreshRuntimeRootGitAuthority(
  socket: WebSocket,
  events: RuntimeEventQueue,
  identity: { projectId: string; conversationId?: string },
  deadlineAt: number,
): Promise<{
  projectId: string;
  conversationId?: string;
  repositoryPath: ".";
  authorityRef: string;
}> {
  const refreshed = await requestRuntimeGit(
    socket,
    events,
    "git.refresh",
    identity,
    "git.status",
    deadlineAt,
  );
  if (
    refreshed.result.kind !== "git.status"
    || !refreshed.result.status.authorityRef
  ) {
    throw new Error("Expected an authorized Git status result.");
  }
  return {
    ...identity,
    repositoryPath: ".",
    authorityRef: refreshed.result.status.authorityRef,
  };
}
