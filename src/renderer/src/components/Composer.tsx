import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Command, MessageSquarePlus, Paperclip, Send, ShieldCheck, SlidersHorizontal, Sparkles, Square, Wrench, X } from "lucide-react";
import clsx from "clsx";
import type { AccessMode, ChatAttachment, Conversation, InteractionMode, ProjectAction, ProviderId, ProviderInfo, ThreadUsageSnapshot, UsageDisplayMode, WorkspaceEntry } from "@shared/contracts";
import { MAX_CHAT_MESSAGE_CHARS } from "@shared/diff-review";
import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import { chooseHorizontalSubmenuSide, type HorizontalSubmenuSide } from "../utils/dismissibleMenu";
import { ProviderActionIcon, ProviderStatus, providerSetupAction, providerStateDetail, providerStateLabel } from "./ProviderStatus";
import { IconButton, LoadingMark } from "./ui";
import { UsageIndicator } from "./UsageIndicator";

type ComposerProps = {
  conversation: Conversation;
  providers: ProviderInfo[];
  actions: ProjectAction[];
  disabled: boolean;
  sending: boolean;
  running: boolean;
  mentionResults: WorkspaceEntry[];
  usage: ThreadUsageSnapshot | null;
  usageDisplayMode: UsageDisplayMode;
  promptContext?: string | null;
  onSend: (message: string, attachments: ChatAttachment[]) => Promise<void>;
  onUpdateConversation: (update: Partial<Pick<Conversation, "providerId" | "model" | "reasoningEffort" | "interactionMode" | "accessMode">>) => void;
  onChooseAttachments: () => Promise<ChatAttachment[]>;
  onImportAttachments: (files: File[]) => Promise<ChatAttachment[]>;
  onRunAction: (action: ProjectAction) => void;
  onMentionQuery: (query: string) => void;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId: ProviderId) => void;
  onUsageDisplayModeChange: (mode: UsageDisplayMode) => void;
  onStop: () => void;
  onClearPromptContext?: () => void;
};

const accessOptions: Array<{ value: AccessMode; label: string; description: string }> = [
  { value: "supervised", label: "Supervised", description: "Ask before commands and edits" },
  { value: "auto-edit", label: "Auto-accept edits", description: "Allow edits; ask for other actions" },
  { value: "full", label: "Full access", description: "Run commands and edit without prompts" },
];

type ComposerMenu = "provider" | "reasoning" | "mode" | "access" | "action" | "more";
type MoreSection = "actions" | "provider" | "model" | "reasoning" | "mode" | "access";

function menuId(menu: ComposerMenu): string {
  return `composer-${menu}-menu`;
}

function diffContextDetail(context: string): string {
  const target = /^Target file:\s*(.+)$/mu.exec(context)?.[1]?.trim();
  return target ? `in ${target}` : context.split("\n")[0] ?? "";
}

export function Composer({
  conversation,
  providers,
  actions,
  disabled,
  sending,
  running,
  mentionResults,
  usage,
  usageDisplayMode,
  promptContext,
  onSend,
  onUpdateConversation,
  onChooseAttachments,
  onImportAttachments,
  onRunAction,
  onMentionQuery,
  onConnectProvider,
  onRefreshProvider,
  onUsageDisplayModeChange,
  onStop,
  onClearPromptContext,
}: ComposerProps): React.JSX.Element {
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [moreSection, setMoreSection] = useState<MoreSection | null>(null);
  const [moreSubmenuSide, setMoreSubmenuSide] = useState<HorizontalSubmenuSide | null>(null);
  const [morePopoverMaxHeight, setMorePopoverMaxHeight] = useState<number | null>(null);
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } = useDismissibleMenu<ComposerMenu>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const morePopoverRef = useRef<HTMLDivElement>(null);
  const moreSectionTriggerRefs = useRef(new Map<MoreSection, HTMLButtonElement>());
  const moreHoverTimerRef = useRef<number | null>(null);
  const mentionMatch = /(?:^|\s)@([^\s@]{1,200})$/u.exec(message);
  const slashMatch = /^\/(\w*)$/u.exec(message.trim());

  useEffect(() => {
    setMessage(window.localStorage.getItem(`inertia:draft:${conversation.id}`) ?? "");
    setAttachments([]);
    dismissMenu("context-change");
  }, [conversation.id, dismissMenu]);

  useEffect(() => {
    if (running) dismissMenu("context-change");
  }, [dismissMenu, running]);

  useEffect(() => {
    if (menu === "more") return;
    if (moreHoverTimerRef.current !== null) window.clearTimeout(moreHoverTimerRef.current);
    moreHoverTimerRef.current = null;
    setMoreSection(null);
    setMoreSubmenuSide(null);
  }, [menu]);

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
  }, []);

  useEffect(() => {
    const key = `inertia:draft:${conversation.id}`;
    if (message) window.localStorage.setItem(key, message);
    else window.localStorage.removeItem(key);
  }, [conversation.id, message]);

  useEffect(() => {
    if (mentionMatch?.[1]) onMentionQuery(mentionMatch[1]);
  }, [mentionMatch?.[1], onMentionQuery]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 176)}px`;
  }, [message]);

  const submit = async () => {
    const typedContent = message.trim() || (attachments.length > 0 ? "Please inspect the attached image." : "Please review the selected diff context.");
    const content = promptContext ? `${typedContent}\n\nSelected diff context:\n${promptContext}` : typedContent;
    if (!canSend) return;
    try {
      await onSend(content, attachments);
      setMessage("");
      setAttachments([]);
      onClearPromptContext?.();
      textareaRef.current?.focus();
    } catch {
      // The workspace-level toast presents the failure.
    }
  };

  const chooseAttachments = async () => {
    const selected = await onChooseAttachments();
    setAttachments((current) => [...current, ...selected.filter((item) => !current.some(({ path }) => path === item.path))].slice(0, 8));
  };

  const importAttachments = async (files: File[]) => {
    const images = files.filter(({ type }) => ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)).slice(0, 8 - attachments.length);
    if (images.length === 0) return;
    const selected = await onImportAttachments(images);
    setAttachments((current) => [...current, ...selected.filter((item) => !current.some(({ path }) => path === item.path))].slice(0, 8));
  };

  const selectedProvider = providers.find((provider) => provider.id === conversation.providerId);
  const selectedModel = selectedProvider?.models.find(({ id }) => id === conversation.model)
    ?? selectedProvider?.models.find(({ isDefault }) => isDefault)
    ?? selectedProvider?.models[0];
  const selectedReasoning = conversation.reasoningEffort || selectedModel?.defaultReasoningEffort || "";
  const selectedProviderReady = selectedProvider?.canRun === true;
  const selectedProviderAction = selectedProvider ? providerSetupAction(selectedProvider) : "refresh";
  const contextSuffix = promptContext ? `\n\nSelected diff context:\n${promptContext}` : "";
  const composedLength = (message.trim() || (attachments.length > 0 ? "Please inspect the attached image." : "Please review the selected diff context.")).length + contextSuffix.length;
  const typedMessageLimit = Math.max(0, MAX_CHAT_MESSAGE_CHARS - contextSuffix.length);
  const messageFits = composedLength <= MAX_CHAT_MESSAGE_CHARS;
  const canSend = (Boolean(message.trim()) || attachments.length > 0 || Boolean(promptContext)) && messageFits && selectedProviderReady && !disabled && !sending && !running;
  const access = accessOptions.find((item) => item.value === conversation.accessMode) ?? accessOptions[2];
  const reasoningLabel = selectedModel?.reasoningOptions.find(({ value }) => value === selectedReasoning)?.label ?? "Provider default";

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

  const moreSectionLabel = (section: MoreSection): string => ({
    actions: "Actions",
    provider: "Provider",
    model: "Model",
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
    if (section === "provider") {
      return providers.map((provider) => (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={conversation.providerId === provider.id}
          key={provider.id}
          onClick={() => {
            onUpdateConversation({ providerId: provider.id as ProviderId, model: "", reasoningEffort: "" });
            dismissMenu("selection");
          }}
        >
          <span><strong>{provider.label}</strong><small>{providerStateLabel(provider)} · {providerStateDetail(provider)}</small></span>
          {conversation.providerId === provider.id && <span className="option-check" />}
        </button>
      ));
    }
    if (section === "model") {
      if (!selectedProvider?.models.length) return <p className="popover-empty">This provider uses its default model.</p>;
      return selectedProvider.models.map((model) => (
        <button
          type="button"
          role="menuitemradio"
          aria-checked={selectedModel?.id === model.id}
          key={model.id}
          onClick={() => {
            onUpdateConversation({ model: model.id, reasoningEffort: model.defaultReasoningEffort });
            dismissMenu("selection");
          }}
        >
          <span><strong>{model.label}{model.isDefault ? " · Default" : ""}</strong><small>{model.description}</small></span>
          {selectedModel?.id === model.id && <span className="option-check" />}
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
            onUpdateConversation({ reasoningEffort: option.value });
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
    { section: "provider", label: "Provider", value: selectedProvider?.label ?? conversation.providerId },
    { section: "model", label: "Model", value: selectedModel?.label ?? "Provider default", disabled: !selectedProvider?.models.length },
    { section: "reasoning", label: "Reasoning", value: reasoningLabel, disabled: !selectedModel?.reasoningOptions.length },
    { section: "mode", label: "Mode", value: conversation.interactionMode === "build" ? "Build" : "Plan" },
    { section: "access", label: "Access", value: access.label },
  ];

  return (
    <div className="composer-shell">
      {selectedProvider && !selectedProviderReady && (
        <div className="provider-readiness" role="status">
          <ProviderStatus provider={selectedProvider} />
          <span className="provider-readiness-copy">
            <strong>{selectedProvider.label} needs attention</strong>
            <small>{providerStateDetail(selectedProvider)}</small>
          </span>
          {selectedProviderAction && (
            <button
              type="button"
              className="secondary-button provider-readiness-action"
              aria-label={`${selectedProviderAction === "connect" ? selectedProvider.id === "opencode" ? "Configure" : "Connect" : "Refresh"} ${selectedProvider.label}`}
              disabled={disabled}
              onClick={() => selectedProviderAction === "connect" ? onConnectProvider(selectedProvider.id) : onRefreshProvider(selectedProvider.id)}
            >
              <ProviderActionIcon action={selectedProviderAction} />
              {selectedProviderAction === "connect" ? selectedProvider.id === "opencode" ? "Configure" : "Connect" : "Refresh"}
            </button>
          )}
        </div>
      )}
      <div className={clsx("composer", menu && "has-open-menu")} data-disabled={disabled} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void importAttachments([...event.dataTransfer.files]); }}>
        {promptContext && (
          <div className="composer-context" aria-label="Selected diff context">
            <MessageSquarePlus size={13} />
            <span><strong>Diff selection </strong><small>{diffContextDetail(promptContext)}</small></span>
            <button type="button" aria-label="Remove selected diff context" onClick={onClearPromptContext}><X size={12} /></button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments" aria-label="Attached images">
            {attachments.map((attachment) => (
              <span className="attachment-chip" key={attachment.id}>
                <Paperclip size={12} />
                <span>{attachment.name}</span>
                <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((items) => items.filter(({ id }) => id !== attachment.id))}>
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onPaste={(event) => { if (event.clipboardData.files.length > 0) { event.preventDefault(); void importAttachments([...event.clipboardData.files]); } }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
          }}
          rows={1}
          maxLength={typedMessageLimit}
          disabled={disabled || running}
          aria-label="Message"
          placeholder={running ? "The agent is working…" : "Ask Inertia to work with this project…"}
        />
        {!messageFits && <p className="composer-limit-warning" role="alert">This message and diff context exceed the {MAX_CHAT_MESSAGE_CHARS.toLocaleString()} character limit. Shorten the message or selected context.</p>}

        {mentionMatch && mentionResults.length > 0 && (
          <div className="composer-suggestion-menu" role="listbox" aria-label="Project files">
            <div className="popover-title">Reference a file</div>
            {mentionResults.slice(0, 8).map((entry) => <button type="button" role="option" aria-selected="false" key={entry.path} onClick={() => setMessage((current) => current.replace(/@[^\s@]*$/u, `@${entry.path}${entry.kind === "directory" ? "/" : " "}`))}><span>{entry.path}</span><small>{entry.kind}</small></button>)}
          </div>
        )}
        {slashMatch && (
          <div className="composer-suggestion-menu" role="listbox" aria-label="Composer commands">
            {[{ id: "plan", label: "Plan mode", mode: "plan" as const }, { id: "build", label: "Build mode", mode: "build" as const }].filter(({ id }) => id.startsWith(slashMatch[1].toLowerCase())).map((item) => <button type="button" role="option" aria-selected="false" disabled={disabled || running} key={item.id} onClick={() => { onUpdateConversation({ interactionMode: item.mode }); setMessage(""); }}><span>/{item.id}</span><small>{item.label}</small></button>)}
          </div>
        )}

        <div className="composer-toolbar">
          <div className="composer-tools">
            <IconButton label="Attach images" onClick={() => void chooseAttachments()} disabled={disabled || running || attachments.length >= 8}>
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
            <div className="popover-anchor composer-provider-control">
              <button ref={(node) => setMenuTrigger("provider", node)} type="button" className={clsx("composer-pill", menu === "provider" && "is-active")} aria-label="Choose provider and model" aria-haspopup="menu" aria-controls={menuId("provider")} aria-expanded={menu === "provider"} disabled={disabled || running} onClick={() => toggleMenu("provider")}>
                <Sparkles size={14} /><span>{selectedModel?.label ?? selectedProvider?.label ?? conversation.providerId}</span><ChevronDown size={12} />
              </button>
              {menu === "provider" && (
                <div ref={(node) => setMenuPopover("provider", node)} id={menuId("provider")} className="composer-popover provider-popover" role="menu" aria-label="Provider and model">
                  <div className="popover-title">Provider</div>
                  {providers.map((provider) => (
                    <button type="button" role="menuitemradio" aria-checked={conversation.providerId === provider.id} key={provider.id} onClick={() => { onUpdateConversation({ providerId: provider.id as ProviderId, model: "", reasoningEffort: "" }); }}>
                      <span><strong>{provider.label}</strong><small>{providerStateLabel(provider)} · {providerStateDetail(provider)}</small></span>
                      {conversation.providerId === provider.id && <span className="option-check" />}
                    </button>
                  ))}
                  <div className="popover-title model-popover-title">Model</div>
                  {selectedProvider?.models.length ? selectedProvider.models.map((model) => (
                    <button type="button" role="menuitemradio" aria-checked={selectedModel?.id === model.id} key={model.id} onClick={() => { onUpdateConversation({ model: model.id, reasoningEffort: model.defaultReasoningEffort }); dismissMenu("selection"); }}>
                      <span><strong>{model.label}{model.isDefault ? " · Default" : ""}</strong><small>{model.description}</small></span>
                      {selectedModel?.id === model.id && <span className="option-check" />}
                    </button>
                  )) : <p className="popover-empty">Model choices are not exposed by this provider yet. Its default will be used.</p>}
                </div>
              )}
            </div>

            {selectedModel && selectedModel.reasoningOptions.length > 0 && (
              <div className="popover-anchor composer-reasoning-control">
                <button ref={(node) => setMenuTrigger("reasoning", node)} type="button" className={clsx("composer-pill reasoning-pill", menu === "reasoning" && "is-active")} aria-label="Choose reasoning level" aria-haspopup="menu" aria-controls={menuId("reasoning")} aria-expanded={menu === "reasoning"} disabled={disabled || running} onClick={() => toggleMenu("reasoning")}>
                  <span>{selectedModel.reasoningOptions.find(({ value }) => value === selectedReasoning)?.label ?? "Reasoning"}</span><ChevronDown size={12} />
                </button>
                {menu === "reasoning" && (
                  <div ref={(node) => setMenuPopover("reasoning", node)} id={menuId("reasoning")} className="composer-popover option-popover reasoning-popover" role="menu" aria-label="Reasoning level">
                    <div className="popover-title">Reasoning</div>
                    {selectedModel.reasoningOptions.map((option) => (
                      <button type="button" role="menuitemradio" aria-checked={selectedReasoning === option.value} key={option.value} onClick={() => { onUpdateConversation({ reasoningEffort: option.value }); dismissMenu("selection"); }}>
                        <span><strong>{option.label}{option.value === selectedModel.defaultReasoningEffort ? " · Default" : ""}</strong><small>{option.description}</small></span>
                        {selectedReasoning === option.value && <span className="option-check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="popover-anchor composer-mode-control">
              <button ref={(node) => setMenuTrigger("mode", node)} type="button" className={clsx("composer-pill", menu === "mode" && "is-active")} aria-label="Choose work mode" aria-haspopup="menu" aria-controls={menuId("mode")} aria-expanded={menu === "mode"} disabled={disabled || running} onClick={() => toggleMenu("mode")}>
                <span>{conversation.interactionMode === "build" ? "Build" : "Plan"}</span><ChevronDown size={12} />
              </button>
              {menu === "mode" && (
                <div ref={(node) => setMenuPopover("mode", node)} id={menuId("mode")} className="composer-popover option-popover" role="menu" aria-label="Work mode">
                  {(["build", "plan"] as InteractionMode[]).map((mode) => (
                    <button type="button" role="menuitemradio" aria-checked={conversation.interactionMode === mode} key={mode} onClick={() => { onUpdateConversation({ interactionMode: mode }); dismissMenu("selection"); }}>
                      <span><strong>{mode === "build" ? "Build" : "Plan"}</strong><small>{mode === "build" ? "Work directly in the project" : "Inspect and propose steps first"}</small></span>
                      {conversation.interactionMode === mode && <span className="option-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="popover-anchor access-control composer-access-control">
              <button ref={(node) => setMenuTrigger("access", node)} type="button" className={clsx("composer-pill", menu === "access" && "is-active")} aria-label="Choose project access" aria-haspopup="menu" aria-controls={menuId("access")} aria-expanded={menu === "access"} disabled={disabled || running} onClick={() => toggleMenu("access")}>
                <ShieldCheck size={14} /><span>{access.label}</span><ChevronDown size={12} />
              </button>
              {menu === "access" && (
                <div ref={(node) => setMenuPopover("access", node)} id={menuId("access")} className="composer-popover access-popover" role="menu" aria-label="Project access">
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
              >
                <SlidersHorizontal size={14} /><span>More</span><ChevronDown size={12} />
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
                              onClick={() => openMoreSection(item.section)}
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

            {running ? (
              <IconButton label="Stop agent" className="send-button stop-button" onClick={onStop}><Square size={14} fill="currentColor" /></IconButton>
            ) : (
              <IconButton label="Send message" className="send-button" onClick={() => void submit()} disabled={!canSend}>
                {sending ? <LoadingMark label="Sending message" /> : <Send size={16} />}
              </IconButton>
            )}
          </div>
        </div>
      </div>
      {selectedProvider && (
        <UsageIndicator
          usage={usage}
          rateLimits={selectedProvider.rateLimits}
          rateLimitState={selectedProvider.metadataState.rateLimits}
          mode={usageDisplayMode}
          providerLabel={selectedProvider.label}
          onModeChange={onUsageDisplayModeChange}
        />
      )}
      <div className="composer-footer">
        <p className="composer-note">Use @ for project files and / for modes · review changes before committing</p>
      </div>
    </div>
  );
}
