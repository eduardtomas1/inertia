import { useMemo } from "react";

import type { ServerEvent } from "@shared/contracts";
import type {
  WatcherDeliveryMode,
  WatcherLinkView,
} from "@shared/watcher";
import type { WatcherUpdatePayload } from "@shared/contracts/client-command/watcher";
import { resultEvent, type CommandWithoutId } from "../lib/runtimeCommands";

type RequestResult = Extract<ServerEvent, { type: "request.result" }>["result"];
export type WatcherFeedResult = Extract<RequestResult, { kind: "watcher.feed" }>;
export type WatcherDeliveryResult = Extract<RequestResult, { kind: "watcher.delivery" }>;
type WatcherRequest = (command: CommandWithoutId) => Promise<ServerEvent>;

const UNEXPECTED = "The watcher returned an unexpected response.";

function expectResult<Kind extends RequestResult["kind"]>(
  event: ServerEvent,
  kind: Kind,
): Extract<RequestResult, { kind: Kind }> {
  const { result } = resultEvent(event);
  if (result.kind !== kind) throw new Error(UNEXPECTED);
  return result as Extract<RequestResult, { kind: Kind }>;
}

export interface WatcherActions {
  pause: () => Promise<WatcherLinkView>;
  resume: () => Promise<WatcherLinkView>;
  wake: () => Promise<WatcherLinkView>;
  review: () => Promise<WatcherLinkView>;
  detach: () => Promise<WatcherLinkView>;
  update: (patch: Omit<WatcherUpdatePayload, "linkId">) => Promise<WatcherLinkView>;
  feed: (beforeSequence?: number) => Promise<WatcherFeedResult>;
  deliver: (wakeId: string, mode: WatcherDeliveryMode, deliveryId: string) => Promise<WatcherDeliveryResult>;
  dismiss: (wakeId: string) => Promise<WatcherDeliveryResult>;
}

export function createWatcherActions(request: WatcherRequest, linkId: string): WatcherActions {
  const link = async (type: "watcher.pause" | "watcher.resume" | "watcher.wake" | "watcher.review" | "watcher.detach") =>
    expectResult(await request({ type, payload: { linkId } }), "watcher.link").link;
  return {
    pause: () => link("watcher.pause"),
    resume: () => link("watcher.resume"),
    wake: () => link("watcher.wake"),
    review: () => link("watcher.review"),
    detach: () => link("watcher.detach"),
    update: async (patch) => expectResult(
      await request({ type: "watcher.update", payload: { ...patch, linkId } }),
      "watcher.link",
    ).link,
    feed: async (beforeSequence) => {
      const result = expectResult(await request({
        type: "watcher.feed.get",
        payload: beforeSequence === undefined ? { linkId } : { linkId, beforeSequence },
      }), "watcher.feed");
      if (result.linkId !== linkId) throw new Error(UNEXPECTED);
      return result;
    },
    deliver: async (wakeId, mode, deliveryId) => {
      const result = expectResult(await request({
        type: "watcher.note.deliver",
        payload: { linkId, wakeId, mode, deliveryId },
      }), "watcher.delivery");
      if (result.linkId !== linkId || result.wakeId !== wakeId) throw new Error(UNEXPECTED);
      return result;
    },
    dismiss: async (wakeId) => {
      const result = expectResult(await request({
        type: "watcher.note.dismiss",
        payload: { linkId, wakeId },
      }), "watcher.delivery");
      if (result.linkId !== linkId || result.wakeId !== wakeId) throw new Error(UNEXPECTED);
      return result;
    },
  };
}

export function useWatcherActions(request: WatcherRequest | null, linkId: string): WatcherActions | null {
  return useMemo(
    () => request ? createWatcherActions(request, linkId) : null,
    [linkId, request],
  );
}
