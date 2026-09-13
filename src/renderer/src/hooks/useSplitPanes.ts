import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSnapshot, Conversation } from "@shared/contracts";
import { layoutStorage } from "../utils/layoutStorage";

import {
  persistSplitConversationId,
  readSplitConversationId,
  resolvedSplitConversation,
} from "../utils/splitConversation";
import {
  PINNED_SPLIT_OWNERS,
  PRIMARY_SPLIT_LAYOUT,
  persistSplitLayout,
  readSplitLayout,
  reconcileSplitLayout,
  removeSplitPane,
  withSecondaryFirst,
  type SplitLayout,
  type SplitPaneOwner,
} from "../utils/splitLayout";

export type PinnedSplitOwner = typeof PINNED_SPLIT_OWNERS[number];
type PinnedConversationIds = Record<PinnedSplitOwner, string | null>;
type PinnedConversations = Record<PinnedSplitOwner, Conversation | null>;

export const EXTRA_SPLIT_STORAGE_KEY = "inertia:layout:split-extra-conversations:v1";
const LEGACY_SPLIT_PERCENT_STORAGE_KEY = "inertia:layout:conversation-split-percent:v1";

function storedId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readPinnedIds(storage: Pick<Storage, "getItem">): PinnedConversationIds {
  let extra: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(EXTRA_SPLIT_STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") extra = parsed as Record<string, unknown>;
  } catch {
    extra = {};
  }
  return {
    secondary: readSplitConversationId(storage),
    tertiary: storedId(extra.tertiary),
    quaternary: storedId(extra.quaternary),
  };
}

function resolvePinned(
  snapshot: AppSnapshot | null,
  ids: PinnedConversationIds,
): PinnedConversations {
  const secondary = resolvedSplitConversation(snapshot, ids.secondary);
  const shown = new Set([snapshot?.activeConversationId, secondary?.id]);
  const resolveExtra = (id: string | null): Conversation | null => {
    if (!id || shown.has(id)) return null;
    const conversation = resolvedSplitConversation(snapshot, id);
    shown.add(conversation?.id);
    return conversation;
  };
  return {
    secondary,
    tertiary: resolveExtra(ids.tertiary),
    quaternary: resolveExtra(ids.quaternary),
  };
}

export function useSplitPanes({
  snapshot,
  detachedConversationIds,
  detachedReady,
}: {
  snapshot: AppSnapshot | null;
  detachedConversationIds: ReadonlySet<string>;
  detachedReady: boolean;
}) {
  const [ids, setIds] = useState(() => readPinnedIds(layoutStorage));
  const [storedLayout, setStoredLayout] = useState(() =>
    readSplitLayout(layoutStorage) ?? PRIMARY_SPLIT_LAYOUT);
  const [legacyRatio] = useState(() => Number.parseFloat(
    layoutStorage.getItem(LEGACY_SPLIT_PERCENT_STORAGE_KEY) ?? "",
  ));
  const splitSelectionTransitionsRef = useRef(0);
  const pinned = useMemo(() => resolvePinned(snapshot, ids), [ids, snapshot]);
  const visibleKey = PINNED_SPLIT_OWNERS.filter((owner) => {
    const conversation = pinned[owner];
    return Boolean(conversation && !detachedConversationIds.has(conversation.id));
  }).join(" ");
  const visibleOwners = useMemo(
    () => PINNED_SPLIT_OWNERS.filter((owner) => visibleKey.split(" ").includes(owner)),
    [visibleKey],
  );
  const layout = useMemo(
    () => reconcileSplitLayout(storedLayout, ["primary", ...visibleOwners], legacyRatio),
    [legacyRatio, storedLayout, visibleOwners],
  );
  const layoutRef = useRef(layout);
  const visibleIdsKey = visibleOwners.map((owner) => pinned[owner]?.id).join(" ");
  const splitConversationIds = useMemo(
    () => new Set(visibleIdsKey ? visibleIdsKey.split(" ") : []),
    [visibleIdsKey],
  );

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useEffect(() => {
    persistSplitLayout(layoutStorage, storedLayout);
  }, [storedLayout]);
  useEffect(() => {
    persistSplitConversationId(layoutStorage, ids.secondary);
    layoutStorage.setItem(EXTRA_SPLIT_STORAGE_KEY, JSON.stringify({
      tertiary: ids.tertiary,
      quaternary: ids.quaternary,
    }));
  }, [ids]);

  const commitLayout = useCallback((next: SplitLayout) => {
    layoutRef.current = next;
    setStoredLayout(next);
  }, []);
  const setPaneConversation = useCallback((
    owner: PinnedSplitOwner,
    conversationId: string | null,
  ) => {
    setIds((current) => current[owner] === conversationId
      ? current
      : { ...current, [owner]: conversationId });
  }, []);
  const setSecondaryPaneFirst = useCallback((secondaryFirst: boolean) => {
    const next = withSecondaryFirst(layoutRef.current, secondaryFirst);
    if (next !== layoutRef.current) commitLayout(next);
  }, [commitLayout]);
  const updateSplitConversationId = useCallback((
    conversationId: string | null,
    keepPaneOrder = false,
  ) => {
    setPaneConversation("secondary", conversationId);
    if (!keepPaneOrder) setSecondaryPaneFirst(false);
  }, [setPaneConversation, setSecondaryPaneFirst]);
  const closePane = useCallback((owner: SplitPaneOwner) => {
    if (owner === "primary") return;
    setPaneConversation(owner, null);
    commitLayout(removeSplitPane(layoutRef.current, owner));
  }, [commitLayout, setPaneConversation]);

  useEffect(() => {
    if (splitSelectionTransitionsRef.current > 0 || !snapshot) return;
    for (const owner of PINNED_SPLIT_OWNERS) {
      if (ids[owner] && !pinned[owner]) setPaneConversation(owner, null);
    }
  }, [ids, pinned, setPaneConversation, snapshot]);
  useEffect(() => {
    if (!detachedReady) return;
    for (const owner of PINNED_SPLIT_OWNERS) {
      const conversation = pinned[owner];
      if (conversation && detachedConversationIds.has(conversation.id)) {
        setPaneConversation(owner, null);
      }
    }
  }, [detachedConversationIds, detachedReady, pinned, setPaneConversation]);

  const activeConversationId = snapshot?.activeConversationId ?? null;
  const ownerOf = useCallback((conversationId: string): SplitPaneOwner | null => {
    if (conversationId === activeConversationId) return "primary";
    return visibleOwners.find((owner) => pinned[owner]?.id === conversationId) ?? null;
  }, [activeConversationId, pinned, visibleOwners]);
  const extraPanes = useMemo(
    () => visibleOwners.flatMap((owner) => {
      const conversation = pinned[owner];
      return owner !== "secondary" && conversation ? [{ owner, conversation }] : [];
    }),
    [pinned, visibleOwners],
  );

  return {
    splitConversationId: ids.secondary,
    splitConversation: pinned.secondary,
    splitConversationDetached: Boolean(
      pinned.secondary && detachedConversationIds.has(pinned.secondary.id),
    ),
    pinned,
    visibleOwners,
    extraPanes,
    layout,
    splitConversationIds,
    freeOwner: PINNED_SPLIT_OWNERS.find((owner) => !visibleOwners.includes(owner)) ?? null,
    splitSelectionTransitionsRef,
    ownerOf,
    commitLayout,
    setPaneConversation,
    setSecondaryPaneFirst,
    updateSplitConversationId,
    closePane,
  };
}

export type SplitPanes = ReturnType<typeof useSplitPanes>;
