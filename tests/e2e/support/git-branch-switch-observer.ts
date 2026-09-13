import type { Page } from "@playwright/test";

export interface BranchSwitchTarget {
  projectId: string;
  conversationId: string;
  repositoryPath: string;
  name: string;
  remote: boolean;
}

type Frame = { response: { payloadData: string } };
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function message(frame: Frame): Record<string, unknown> | undefined {
  if (frame.response.payloadData.length > 500_000) return undefined;
  try { return object(JSON.parse(frame.response.payloadData)); }
  catch { return undefined; }
}

/** Observes the real UI command; never sends, holds, or substitutes a frame. */
export async function observeBranchSwitch(page: Page, target: BranchSwitchTarget): Promise<{
  waitForResult: () => Promise<void>;
  dispose: () => Promise<void>;
}> {
  const session = await page.context().newCDPSession(page);
  try { await session.send("Network.enable"); }
  catch (error) {
    try { await session.detach(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Branch observer setup and cleanup failed."); }
    throw error;
  }
  let requestId: string | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout>;
  let settle!: (error?: Error) => void;
  // Resolve with the outcome so an action failure before waitForResult() does
  // not leave an unhandled rejection while its observer is being disposed.
  const outcome = new Promise<Error | undefined>((resolve) => { settle = resolve; });
  const finish = (error?: Error): void => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    session.off("Network.webSocketFrameSent", sent);
    session.off("Network.webSocketFrameReceived", received);
    settle(error);
  };
  const sent = (frame: Frame): void => {
    if (requestId) return;
    const command = message(frame);
    const payload = object(command?.payload);
    if (command?.type !== "git.branch.switch" || typeof command.requestId !== "string"
      || !command.requestId || !payload
      || Object.entries(target).some(([key, value]) => payload[key] !== value)) return;
    requestId = command.requestId;
    clearTimeout(timer);
    timer = setTimeout(() => finish(new Error(`Branch switch ${requestId} did not return a result within 60000ms.`)), 60_000);
  };
  const received = (frame: Frame): void => {
    const raw = message(frame);
    const event = raw?.type === "runtime.event" ? object(raw.event) : raw;
    if (!requestId || event?.requestId !== requestId) return;
    if (event.type === "request.error") {
      finish(new Error(typeof event.message === "string" ? event.message : "Branch switch was rejected."));
    } else if (event.type === "request.result") {
      finish(object(event.result)?.kind === "git.action" ? undefined
        : new Error(`Branch switch ${requestId} returned an unexpected result kind.`));
    }
  };
  session.on("Network.webSocketFrameSent", sent);
  session.on("Network.webSocketFrameReceived", received);
  timer = setTimeout(() => finish(new Error("The intended branch switch was not sent within 15000ms.")), 15_000);
  let disposal: Promise<void> | undefined;
  return {
    waitForResult: async () => {
      const error = await outcome;
      if (error) throw error;
    },
    dispose: () => {
      finish(new Error("Branch switch observation was disposed before completion."));
      disposal ??= session.detach();
      return disposal;
    },
  };
}
