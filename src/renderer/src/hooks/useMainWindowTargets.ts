import { useEffect, useRef } from "react";

import type { AppSnapshot, Conversation, Project } from "@shared/contracts";
import type {
  MainWindowNewChatCheckout,
  MainWindowTargetRequest,
} from "@shared/desktop";
import type { ProviderAuthMethod, ProviderId } from "@shared/provider";
import { useUsageLimitsContext } from "../components/usage-limits-state";
import type { NewConversationLocation } from "../lib/newConversation";
import type { SettingsProfilePanel, SettingsTarget } from "../lib/settingsTarget";

export interface MainWindowTargetActions {
  selectConversation: (conversation: Conversation) => void;
  showWorkspace: () => void;
  createConversation: (project: Project, location: NewConversationLocation) => void;
  openSettings: (target: SettingsTarget) => void;
  connectProvider: (providerId: ProviderId, method: ProviderAuthMethod) => void;
  openBackendSetup: (profileId: string, panel?: SettingsProfilePanel) => void;
  openUsageLimits: () => void;
  reportUnavailable: (message: string) => void;
}

function newChatLocation(
  source: Conversation,
  checkout: MainWindowNewChatCheckout | undefined,
): NewConversationLocation | null {
  if (!checkout) return { kind: "defaults" };
  if (checkout.kind === "branch") return { kind: "branch", branch: checkout.branch };
  if (checkout.kind === "isolated-worktree") return { kind: "isolated-worktree" };
  return source.worktreePath
    ? { kind: "worktree", branch: checkout.branch ?? source.branch, path: source.worktreePath }
    : null;
}

export function performMainWindowTarget(
  snapshot: AppSnapshot,
  { sourceConversationId, target }: MainWindowTargetRequest,
  actions: MainWindowTargetActions,
): void {
  switch (target.kind) {
    case "conversation": {
      const conversation = snapshot.conversations.find(({ id }) => id === target.conversationId);
      if (!conversation) return actions.reportUnavailable("That chat is no longer available.");
      actions.showWorkspace();
      return actions.selectConversation(conversation);
    }
    case "new-chat": {
      const source = snapshot.conversations.find(({ id }) => id === sourceConversationId);
      const project = snapshot.projects.find(({ id }) => id === target.projectId);
      if (!source || !project || source.projectId !== project.id) {
        return actions.reportUnavailable("That project is no longer available.");
      }
      const location = newChatLocation(source, target.checkout);
      if (!location) return actions.reportUnavailable("That worktree is no longer available.");
      return actions.createConversation(project, location);
    }
    case "settings":
      return actions.openSettings({ section: target.page });
    case "provider-setup":
      if (!snapshot.providers.some(({ id }) => id === target.providerId)) {
        return actions.reportUnavailable("That agent is no longer available.");
      }
      return actions.connectProvider(target.providerId, target.method ?? "account");
    case "backend-setup":
      if (target.profileId === undefined) {
        return actions.openSettings({ section: "agents", anchor: "model-backends" });
      }
      if (!snapshot.backendProfiles?.some(({ id }) => id === target.profileId)) {
        return actions.reportUnavailable("That model backend is no longer available.");
      }
      return actions.openBackendSetup(target.profileId, target.panel);
    case "diagnostics":
      return actions.openSettings({
        section: "help",
        anchor: "diagnostics-incidents",
        ...(target.turnId ? { selection: { turnId: target.turnId } } : {}),
      });
    case "usage-limits":
      return actions.openUsageLimits();
  }
}

export function useMainWindowTargets(
  snapshot: AppSnapshot | null,
  actions: MainWindowTargetActions,
): void {
  const snapshotRef = useRef(snapshot);
  const actionsRef = useRef(actions);
  const pendingRef = useRef<MainWindowTargetRequest | null>(null);
  snapshotRef.current = snapshot;
  actionsRef.current = actions;

  useEffect(() => {
    const subscribe = window.inertia?.onMainWindowTarget;
    if (!subscribe) return;
    return subscribe((request) => {
      const current = snapshotRef.current;
      if (!current) {
        pendingRef.current = request;
        return;
      }
      pendingRef.current = null;
      performMainWindowTarget(current, request, actionsRef.current);
    });
  }, []);

  useEffect(() => {
    const request = pendingRef.current;
    if (!request || !snapshot) return;
    pendingRef.current = null;
    performMainWindowTarget(snapshot, request, actionsRef.current);
  }, [snapshot]);
}

export function MainWindowTargets(props: {
  snapshot: AppSnapshot | null;
  actions: Omit<MainWindowTargetActions, "openUsageLimits">;
}): null {
  const usageLimits = useUsageLimitsContext();
  useMainWindowTargets(props.snapshot, {
    ...props.actions,
    openUsageLimits: () => {
      if (usageLimits) usageLimits.open();
      else props.actions.reportUnavailable("Provider limits are unavailable.");
    },
  });
  return null;
}
