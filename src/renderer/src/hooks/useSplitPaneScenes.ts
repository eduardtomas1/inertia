import { useCallback, useMemo } from "react";
import type { Conversation, Project } from "@shared/contracts";

import type {
  SplitPaneDetails,
  WorkspaceSceneProps,
} from "../components/WorkspaceScene";
import { PINNED_SPLIT_OWNERS, reconcileSplitLayout } from "../utils/splitLayout";
import { routeWorkspaceRunPreview } from "../utils/workspacePreviewFocus";
import type { PreviewWorkspaceRun } from "./useActivityActions";
import {
  useConversationPaneLayout,
  type ConversationPaneLayout,
} from "./useConversationPaneLayout";
import type { SplitPanes } from "./useSplitPanes";
import { useSplitWorkspaceScene } from "./useSplitWorkspaceScene";

type SharedPaneOptions = Omit<
  Parameters<typeof useSplitWorkspaceScene>[0],
  "owner" | "splitConversation" | "visible" | "layout" | "onConversationCreated"
>;

export function useSplitPaneScenes({
  split,
  shared,
  visible,
  conversation,
  project,
  primaryLayout,
  openConversationInWindow,
  openPrimaryWorkspaceRunPreview,
}: {
  split: SplitPanes;
  shared: SharedPaneOptions;
  visible: boolean;
  conversation: Conversation | null;
  project: Project | null;
  primaryLayout: ConversationPaneLayout;
  openConversationInWindow: (conversation: Conversation) => void;
  openPrimaryWorkspaceRunPreview: (run: PreviewWorkspaceRun) => void;
}) {
  const { pinned, visibleOwners } = split;
  const secondaryLayout = useConversationPaneLayout(pinned.secondary?.id ?? null);
  const secondary = useSplitWorkspaceScene({
    ...shared,
    owner: "secondary",
    splitConversation: pinned.secondary,
    visible: visible && visibleOwners.includes("secondary"),
    layout: secondaryLayout,
    onConversationCreated: split.updateSplitConversationId,
  });
  const tertiaryLayout = useConversationPaneLayout(pinned.tertiary?.id ?? null);
  const tertiary = useSplitWorkspaceScene({
    ...shared,
    owner: "tertiary",
    splitConversation: pinned.tertiary,
    visible: visible && visibleOwners.includes("tertiary"),
    layout: tertiaryLayout,
    onConversationCreated: (conversationId) =>
      split.setPaneConversation("tertiary", conversationId),
  });
  const quaternaryLayout = useConversationPaneLayout(pinned.quaternary?.id ?? null);
  const quaternary = useSplitWorkspaceScene({
    ...shared,
    owner: "quaternary",
    splitConversation: pinned.quaternary,
    visible: visible && visibleOwners.includes("quaternary"),
    layout: quaternaryLayout,
    onConversationCreated: (conversationId) =>
      split.setPaneConversation("quaternary", conversationId),
  });

  const openWorkspaceRunPreview = useCallback((run: PreviewWorkspaceRun) => {
    routeWorkspaceRunPreview(run, [
      [pinned.secondary?.id ?? null, secondary.openWorkspaceRunPreview],
      [pinned.tertiary?.id ?? null, tertiary.openWorkspaceRunPreview],
      [pinned.quaternary?.id ?? null, quaternary.openWorkspaceRunPreview],
    ], openPrimaryWorkspaceRunPreview);
  }, [
    openPrimaryWorkspaceRunPreview,
    pinned.quaternary?.id,
    pinned.secondary?.id,
    pinned.tertiary?.id,
    quaternary.openWorkspaceRunPreview,
    secondary.openWorkspaceRunPreview,
    tertiary.openWorkspaceRunPreview,
  ]);

  const splitScene = useMemo((): WorkspaceSceneProps["splitScene"] => {
    if (!conversation) return null;
    const scenes = {
      secondary: secondary.pane,
      tertiary: tertiary.pane,
      quaternary: quaternary.pane,
    };
    const pinnedPanes = PINNED_SPLIT_OWNERS.flatMap((owner): SplitPaneDetails[] => {
      const pane = scenes[owner];
      const target = pinned[owner];
      if (!pane || !target || !visibleOwners.includes(owner)) return [];
      const tools = pane.scene?.tools;
      return [{
        ...pane,
        onOpenInWindow: () => openConversationInWindow(target),
        scene: pane.scene && tools ? {
          ...pane.scene,
          tools: {
            ...tools,
            runs: {
              ...tools.runs,
              onOpenRunPreview: openWorkspaceRunPreview,
            },
          },
        } : pane.scene,
      }];
    });
    if (pinnedPanes.length === 0) return null;
    const panes: SplitPaneDetails[] = [{
      owner: "primary",
      conversationId: conversation.id,
      title: conversation.title,
      projectName: project?.name ?? "Project",
      toolsOpen: primaryLayout.activeTool !== null,
      onToggleTools: primaryLayout.toggleWorkspaceTools,
      terminalOpen: primaryLayout.terminalOpen,
      onToggleTerminal: primaryLayout.toggleTerminal,
      onOpenInWindow: () => openConversationInWindow(conversation),
      scene: null,
    }, ...pinnedPanes];
    return {
      layout: reconcileSplitLayout(split.layout, panes.map(({ owner }) => owner)),
      panes,
      onLayoutChange: split.commitLayout,
      onClosePane: split.closePane,
    };
  }, [
    conversation,
    openConversationInWindow,
    openWorkspaceRunPreview,
    pinned,
    primaryLayout.activeTool,
    primaryLayout.terminalOpen,
    primaryLayout.toggleTerminal,
    primaryLayout.toggleWorkspaceTools,
    project?.name,
    quaternary.pane,
    secondary.pane,
    split.closePane,
    split.commitLayout,
    split.layout,
    tertiary.pane,
    visibleOwners,
  ]);

  return { splitScene, openWorkspaceRunPreview };
}
