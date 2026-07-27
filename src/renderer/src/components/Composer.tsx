import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, Brain, ChevronDown, ChevronRight, Command, Download, Hammer, KeyRound, ListChecks, MessageSquarePlus, Paperclip, PlugZap, RefreshCw, Send, ShieldCheck, SlidersHorizontal, Square, Wrench, X } from "lucide-react";
import clsx from "clsx";
import type {
  AccessMode,
  AgentTurn,
  ChatAttachment,
  Conversation,
  InteractionMode,
  ModelBackendProfileView,
  ModelSelection,
  ProjectAction,
  ProviderId,
  ProviderInfo,
  ThreadUsageSnapshot,
  TurnRequestContext,
  UsageDisplayMode,
  WorkspaceEntry,
} from "@shared/contracts";
import { MAX_CHAT_ATTACHMENTS } from "@shared/contracts";
import {
  isKimiThroughClaudeSelection,
  KIMI_CLAUDE_REASONING_OPTIONS,
  kimiCodingModelDisplayName,
  modelSelectionIdentityLabel,
} from "../../../shared/claude-backend-profiles";
import { MAX_CHAT_MESSAGE_CHARS } from "../../../shared/diff-review";
import {
  legacyProviderIdForHarness,
} from "../../../shared/model-routing";
import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import {
  composerRouteReadiness,
  type ComposerRouteRepair,
} from "../utils/composerReadiness";
import { chooseHorizontalSubmenuSide, type HorizontalSubmenuSide } from "../utils/dismissibleMenu";
import {
  buildComposerModelRoutes,
  selectedModelSearchRoute,
  type ComposerModelRoute,
} from "../utils/modelChooserRoutes";
import { resolveModelRouteTransition } from "../utils/modelRouteTransition";
import {
  buildComposerTurnRequest,
  promptContextDetail,
} from "../utils/requestContext";
import {
  documentAttachmentSendBoundary,
  mergeComposerAttachments,
} from "../utils/composerAttachments";
import {
  COMPOSER_ACTION_STALE_FALLBACK_MS,
  composerFollowUpState,
  composerPrimaryActionState,
} from "../utils/composerPrimaryAction";
import {
  contextUsageQualityForTurn,
  usageQuotaSourceForSelection,
} from "../utils/usageDisplay";
import { ComposerAttachmentList } from "./ComposerAttachmentList";
import { ModelChooser } from "./ModelChooser";
import { IconButton, LoadingMark } from "./ui";
import { UsageIndicator } from "./UsageIndicator";

type ComposerProps = {
  conversation: Conversation;
  providers: ProviderInfo[];
  actions: ProjectAction[];
  disabled: boolean;
  sending: boolean;
  running: boolean;
  backendProfiles?: ModelBackendProfileView[];
  latestTurn?: AgentTurn | null;
  mentionResults: WorkspaceEntry[];
  usage: ThreadUsageSnapshot | null;
  usageDisplayMode: UsageDisplayMode;
  promptContext?: string | null;
  onSend: (message: string, attachments: ChatAttachment[], context?: TurnRequestContext) => Promise<void>;
  onUpdateConversation: (update: Partial<Pick<Conversation, "providerId" | "modelSelection" | "model" | "reasoningEffort" | "interactionMode" | "accessMode">>) => void;
  onCreateConversationForSelection?: (selection: ModelSelection) => Promise<void>;
  onChooseAttachments: () => Promise<ChatAttachment[]>;
  onImportAttachments: (files: File[]) => Promise<ChatAttachment[]>;
  onReleaseAttachment: (id: string) => Promise<void>;
  onRunAction: (action: ProjectAction) => void;
  onMentionQuery: (query: string) => void;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId: ProviderId) => void;
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onOpenBackendSetup: (profileId: string) => void;
  onProbeBackendProfile: (profileId: string, modelId: string) => Promise<void>;
  onUsageDisplayModeChange: (mode: UsageDisplayMode) => void;
  onStop: () => Promise<void>;
  onClearPromptContext?: () => void;
};

const accessOptions: Array<{ value: AccessMode; label: string; description: string }> = [
  { value: "supervised", label: "Supervised", description: "Ask before commands and edits" },
  { value: "auto-edit", label: "Auto-accept edits", description: "Allow edits; ask for other actions" },
  { value: "full", label: "Full access", description: "Run commands and edit without prompts" },
];

type ComposerMenu = "reasoning" | "mode" | "access" | "action" | "more";
type MoreSection = "actions" | "reasoning" | "mode" | "access";

function menuId(menu: ComposerMenu): string {
  return `composer-${menu}-menu`;
}

function composerHarnessLabel(harnessId: string): string {
  return harnessId.startsWith("claude")
    ? "Claude harness"
    : harnessId.startsWith("codex")
      ? "Codex harness"
      : harnessId.startsWith("cursor")
        ? "Cursor"
        : "OpenCode";
}

function routeRepairLabel(action: ComposerRouteRepair): string {
  if (action === "add-key") return "Add key";
  return action[0].toUpperCase() + action.slice(1);
}

function RouteRepairIcon({
  action,
  pending,
}: {
  action: ComposerRouteRepair;
  pending: boolean;
}): React.JSX.Element {
  if (pending || action === "refresh") {
    return <RefreshCw size={13} className={pending ? "is-spinning" : undefined} />;
  }
  if (action === "install") return <Download size={13} />;
  if (action === "connect") return <PlugZap size={13} />;
  if (action === "add-key") return <KeyRound size={13} />;
  return <Wrench size={13} />;
}

export function Composer({
  conversation,
  providers,
  actions,
  disabled,
  sending,
  running,
  backendProfiles = [],
  latestTurn = null,
  mentionResults,
  usage,
  usageDisplayMode,
  promptContext,
  onSend,
  onUpdateConversation,
  onCreateConversationForSelection,
  onChooseAttachments,
  onImportAttachments,
  onReleaseAttachment,
  onRunAction,
  onMentionQuery,
  onConnectProvider,
  onRefreshProvider,
  onOpenProviderSetup,
  onOpenBackendSetup,
  onProbeBackendProfile,
  onUsageDisplayModeChange,
  onStop,
  onClearPromptContext,
}: ComposerProps): React.JSX.Element {
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const submissionReleaseTimerRef = useRef<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const stopReleaseTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const conversationIdRef = useRef(conversation.id);
  const releaseAttachmentRef = useRef(onReleaseAttachment);
  const [fileReferences, setFileReferences] = useState<string[]>([]);
  const [pendingRoute, setPendingRoute] = useState<{
    selection: ModelSelection;
    label: string;
    reason: string;
  } | null>(null);
  const [creatingRouteConversation, setCreatingRouteConversation] = useState(false);
  const [routeRepairing, setRouteRepairing] = useState(false);
  const [moreSection, setMoreSection] = useState<MoreSection | null>(null);
  const [moreSubmenuSide, setMoreSubmenuSide] = useState<HorizontalSubmenuSide | null>(null);
  const [morePopoverMaxHeight, setMorePopoverMaxHeight] = useState<number | null>(null);
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } = useDismissibleMenu<ComposerMenu>();
  const composerRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const routeCancelRef = useRef<HTMLButtonElement>(null);
  const morePopoverRef = useRef<HTMLDivElement>(null);
  const moreSectionTriggerRefs = useRef(new Map<MoreSection, HTMLButtonElement>());
  const moreHoverTimerRef = useRef<number | null>(null);
  const mentionMatch = /(?:^|\s)@([^\s@]{1,200})$/u.exec(message);
  const slashMatch = /^\/(\w*)$/u.exec(message.trim());

  conversationIdRef.current = conversation.id;
  releaseAttachmentRef.current = onReleaseAttachment;

  useEffect(() => {
    if (submissionReleaseTimerRef.current !== null) {
      window.clearTimeout(submissionReleaseTimerRef.current);
      submissionReleaseTimerRef.current = null;
    }
    if (stopReleaseTimerRef.current !== null) {
      window.clearTimeout(stopReleaseTimerRef.current);
      stopReleaseTimerRef.current = null;
    }
    submittingRef.current = false;
    stoppingRef.current = false;
    setSubmitting(false);
    setStopping(false);
    setMessage(window.localStorage.getItem(`inertia:draft:${conversation.id}`) ?? "");
    for (const attachment of attachmentsRef.current) {
      void onReleaseAttachment(attachment.id);
    }
    attachmentsRef.current = [];
    setAttachments([]);
    setFileReferences([]);
    setPendingRoute(null);
    setCreatingRouteConversation(false);
    setRouteRepairing(false);
    dismissMenu("context-change");
  }, [conversation.id, dismissMenu, onReleaseAttachment]);

  useEffect(() => {
    if (running) {
      dismissMenu("context-change");
      if (submissionReleaseTimerRef.current !== null) {
        window.clearTimeout(submissionReleaseTimerRef.current);
        submissionReleaseTimerRef.current = null;
      }
      submittingRef.current = false;
      setSubmitting(false);
      return;
    }
    if (stopReleaseTimerRef.current !== null) {
      window.clearTimeout(stopReleaseTimerRef.current);
      stopReleaseTimerRef.current = null;
    }
    stoppingRef.current = false;
    setStopping(false);
  }, [dismissMenu, running]);

  useEffect(() => {
    if (menu === "more") return;
    if (moreHoverTimerRef.current !== null) window.clearTimeout(moreHoverTimerRef.current);
    moreHoverTimerRef.current = null;
    setMoreSection(null);
    setMoreSubmenuSide(null);
  }, [menu]);

  useEffect(() => {
    if (!pendingRoute) return;
    window.requestAnimationFrame(() => routeCancelRef.current?.focus());
  }, [pendingRoute]);

  useLayoutEffect(() => {
    if (menu !== "more") {
      setMorePopoverMaxHeight(null);
      return;
    }
    const updateAvailableHeight = () => {
      const popover = morePopoverRef.current;
      if (!popover) return;
      const header = popover.closest(".workspace-frame")?.querySelector<HTMLElement>(".workspace-header");
      const safeTop = Math.max(8, (header?.getBoundingClientRect().bottom ?? 0) + 8);
      setMorePopoverMaxHeight(Math.max(80, Math.floor(popover.getBoundingClientRect().bottom - safeTop)));
    };
    updateAvailableHeight();
    window.addEventListener("resize", updateAvailableHeight);
    return () => window.removeEventListener("resize", updateAvailableHeight);
  }, [menu]);

  useEffect(() => () => {
    if (moreHoverTimerRef.current !== null) window.clearTimeout(moreHoverTimerRef.current);
    if (submissionReleaseTimerRef.current !== null) window.clearTimeout(submissionReleaseTimerRef.current);
    if (stopReleaseTimerRef.current !== null) window.clearTimeout(stopReleaseTimerRef.current);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const unsent = attachmentsRef.current;
      attachmentsRef.current = [];
      for (const attachment of unsent) {
        void releaseAttachmentRef.current(attachment.id);
      }
    };
  }, []);

  useEffect(() => {
    const key = `inertia:draft:${conversation.id}`;
    if (message) window.localStorage.setItem(key, message);
    else window.localStorage.removeItem(key);
  }, [conversation.id, message]);

  useEffect(() => {
    if (mentionMatch?.[1]) onMentionQuery(mentionMatch[1]);
  }, [mentionMatch?.[1], onMentionQuery]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const syncHeight = () => {
      textarea.style.height = "0px";
      const contentHeight = textarea.scrollHeight;
      textarea.style.height = `${Math.min(contentHeight, 176)}px`;
      textarea.style.overflowY = contentHeight > 176 ? "auto" : "hidden";
    };
    let observedWidth = textarea.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width ?? observedWidth;
      if (Math.abs(nextWidth - observedWidth) < 1) return;
      observedWidth = nextWidth;
      syncHeight();
    });
    syncHeight();
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [message]);

  const submit = async () => {
    const request = running
      ? {
          visibleContent: message.trim(),
          context: undefined,
        }
      : buildComposerTurnRequest(
          message,
          attachments,
          promptContext,
          fileReferences,
        );
    if (
      (!canSend && followUpState !== "ready")
      || submittingRef.current
    ) return;
    const submittedAttachments = [...attachmentsRef.current];
    const submittedConversationId = conversation.id;
    // Submitted files must remain registered while the provider reads them.
    // Removing them from the unsent ref prevents an unmount from releasing
    // their temporary copies after the server has accepted the turn.
    attachmentsRef.current = [];
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await onSend(request.visibleContent, submittedAttachments, request.context);
      if (!mountedRef.current || conversationIdRef.current !== submittedConversationId) return;
      setMessage("");
      setAttachments([]);
      setFileReferences([]);
      onClearPromptContext?.();
      textareaRef.current?.focus();
      submissionReleaseTimerRef.current = window.setTimeout(() => {
        submissionReleaseTimerRef.current = null;
        submittingRef.current = false;
        if (mountedRef.current && conversationIdRef.current === submittedConversationId) {
          setSubmitting(false);
        }
      }, COMPOSER_ACTION_STALE_FALLBACK_MS);
    } catch {
      if (mountedRef.current && conversationIdRef.current === submittedConversationId) {
        attachmentsRef.current = submittedAttachments;
      } else {
        for (const attachment of submittedAttachments) {
          void onReleaseAttachment(attachment.id);
        }
      }
      // The workspace-level toast presents the failure; the current composer
      // keeps failed attachments available for retry when it is still mounted.
      submittingRef.current = false;
      if (mountedRef.current && conversationIdRef.current === submittedConversationId) {
        setSubmitting(false);
        textareaRef.current?.focus();
      }
    }
  };

  const stop = async (): Promise<void> => {
    if (stoppingRef.current || !running) return;
    const stoppedConversationId = conversation.id;
    stoppingRef.current = true;
    setStopping(true);
    try {
      await onStop();
      stopReleaseTimerRef.current = window.setTimeout(() => {
        stopReleaseTimerRef.current = null;
        stoppingRef.current = false;
        if (mountedRef.current && conversationIdRef.current === stoppedConversationId) {
          setStopping(false);
        }
      }, COMPOSER_ACTION_STALE_FALLBACK_MS);
    } catch {
      stoppingRef.current = false;
      if (mountedRef.current && conversationIdRef.current === stoppedConversationId) {
        setStopping(false);
      }
    }
  };

  const addAttachments = (incoming: readonly ChatAttachment[]): void => {
    const merged = mergeComposerAttachments(attachmentsRef.current, incoming);
    attachmentsRef.current = merged.attachments;
    setAttachments(merged.attachments);
    for (const attachment of merged.rejected) {
      void onReleaseAttachment(attachment.id);
    }
  };

  const removeAttachment = (attachment: ChatAttachment): void => {
    const next = attachmentsRef.current.filter(({ id }) => id !== attachment.id);
    attachmentsRef.current = next;
    setAttachments(next);
    void onReleaseAttachment(attachment.id);
  };

  const chooseAttachments = async () => {
    if (submittingRef.current || disabled || sending || running) return;
    const selected = await onChooseAttachments();
    addAttachments(selected);
  };

  const importAttachments = async (files: File[]) => {
    if (submittingRef.current || disabled || sending || running) return;
    const remaining = Math.max(0, MAX_CHAT_ATTACHMENTS - attachmentsRef.current.length);
    const candidates = files.slice(0, remaining);
    if (candidates.length === 0) return;
    const selected = await onImportAttachments(candidates);
    addAttachments(selected);
  };

  const selectedProvider = providers.find((provider) => provider.id === conversation.providerId);
  const selectedBackendProfile = backendProfiles.find(
    ({ id }) => id === conversation.modelSelection.backendProfileId,
  );
  const selectedBackendModel = selectedBackendProfile?.models.find(
    ({ id }) => id === conversation.modelSelection.modelId,
  );
  const kimiSelection = isKimiThroughClaudeSelection(conversation.modelSelection);
  const selectedModel = selectedBackendModel
    ? {
        id: selectedBackendModel.id,
        label: selectedBackendModel.displayName,
        description: `${selectedBackendProfile?.displayName ?? "Backend"} model through ${selectedBackendProfile?.harnessId ?? "the selected harness"}`,
        isDefault: selectedBackendProfile?.routing.primaryModelId === selectedBackendModel.id,
        inputModalities: ["text"] as const,
        reasoningOptions: selectedBackendModel.reasoningOptions,
        defaultReasoningEffort: selectedBackendModel.reasoningOptions.find(({ value }) =>
          value === conversation.modelSelection.reasoningEffort)?.value
          ?? selectedBackendModel.reasoningOptions[0]?.value
          ?? "",
      }
    : kimiSelection
    ? {
        id: conversation.modelSelection.modelId,
        label: kimiCodingModelDisplayName(conversation.modelSelection.modelId),
        description: "Kimi coding model through the Claude harness",
        isDefault: true,
        inputModalities: ["text"] as const,
        reasoningOptions: KIMI_CLAUDE_REASONING_OPTIONS,
        defaultReasoningEffort: "high",
      }
    : selectedProvider?.models.find(({ id }) => id === conversation.model)
      ?? selectedProvider?.models.find(({ isDefault }) => isDefault)
      ?? selectedProvider?.models[0];
  const selectedReasoning = conversation.reasoningEffort || selectedModel?.defaultReasoningEffort || "";
  const routeReadiness = composerRouteReadiness({
    provider: selectedProvider,
    profile: selectedBackendProfile,
    selection: conversation.modelSelection,
  });
  const selectedIdentityLabel = selectedBackendProfile
    ? `${composerHarnessLabel(selectedBackendProfile.harnessId)} · ${selectedBackendProfile.displayName} · ${selectedBackendModel?.displayName ?? conversation.modelSelection.modelId}`
    : kimiSelection
    ? modelSelectionIdentityLabel(conversation.modelSelection)
    : selectedProvider?.label ?? conversation.providerId;
  const composedLength = (message.trim() || (attachments.length > 0 ? "Please inspect the attached file." : "Please review the selected diff context.")).length;
  const typedMessageLimit = MAX_CHAT_MESSAGE_CHARS;
  const messageFits = composedLength <= MAX_CHAT_MESSAGE_CHARS;
  const attachmentSendBoundary = documentAttachmentSendBoundary(attachments);
  const sendEligible = (Boolean(message.trim()) || attachments.length > 0 || Boolean(promptContext))
    && messageFits
    && attachmentSendBoundary === null
    && routeReadiness.ready
    && !disabled;
  const primaryAction = composerPrimaryActionState({
    sendEligible,
    submitting,
    sending,
    running,
    stopping,
  });
  const canSend = primaryAction === "send-ready";
  const followUpState = composerFollowUpState({
    running,
    harnessId: latestTurn?.harnessId ?? null,
    hasDraft: Boolean(message.trim()),
    textOnly:
      attachments.length === 0
      && !promptContext
      && fileReferences.length === 0
      && messageFits
      && !disabled,
    submitting,
    sending,
  });
  const runRouteRepair = async (): Promise<void> => {
    if (routeReadiness.ready || !routeReadiness.action || routeRepairing) return;
    const action = routeReadiness.action;
    if (action === "install") {
      onOpenProviderSetup(conversation.providerId);
      return;
    }
    if (action === "connect") {
      onConnectProvider(conversation.providerId);
      return;
    }
    if (action === "add-key") {
      if (selectedBackendProfile) onOpenBackendSetup(selectedBackendProfile.id);
      return;
    }
    if (action === "probe" && !selectedBackendProfile?.enabled) {
      if (selectedBackendProfile) onOpenBackendSetup(selectedBackendProfile.id);
      return;
    }
    setRouteRepairing(true);
    try {
      if (action === "probe" && selectedBackendProfile) {
        await onProbeBackendProfile(
          selectedBackendProfile.id,
          conversation.modelSelection.modelId,
        );
      } else {
        onRefreshProvider(conversation.providerId);
      }
    } finally {
      if (mountedRef.current) setRouteRepairing(false);
    }
  };
  const submissionPending = primaryAction === "submitting";
  const followUpPending = followUpState === "pending";
  const access = accessOptions.find((item) => item.value === conversation.accessMode) ?? accessOptions[2];
  const reasoningLabel = selectedModel?.reasoningOptions.find(({ value }) => value === selectedReasoning)?.label ?? "Provider default";
  const updateReasoningEffort = (reasoningEffort: string): void => {
    onUpdateConversation(kimiSelection
      ? {
          modelSelection: {
            ...conversation.modelSelection,
            reasoningEffort,
          },
        }
      : { reasoningEffort });
  };
  const modelRoutes = buildComposerModelRoutes(
    providers,
    backendProfiles,
    conversation.modelSelection,
  );
  const selectedModelRoute = selectedModelSearchRoute(
    modelRoutes,
    conversation.modelSelection,
  );
  const chooseModelRoute = (route: ComposerModelRoute): void => {
    const transition = resolveModelRouteTransition({
      projectId: conversation.projectId,
      selection: conversation.modelSelection,
      continuationIdentity: conversation.continuationIdentity,
      latestTurn: latestTurn
        ? {
            selection: latestTurn.modelSelection,
            continuationIdentity: latestTurn.continuationIdentity,
          }
        : null,
      hasProviderSession: Boolean(conversation.providerSessionId),
    }, route);
    if (transition.kind === "create-new-conversation") {
      setPendingRoute({
        selection: transition.selection,
        label: `${route.backendProfileName} · ${route.displayName}`,
        reason: transition.reason,
      });
      return;
    }
    const providerId = route.providerId
      ?? legacyProviderIdForHarness(route.selection.harnessId);
    onUpdateConversation({
      ...(providerId ? { providerId } : {}),
      modelSelection: transition.selection,
    });
  };
  const dismissPendingRoute = (): void => {
    setPendingRoute(null);
    window.requestAnimationFrame(() => {
      composerRef.current
        ?.querySelector<HTMLButtonElement>(".selected-model-chip")
        ?.focus();
    });
  };

  const clearMoreHoverTimer = () => {
    if (moreHoverTimerRef.current === null) return;
    window.clearTimeout(moreHoverTimerRef.current);
    moreHoverTimerRef.current = null;
  };

  const availableMoreSubmenuSide = (): HorizontalSubmenuSide | null => {
    const popover = morePopoverRef.current;
    if (!popover) return null;
    return chooseHorizontalSubmenuSide(popover.getBoundingClientRect(), window.innerWidth, 288);
  };

  const focusFirstMoreSubmenuItem = () => {
    window.requestAnimationFrame(() => {
      morePopoverRef.current?.parentElement
        ?.querySelector<HTMLButtonElement>("[data-more-submenu] button:not(:disabled)")
        ?.focus();
    });
  };

  const openMoreSection = (section: MoreSection, focusSubmenu = false) => {
    clearMoreHoverTimer();
    const side = availableMoreSubmenuSide();
    setMoreSection(section);
    setMoreSubmenuSide(side);
    if (focusSubmenu) focusFirstMoreSubmenuItem();
  };

  const previewMoreSection = (section: MoreSection) => {
    clearMoreHoverTimer();
    moreHoverTimerRef.current = window.setTimeout(() => {
      moreHoverTimerRef.current = null;
      const side = availableMoreSubmenuSide();
      if (!side) return;
      setMoreSection(section);
      setMoreSubmenuSide(side);
    }, 140);
  };

  const closeMorePreview = () => {
    clearMoreHoverTimer();
    moreHoverTimerRef.current = window.setTimeout(() => {
      moreHoverTimerRef.current = null;
      setMoreSection(null);
      setMoreSubmenuSide(null);
    }, 180);
  };

  const returnToMoreRoot = (focusTrigger = false) => {
    const previousSection = moreSection;
    clearMoreHoverTimer();
    setMoreSection(null);
    setMoreSubmenuSide(null);
    if (focusTrigger && previousSection) {
      window.requestAnimationFrame(() => moreSectionTriggerRefs.current.get(previousSection)?.focus());
    }
  };

  const handleMoreMenuNavigation = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items.at(-1)?.focus();
    else if (event.key === "ArrowDown") items[(currentIndex + 1 + items.length) % items.length]?.focus();
    else items[(currentIndex - 1 + items.length) % items.length]?.focus();
  };

  const focusComposerMenuEdge = (
    menuName: ComposerMenu,
    edge: "first" | "last" = "first",
  ): void => {
    window.requestAnimationFrame(() => {
      const items = [...(document.getElementById(menuId(menuName))
        ?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      (edge === "first" ? items[0] : items.at(-1))?.focus();
    });
  };

  const handleComposerMenuNavigation = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      ":scope > button:not(:disabled)",
    )];
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items.at(-1)?.focus();
    else if (event.key === "ArrowDown") {
      items[(currentIndex + 1 + items.length) % items.length]?.focus();
    } else {
      items[(currentIndex - 1 + items.length) % items.length]?.focus();
    }
  };

  const handleComposerMenuTriggerKeyDown = (
    menuName: ComposerMenu,
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (menu !== menuName) toggleMenu(menuName);
    focusComposerMenuEdge(menuName, event.key === "ArrowUp" ? "last" : "first");
  };

  const moreSectionLabel = (section: MoreSection): string => ({
    actions: "Actions",
    reasoning: "Reasoning",
    mode: "Mode",
    access: "Access",
  })[section];

  const renderMoreSectionOptions = (section: MoreSection) => {
    if (section === "actions") {
      return actions.map((action) => (
        <button type="button" role="menuitem" key={action.id} onClick={() => { dismissMenu("selection"); onRunAction(action); }}>
          <Command size={14} />
          <span><strong>{action.label}</strong><small>{action.command}</small></span>
        </button>
      ));
    }
    if (section === "reasoning") {
      if (!selectedModel?.reasoningOptions.length) return <p className="popover-empty">This model does not expose reasoning choices.</p>;
      return selectedModel.reasoningOptions.map((option) => (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={selectedReasoning === option.value}
          key={option.value}
          onClick={() => {
            updateReasoningEffort(option.value);
            dismissMenu("selection");
          }}
        >
          <span><strong>{option.label}{option.value === selectedModel.defaultReasoningEffort ? " · Default" : ""}</strong><small>{option.description}</small></span>
          {selectedReasoning === option.value && <span className="option-check" />}
        </button>
      ));
    }
    if (section === "mode") {
      return (["build", "plan"] as InteractionMode[]).map((mode) => (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={conversation.interactionMode === mode}
          key={mode}
          onClick={() => {
            onUpdateConversation({ interactionMode: mode });
            dismissMenu("selection");
          }}
        >
          <span><strong>{mode === "build" ? "Build" : "Plan"}</strong><small>{mode === "build" ? "Work directly in the project" : "Inspect and propose steps first"}</small></span>
          {conversation.interactionMode === mode && <span className="option-check" />}
        </button>
      ));
    }
    return accessOptions.map((option) => (
      <button
        type="button"
        role="menuitemradio"
        aria-checked={conversation.accessMode === option.value}
        key={option.value}
        onClick={() => {
          onUpdateConversation({ accessMode: option.value });
          dismissMenu("selection");
        }}
      >
        <span><strong>{option.label}</strong><small>{option.description}</small></span>
        {conversation.accessMode === option.value && <span className="option-check" />}
      </button>
    ));
  };

  const moreRootItems: Array<{ section: MoreSection; label: string; value: string; disabled?: boolean }> = [
    ...(actions.length > 0 ? [{ section: "actions" as const, label: "Actions", value: `${actions.length} available` }] : []),
    { section: "reasoning", label: "Reasoning", value: reasoningLabel, disabled: !selectedModel?.reasoningOptions.length },
    { section: "mode", label: "Mode", value: conversation.interactionMode === "build" ? "Build" : "Plan" },
    { section: "access", label: "Access", value: access.label },
  ];
  const ModeIcon = conversation.interactionMode === "build" ? Hammer : ListChecks;

  return (
    <div className="composer-shell">
      <section
        ref={composerRef}
        className={clsx("composer", menu && "has-open-menu")}
        aria-label="Message composer"
        aria-busy={submissionPending || followUpPending || running || stopping}
        data-primary-action={primaryAction}
        data-disabled={disabled}
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void importAttachments([...event.dataTransfer.files]); }}
      >
        <div className="composer-input-zone" data-composer-zone="input">
          {!routeReadiness.ready && (
            <div
              className="provider-readiness"
              role="status"
              aria-live="polite"
              data-transient={routeReadiness.transient}
              data-route-repair={routeReadiness.action ?? "none"}
            >
              <span className={clsx(
                "route-readiness-badge",
                routeReadiness.transient ? "is-checking" : "is-attention",
              )}>
                {routeReadiness.transient && (
                  <RefreshCw size={11} className="is-spinning" aria-hidden="true" />
                )}
                {routeReadiness.badge}
              </span>
              <span className="provider-readiness-copy">
                <strong>{routeReadiness.title}</strong>
                <small title={routeReadiness.detail}>{routeReadiness.detail}</small>
              </span>
              {routeReadiness.action && (
                <button
                  type="button"
                  className="secondary-button provider-readiness-action"
                  aria-label={`${routeRepairLabel(routeReadiness.action)} — ${routeReadiness.title}`}
                  disabled={disabled || routeRepairing}
                  onClick={() => { void runRouteRepair().catch(() => undefined); }}
                >
                  <RouteRepairIcon
                    action={routeReadiness.action}
                    pending={routeRepairing}
                  />
                  {routeRepairing
                    ? routeReadiness.action === "probe" ? "Probing…" : "Refreshing…"
                    : routeRepairLabel(routeReadiness.action)}
                </button>
              )}
            </div>
          )}
          {promptContext && (
            <div className="composer-context" aria-label={promptContext.startsWith("Local review note for ") ? "Selected review note context" : "Selected diff context"}>
              <MessageSquarePlus size={13} />
              <span><strong>{promptContext.startsWith("Local review note for ") ? "Review note " : "Diff selection "}</strong><small>{promptContextDetail(promptContext)}</small></span>
              <button type="button" aria-label={promptContext.startsWith("Local review note for ") ? "Remove selected review note context" : "Remove selected diff context"} onClick={onClearPromptContext}><X size={12} /></button>
            </div>
          )}
          <ComposerAttachmentList
            attachments={attachments}
            onRemove={removeAttachment}
          />
          {attachmentSendBoundary && (
            <p className="composer-attachment-boundary" role="status">
              {attachmentSendBoundary}
            </p>
          )}
          {pendingRoute && (
            <div
              className="composer-route-confirmation"
              role="alertdialog"
              aria-modal="false"
              aria-busy={creatingRouteConversation}
              aria-labelledby="route-confirmation-title"
              aria-describedby="route-confirmation-reason"
              onKeyDown={(event) => {
                if (
                  event.key !== "Escape"
                  || creatingRouteConversation
                ) return;
                event.preventDefault();
                event.stopPropagation();
                dismissPendingRoute();
              }}
            >
              <ShieldCheck size={16} aria-hidden="true" />
              <span>
                <strong id="route-confirmation-title">Open a new chat for {pendingRoute.label}?</strong>
                <small id="route-confirmation-reason">{pendingRoute.reason}</small>
              </span>
              <button ref={routeCancelRef} type="button" className="secondary-button" disabled={creatingRouteConversation} onClick={dismissPendingRoute}>Cancel</button>
              <button type="button" className="primary-button" disabled={!onCreateConversationForSelection || creatingRouteConversation} onClick={() => {
                if (!onCreateConversationForSelection) return;
                setCreatingRouteConversation(true);
                void onCreateConversationForSelection(pendingRoute.selection).then(
                  () => setPendingRoute(null),
                  () => undefined,
                ).finally(() => setCreatingRouteConversation(false));
              }}>{creatingRouteConversation ? "Creating…" : "New chat"}</button>
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onPaste={(event) => { if (!running && event.clipboardData.files.length > 0) { event.preventDefault(); void importAttachments([...event.clipboardData.files]); } }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
            }}
            rows={1}
            maxLength={typedMessageLimit}
            disabled={disabled}
            readOnly={submissionPending || followUpPending}
            aria-label="Message"
            placeholder={
              running
                ? "Add a follow-up while the agent works…"
                : "Ask Inertia to work with this project…"
            }
          />
          {!messageFits && <p className="composer-limit-warning" role="alert">This message exceeds the {MAX_CHAT_MESSAGE_CHARS.toLocaleString()} character limit.</p>}
        </div>

        {!running && mentionMatch && mentionResults.length > 0 && (
          <div className="composer-suggestion-menu" role="listbox" aria-label="Project files">
            <div className="popover-title">Reference a file</div>
            {mentionResults.slice(0, 8).map((entry) => <button type="button" role="option" aria-selected="false" key={entry.path} onClick={() => {
              setMessage((current) => current.replace(/@[^\s@]*$/u, `@${entry.path}${entry.kind === "directory" ? "/" : " "}`));
              if (entry.kind === "file") setFileReferences((current) => [...new Set([...current, entry.path])]);
            }}><span>{entry.path}</span><small>{entry.kind}</small></button>)}
          </div>
        )}
        {!running && slashMatch && (
          <div className="composer-suggestion-menu" role="listbox" aria-label="Composer commands">
            {[{ id: "plan", label: "Plan mode", mode: "plan" as const }, { id: "build", label: "Build mode", mode: "build" as const }].filter(({ id }) => id.startsWith(slashMatch[1].toLowerCase())).map((item) => <button type="button" role="option" aria-selected="false" disabled={disabled || running} key={item.id} onClick={() => { onUpdateConversation({ interactionMode: item.mode }); setMessage(""); }}><span>/{item.id}</span><small>{item.label}</small></button>)}
          </div>
        )}

        <div className="composer-toolbar" data-composer-zone="controls">
          <div className="composer-tools">
            <IconButton label="Attach images or documents" onClick={() => void chooseAttachments()} disabled={disabled || submissionPending || running || attachments.length >= MAX_CHAT_ATTACHMENTS}>
              <Paperclip size={16} />
            </IconButton>
            {actions.length > 0 && (
              <div className="popover-anchor composer-action-control">
                <button ref={(node) => setMenuTrigger("action", node)} type="button" className={clsx("composer-pill", menu === "action" && "is-active")} aria-label="Open project actions" aria-haspopup="menu" aria-controls={menuId("action")} aria-expanded={menu === "action"} onClick={() => toggleMenu("action")}>
                  <Wrench size={14} /><span>Actions</span><ChevronDown size={12} />
                </button>
                {menu === "action" && (
                  <div ref={(node) => setMenuPopover("action", node)} id={menuId("action")} className="composer-popover action-popover" role="menu" aria-label="Project actions">
                    <div className="popover-title">Package scripts</div>
                    {actions.map((action) => (
                      <button type="button" role="menuitem" key={action.id} onClick={() => { dismissMenu("selection"); onRunAction(action); }}>
                        <Command size={15} />
                        <span><strong>{action.label}</strong><small>{action.command}</small></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="composer-options">
            <ModelChooser
              routes={modelRoutes}
              selectedRoute={selectedModelRoute}
              disabled={disabled || running}
              closeSignal={menu}
              onOpenChange={(open) => {
                if (open) dismissMenu("context-change");
              }}
              onSelect={chooseModelRoute}
            />

            <div className="composer-setting-family" role="group" aria-label="Composer settings">
              {selectedModel && selectedModel.reasoningOptions.length > 0 && (
                <div className="popover-anchor composer-setting-control composer-reasoning-control">
                  <button
                    ref={(node) => setMenuTrigger("reasoning", node)}
                    type="button"
                    className={clsx("composer-pill composer-setting-trigger", menu === "reasoning" && "is-active")}
                    aria-label={`Choose reasoning level. Current level: ${reasoningLabel}.`}
                    aria-haspopup="menu"
                    aria-controls={menuId("reasoning")}
                    aria-expanded={menu === "reasoning"}
                    disabled={disabled || running}
                    data-composer-setting="reasoning"
                    onClick={() => toggleMenu("reasoning")}
                    onKeyDown={(event) => handleComposerMenuTriggerKeyDown("reasoning", event)}
                  >
                    <Brain className="composer-setting-icon" size={13} strokeWidth={1.8} aria-hidden="true" />
                    <span className="composer-setting-value">{reasoningLabel}</span>
                    <ChevronDown className="composer-setting-chevron" size={11} aria-hidden="true" />
                  </button>
                  {menu === "reasoning" && (
                    <div
                      ref={(node) => setMenuPopover("reasoning", node)}
                      id={menuId("reasoning")}
                      className="composer-popover composer-setting-popover option-popover reasoning-popover"
                      role="menu"
                      aria-label="Reasoning level"
                      onKeyDown={handleComposerMenuNavigation}
                    >
                      <div className="popover-title">Reasoning</div>
                      {selectedModel.reasoningOptions.map((option) => (
                        <button type="button" role="menuitemradio" aria-checked={selectedReasoning === option.value} key={option.value} onClick={() => { updateReasoningEffort(option.value); dismissMenu("selection"); }}>
                          <span><strong>{option.label}{option.value === selectedModel.defaultReasoningEffort ? " · Default" : ""}</strong><small>{option.description}</small></span>
                          {selectedReasoning === option.value && <span className="option-check" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="popover-anchor composer-setting-control access-control composer-access-control">
                <button
                  ref={(node) => setMenuTrigger("access", node)}
                  type="button"
                  className={clsx("composer-pill composer-setting-trigger", menu === "access" && "is-active")}
                  aria-label={`Choose project access. Current access: ${access.label}.`}
                  aria-haspopup="menu"
                  aria-controls={menuId("access")}
                  aria-expanded={menu === "access"}
                  disabled={disabled || running}
                  data-composer-setting="access"
                  onClick={() => toggleMenu("access")}
                  onKeyDown={(event) => handleComposerMenuTriggerKeyDown("access", event)}
                >
                  <ShieldCheck className="composer-setting-icon" size={13} strokeWidth={1.8} aria-hidden="true" />
                  <span className="composer-setting-value">{access.label}</span>
                  <ChevronDown className="composer-setting-chevron" size={11} aria-hidden="true" />
                </button>
                {menu === "access" && (
                  <div
                    ref={(node) => setMenuPopover("access", node)}
                    id={menuId("access")}
                    className="composer-popover composer-setting-popover access-popover"
                    role="menu"
                    aria-label="Project access"
                    onKeyDown={handleComposerMenuNavigation}
                  >
                    <div className="popover-title">Project access</div>
                    {accessOptions.map((option) => (
                      <button type="button" role="menuitemradio" aria-checked={conversation.accessMode === option.value} key={option.value} onClick={() => { onUpdateConversation({ accessMode: option.value }); dismissMenu("selection"); }}>
                        <span><strong>{option.label}</strong><small>{option.description}</small></span>
                        {conversation.accessMode === option.value && <span className="option-check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="popover-anchor composer-setting-control composer-mode-control">
                <button
                  ref={(node) => setMenuTrigger("mode", node)}
                  type="button"
                  className={clsx("composer-pill composer-setting-trigger", menu === "mode" && "is-active")}
                  aria-label={`Choose work mode. Current mode: ${conversation.interactionMode === "build" ? "Build" : "Plan"}.`}
                  aria-haspopup="menu"
                  aria-controls={menuId("mode")}
                  aria-expanded={menu === "mode"}
                  disabled={disabled || running}
                  data-composer-setting="mode"
                  onClick={() => toggleMenu("mode")}
                  onKeyDown={(event) => handleComposerMenuTriggerKeyDown("mode", event)}
                >
                  <ModeIcon className="composer-setting-icon" size={13} strokeWidth={1.8} aria-hidden="true" />
                  <span className="composer-setting-value">{conversation.interactionMode === "build" ? "Build" : "Plan"}</span>
                  <ChevronDown className="composer-setting-chevron" size={11} aria-hidden="true" />
                </button>
                {menu === "mode" && (
                  <div
                    ref={(node) => setMenuPopover("mode", node)}
                    id={menuId("mode")}
                    className="composer-popover composer-setting-popover option-popover composer-mode-popover"
                    role="menu"
                    aria-label="Work mode"
                    onKeyDown={handleComposerMenuNavigation}
                  >
                    <div className="popover-title">Mode</div>
                    {(["build", "plan"] as InteractionMode[]).map((mode) => (
                      <button type="button" role="menuitemradio" aria-checked={conversation.interactionMode === mode} key={mode} onClick={() => { onUpdateConversation({ interactionMode: mode }); dismissMenu("selection"); }}>
                        <span><strong>{mode === "build" ? "Build" : "Plan"}</strong><small>{mode === "build" ? "Work directly in the project" : "Inspect and propose steps first"}</small></span>
                        {conversation.interactionMode === mode && <span className="option-check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="popover-anchor composer-more-control">
              <button
                ref={(node) => setMenuTrigger("more", node)}
                type="button"
                className={clsx("composer-pill", menu === "more" && "is-active")}
                aria-label="More composer options"
                aria-haspopup="menu"
                aria-controls={menuId("more")}
                aria-expanded={menu === "more"}
                disabled={disabled || running}
                onClick={() => {
                  if (menu !== "more") returnToMoreRoot();
                  toggleMenu("more");
                }}
                onKeyDown={(event) => handleComposerMenuTriggerKeyDown("more", event)}
              >
                <SlidersHorizontal size={13} strokeWidth={1.8} aria-hidden="true" /><span>More</span><ChevronDown size={11} aria-hidden="true" />
              </button>
              {menu === "more" && (
                <div
                  ref={(node) => setMenuPopover("more", node)}
                  className="composer-more-layer"
                  onPointerEnter={clearMoreHoverTimer}
                  onPointerLeave={closeMorePreview}
                >
                  <div
                    ref={morePopoverRef}
                    id={menuId("more")}
                    className="composer-popover composer-more-popover"
                    style={morePopoverMaxHeight === null ? undefined : { maxHeight: morePopoverMaxHeight }}
                    role="menu"
                    aria-label={moreSection && !moreSubmenuSide ? `${moreSectionLabel(moreSection)} options` : "More composer options"}
                    onKeyDown={handleMoreMenuNavigation}
                  >
                    {moreSection && !moreSubmenuSide ? (
                      <>
                        <div className="composer-more-drilldown-header">
                          <button type="button" className="composer-more-back" aria-label="Back to composer options" onClick={() => returnToMoreRoot(true)}>
                            <ArrowLeft size={14} />
                          </button>
                          <div>
                            <strong>{moreSectionLabel(moreSection)}</strong>
                            <small>Composer options</small>
                          </div>
                        </div>
                        <div className="composer-more-options" data-more-submenu>
                          {renderMoreSectionOptions(moreSection)}
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="popover-title">Composer options</div>
                        <div className="composer-more-root">
                          {moreRootItems.map((item) => (
                            <button
                              ref={(node) => {
                                if (node) moreSectionTriggerRefs.current.set(item.section, node);
                                else moreSectionTriggerRefs.current.delete(item.section);
                              }}
                              type="button"
                              role="menuitem"
                              aria-haspopup="menu"
                              aria-expanded={moreSection === item.section && moreSubmenuSide !== null}
                              disabled={item.disabled}
                              className={clsx(moreSection === item.section && "is-open")}
                              key={item.section}
                              onPointerEnter={() => previewMoreSection(item.section)}
                              onFocus={() => previewMoreSection(item.section)}
                              onClick={() => openMoreSection(item.section, true)}
                              onKeyDown={(event) => {
                                if (event.key !== "ArrowRight") return;
                                event.preventDefault();
                                openMoreSection(item.section, true);
                              }}
                            >
                              <span><strong>{item.label}</strong><small>{item.value}</small></span>
                              <ChevronRight size={13} />
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  {moreSection && moreSubmenuSide && (
                    <div
                      className={clsx("composer-popover composer-more-submenu", `opens-${moreSubmenuSide}`)}
                      style={morePopoverMaxHeight === null ? undefined : { maxHeight: morePopoverMaxHeight }}
                      role="menu"
                      aria-label={`${moreSectionLabel(moreSection)} options`}
                      data-more-submenu
                      onKeyDown={(event) => {
                        if (event.key === "ArrowLeft") {
                          event.preventDefault();
                          returnToMoreRoot(true);
                          return;
                        }
                        handleMoreMenuNavigation(event);
                      }}
                    >
                      <div className="popover-title">{moreSectionLabel(moreSection)}</div>
                      {renderMoreSectionOptions(moreSection)}
                    </div>
                  )}
                </div>
              )}
            </div>

            {selectedProvider && (
              <UsageIndicator
                usage={usage}
                rateLimits={selectedProvider.rateLimits}
                rateLimitState={selectedProvider.metadataState.rateLimits}
                quotaSource={usageQuotaSourceForSelection(
                  conversation.modelSelection,
                  selectedBackendProfile,
                )}
                mode={usageDisplayMode}
                providerLabel={selectedIdentityLabel}
                contextQuality={contextUsageQualityForTurn(
                  usage,
                  latestTurn?.id ?? null,
                )}
                onModeChange={onUsageDisplayModeChange}
              />
            )}

            {followUpState === "ready" || followUpState === "pending" ? (
              <button
                type="button"
                className="secondary-button composer-follow-up-button"
                aria-label={
                  followUpState === "pending"
                    ? "Sending follow-up"
                    : "Send follow-up"
                }
                aria-busy={followUpState === "pending"}
                disabled={followUpState === "pending"}
                onClick={() => void submit()}
              >
                {followUpState === "pending"
                  ? <LoadingMark label="Sending follow-up" />
                  : <Send size={13} />}
                <span>
                  {followUpState === "pending" ? "Sending…" : "Follow up"}
                </span>
              </button>
            ) : followUpState === "unavailable" ? (
              <small
                className="composer-follow-up-unavailable"
                role="status"
                title="This active agent route cannot accept parent follow-ups."
              >
                Follow-up unavailable
              </small>
            ) : null}

            {primaryAction === "stop-ready" || primaryAction === "stop-pending" ? (
              <IconButton
                label={primaryAction === "stop-pending" ? "Stopping agent" : "Stop agent"}
                className="send-button stop-button"
                data-composer-action-state={primaryAction}
                aria-busy={primaryAction === "stop-pending"}
                onClick={() => void stop()}
                disabled={primaryAction === "stop-pending"}
              >
                <Square size={13} fill="currentColor" />
              </IconButton>
            ) : primaryAction === "submitting" ? (
              <IconButton
                label="Sending message"
                className="send-button send-button-loading"
                data-composer-action-state={primaryAction}
                aria-busy="true"
                disabled
              >
                <LoadingMark label="Sending message" />
              </IconButton>
            ) : (
              <IconButton
                label="Send message"
                className="send-button"
                data-composer-action-state={primaryAction}
                onClick={() => void submit()}
                disabled={primaryAction === "send-disabled"}
              >
                <Send size={16} />
              </IconButton>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
