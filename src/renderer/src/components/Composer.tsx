import { useEffect, useRef, useState } from "react";
import { ChevronDown, Command, Paperclip, Send, ShieldCheck, Sparkles, Square, Wrench, X } from "lucide-react";
import clsx from "clsx";
import type { AccessMode, ChatAttachment, Conversation, InteractionMode, ProjectAction, ProviderId, ProviderInfo, ThreadUsageSnapshot, WorkspaceEntry } from "@shared/contracts";
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
  showUsage: boolean;
  onSend: (message: string, attachments: ChatAttachment[]) => Promise<void>;
  onUpdateConversation: (update: Partial<Pick<Conversation, "providerId" | "model" | "reasoningEffort" | "interactionMode" | "accessMode">>) => void;
  onChooseAttachments: () => Promise<ChatAttachment[]>;
  onImportAttachments: (files: File[]) => Promise<ChatAttachment[]>;
  onRunAction: (action: ProjectAction) => void;
  onMentionQuery: (query: string) => void;
  onConnectProvider: (providerId: ProviderId) => void;
  onRefreshProvider: (providerId: ProviderId) => void;
  onStop: () => void;
};

const accessOptions: Array<{ value: AccessMode; label: string; description: string }> = [
  { value: "supervised", label: "Supervised", description: "Ask before commands and edits" },
  { value: "auto-edit", label: "Auto-accept edits", description: "Allow edits; ask for other actions" },
  { value: "full", label: "Full access", description: "Run commands and edit without prompts" },
];

export function Composer({
  conversation,
  providers,
  actions,
  disabled,
  sending,
  running,
  mentionResults,
  usage,
  showUsage,
  onSend,
  onUpdateConversation,
  onChooseAttachments,
  onImportAttachments,
  onRunAction,
  onMentionQuery,
  onConnectProvider,
  onRefreshProvider,
  onStop,
}: ComposerProps): React.JSX.Element {
  const [message, setMessage] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [menu, setMenu] = useState<"provider" | "reasoning" | "mode" | "access" | "action" | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionMatch = /(?:^|\s)@([^\s@]{1,200})$/u.exec(message);
  const slashMatch = /^\/(\w*)$/u.exec(message.trim());

  useEffect(() => {
    setMessage(window.localStorage.getItem(`inertia:draft:${conversation.id}`) ?? "");
    setAttachments([]);
  }, [conversation.id]);

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
    const content = message.trim() || "Please inspect the attached image.";
    if (!canSend) return;
    try {
      await onSend(content, attachments);
      setMessage("");
      setAttachments([]);
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
  const canSend = (Boolean(message.trim()) || attachments.length > 0) && selectedProviderReady && !disabled && !sending && !running;
  const access = accessOptions.find((item) => item.value === conversation.accessMode) ?? accessOptions[2];

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
      <div className="composer" data-disabled={disabled} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }} onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void importAttachments([...event.dataTransfer.files]); }}>
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
          maxLength={20_000}
          disabled={disabled || running}
          aria-label="Message"
          placeholder={running ? "The agent is working…" : "Ask Inertia to work with this project…"}
        />

        {mentionMatch && mentionResults.length > 0 && (
          <div className="composer-suggestion-menu" role="listbox" aria-label="Project files">
            <div className="popover-title">Reference a file</div>
            {mentionResults.slice(0, 8).map((entry) => <button type="button" role="option" key={entry.path} onClick={() => setMessage((current) => current.replace(/@[^\s@]*$/u, `@${entry.path}${entry.kind === "directory" ? "/" : " "}`))}><span>{entry.path}</span><small>{entry.kind}</small></button>)}
          </div>
        )}
        {slashMatch && (
          <div className="composer-suggestion-menu" role="listbox" aria-label="Composer commands">
            {[{ id: "plan", label: "Plan mode", mode: "plan" as const }, { id: "build", label: "Build mode", mode: "build" as const }].filter(({ id }) => id.startsWith(slashMatch[1].toLowerCase())).map((item) => <button type="button" role="option" key={item.id} onClick={() => { onUpdateConversation({ interactionMode: item.mode }); setMessage(""); }}><span>/{item.id}</span><small>{item.label}</small></button>)}
          </div>
        )}

        <div className="composer-toolbar">
          <div className="composer-tools">
            <IconButton label="Attach images" onClick={() => void chooseAttachments()} disabled={disabled || running || attachments.length >= 8}>
              <Paperclip size={16} />
            </IconButton>
            {actions.length > 0 && (
              <div className="popover-anchor">
                <button type="button" className={clsx("composer-pill", menu === "action" && "is-active")} aria-expanded={menu === "action"} onClick={() => setMenu(menu === "action" ? null : "action")}>
                  <Wrench size={14} /><span>Actions</span><ChevronDown size={12} />
                </button>
                {menu === "action" && (
                  <div className="composer-popover action-popover" role="menu" aria-label="Project actions">
                    <div className="popover-title">Package scripts</div>
                    {actions.map((action) => (
                      <button type="button" role="menuitem" key={action.id} onClick={() => { setMenu(null); onRunAction(action); }}>
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
            <div className="popover-anchor">
              <button type="button" className={clsx("composer-pill", menu === "provider" && "is-active")} aria-expanded={menu === "provider"} onClick={() => setMenu(menu === "provider" ? null : "provider")}>
                <Sparkles size={14} /><span>{selectedModel?.label ?? selectedProvider?.label ?? conversation.providerId}</span><ChevronDown size={12} />
              </button>
              {menu === "provider" && (
                <div className="composer-popover provider-popover" role="menu" aria-label="Provider and model">
                  <div className="popover-title">Provider</div>
                  {providers.map((provider) => (
                    <button type="button" role="menuitemradio" aria-checked={conversation.providerId === provider.id} key={provider.id} onClick={() => { onUpdateConversation({ providerId: provider.id as ProviderId, model: "", reasoningEffort: "" }); }}>
                      <span><strong>{provider.label}</strong><small>{providerStateLabel(provider)} · {providerStateDetail(provider)}</small></span>
                      {conversation.providerId === provider.id && <span className="option-check" />}
                    </button>
                  ))}
                  <div className="popover-title model-popover-title">Model</div>
                  {selectedProvider?.models.length ? selectedProvider.models.map((model) => (
                    <button type="button" role="menuitemradio" aria-checked={selectedModel?.id === model.id} key={model.id} onClick={() => { onUpdateConversation({ model: model.id, reasoningEffort: model.defaultReasoningEffort }); setMenu(null); }}>
                      <span><strong>{model.label}{model.isDefault ? " · Default" : ""}</strong><small>{model.description}</small></span>
                      {selectedModel?.id === model.id && <span className="option-check" />}
                    </button>
                  )) : <p className="popover-empty">Model choices are not exposed by this provider yet. Its default will be used.</p>}
                </div>
              )}
            </div>

            {selectedModel && selectedModel.reasoningOptions.length > 0 && (
              <div className="popover-anchor">
                <button type="button" className={clsx("composer-pill reasoning-pill", menu === "reasoning" && "is-active")} aria-expanded={menu === "reasoning"} onClick={() => setMenu(menu === "reasoning" ? null : "reasoning")}>
                  <span>{selectedModel.reasoningOptions.find(({ value }) => value === selectedReasoning)?.label ?? "Reasoning"}</span><ChevronDown size={12} />
                </button>
                {menu === "reasoning" && (
                  <div className="composer-popover option-popover reasoning-popover" role="menu" aria-label="Reasoning level">
                    <div className="popover-title">Reasoning</div>
                    {selectedModel.reasoningOptions.map((option) => (
                      <button type="button" role="menuitemradio" aria-checked={selectedReasoning === option.value} key={option.value} onClick={() => { onUpdateConversation({ reasoningEffort: option.value }); setMenu(null); }}>
                        <span><strong>{option.label}{option.value === selectedModel.defaultReasoningEffort ? " · Default" : ""}</strong><small>{option.description}</small></span>
                        {selectedReasoning === option.value && <span className="option-check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="popover-anchor">
              <button type="button" className={clsx("composer-pill", menu === "mode" && "is-active")} aria-expanded={menu === "mode"} onClick={() => setMenu(menu === "mode" ? null : "mode")}>
                <span>{conversation.interactionMode === "build" ? "Build" : "Plan"}</span><ChevronDown size={12} />
              </button>
              {menu === "mode" && (
                <div className="composer-popover option-popover" role="menu" aria-label="Work mode">
                  {(["build", "plan"] as InteractionMode[]).map((mode) => (
                    <button type="button" role="menuitemradio" aria-checked={conversation.interactionMode === mode} key={mode} onClick={() => { onUpdateConversation({ interactionMode: mode }); setMenu(null); }}>
                      <span><strong>{mode === "build" ? "Build" : "Plan"}</strong><small>{mode === "build" ? "Work directly in the project" : "Inspect and propose steps first"}</small></span>
                      {conversation.interactionMode === mode && <span className="option-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="popover-anchor access-control">
              <button type="button" className={clsx("composer-pill", menu === "access" && "is-active")} aria-expanded={menu === "access"} onClick={() => setMenu(menu === "access" ? null : "access")}>
                <ShieldCheck size={14} /><span>{access.label}</span><ChevronDown size={12} />
              </button>
              {menu === "access" && (
                <div className="composer-popover access-popover" role="menu" aria-label="Project access">
                  <div className="popover-title">Project access</div>
                  {accessOptions.map((option) => (
                    <button type="button" role="menuitemradio" aria-checked={conversation.accessMode === option.value} key={option.value} onClick={() => { onUpdateConversation({ accessMode: option.value }); setMenu(null); }}>
                      <span><strong>{option.label}</strong><small>{option.description}</small></span>
                      {conversation.accessMode === option.value && <span className="option-check" />}
                    </button>
                  ))}
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
      <div className="composer-footer">
        <p className="composer-note">Use @ for project files and / for modes · review changes before committing</p>
        {showUsage && selectedProvider && (
          <UsageIndicator
            usage={usage}
            rateLimits={selectedProvider.rateLimits}
            rateLimitState={selectedProvider.metadataState.rateLimits}
            supportsUsage={selectedProvider.supportsUsage}
          />
        )}
      </div>
    </div>
  );
}
