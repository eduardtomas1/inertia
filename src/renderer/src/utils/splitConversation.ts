import type { AppSnapshot, Conversation } from "@shared/contracts";

export const SPLIT_CONVERSATION_STORAGE_KEY =
  "inertia:layout:split-conversation:v1";
export const SPLIT_ORIENTATION_STORAGE_KEY =
  "inertia:layout:conversation-split-orientation:v1";

export type SplitOrientation = "columns" | "rows";
export type SplitDropZone = "left" | "right" | "top" | "bottom";

export interface SplitDropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function readSplitOrientation(
  storage: Pick<Storage, "getItem">,
): SplitOrientation {
  return storage.getItem(SPLIT_ORIENTATION_STORAGE_KEY) === "rows"
    ? "rows"
    : "columns";
}

export function persistSplitOrientation(
  storage: Pick<Storage, "setItem">,
  orientation: SplitOrientation,
): void {
  storage.setItem(SPLIT_ORIENTATION_STORAGE_KEY, orientation);
}

export function splitDropZone(
  rect: SplitDropRect,
  x: number,
  y: number,
  stackedOnly: boolean,
): SplitDropZone | null {
  const relativeX = (x - rect.left) / rect.width;
  const relativeY = (y - rect.top) / rect.height;
  if (
    !(relativeX >= 0 && relativeX <= 1 && relativeY >= 0 && relativeY <= 1)
  ) {
    return null;
  }
  if (
    !stackedOnly
    && Math.abs(relativeX - 0.5) >= Math.abs(relativeY - 0.5)
  ) {
    return relativeX < 0.5 ? "left" : "right";
  }
  return relativeY < 0.5 ? "top" : "bottom";
}

export function splitDropRect(
  rect: SplitDropRect,
  zone: SplitDropZone,
): SplitDropRect {
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  return {
    left: zone === "right" ? rect.left + halfWidth : rect.left,
    top: zone === "bottom" ? rect.top + halfHeight : rect.top,
    width: zone === "left" || zone === "right" ? halfWidth : rect.width,
    height: zone === "top" || zone === "bottom" ? halfHeight : rect.height,
  };
}

export function splitDropArrangement(
  zone: SplitDropZone,
  droppedIsPrimary: boolean,
): { orientation: SplitOrientation; secondaryFirst: boolean } {
  const droppedFirst = zone === "left" || zone === "top";
  return {
    orientation: zone === "left" || zone === "right" ? "columns" : "rows",
    secondaryFirst: droppedIsPrimary ? !droppedFirst : droppedFirst,
  };
}

export function readSplitConversationId(
  storage: Pick<Storage, "getItem">,
): string | null {
  const value = storage.getItem(SPLIT_CONVERSATION_STORAGE_KEY)?.trim();
  return value ? value : null;
}

export function persistSplitConversationId(
  storage: Pick<Storage, "removeItem" | "setItem">,
  conversationId: string | null,
): void {
  if (conversationId) {
    storage.setItem(SPLIT_CONVERSATION_STORAGE_KEY, conversationId);
  } else {
    storage.removeItem(SPLIT_CONVERSATION_STORAGE_KEY);
  }
}

export function resolvedSplitConversation(
  snapshot: AppSnapshot | null,
  requestedId: string | null,
): Conversation | null {
  if (!snapshot || !requestedId || !snapshot.activeConversationId) return null;
  const primary = snapshot.conversations.find(
    ({ id }) => id === snapshot.activeConversationId,
  );
  const secondary = snapshot.conversations.find(({ id }) => id === requestedId);
  if (
    !primary
    || !secondary
    || secondary.id === primary.id
    || secondary.archivedAt !== null
  ) {
    return null;
  }
  return secondary;
}

export function splitConversationAfterPrimaryChange(
  previousPrimary: Conversation | null,
  nextPrimary: Conversation,
  currentSecondary: Conversation | null,
): string | null {
  if (!previousPrimary || !currentSecondary) return null;
  if (nextPrimary.id === currentSecondary.id) return previousPrimary.id;
  return currentSecondary.id;
}
