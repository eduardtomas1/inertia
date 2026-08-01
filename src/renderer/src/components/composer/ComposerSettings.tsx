import {
  Brain,
  ChevronDown,
  Hammer,
  ListChecks,
  ShieldCheck,
} from "lucide-react";
import clsx from "clsx";
import type {
  Conversation,
  InteractionMode,
} from "@shared/contracts";
import {
  accessOptions,
  menuId,
} from "./config";
import type { ComposerMenuController } from "./useComposerMenus";

export interface ComposerSettingsModel {
  reasoningOptions: ReadonlyArray<{
    value: string;
    label: string;
    description: string;
  }>;
  defaultReasoningEffort: string;
}

export interface ComposerSettingsProps {
  selectedModel: ComposerSettingsModel | undefined;
  selectedReasoning: string;
  reasoningLabel: string;
  conversation: Conversation;
  disabled: boolean;
  running: boolean;
  menuController: ComposerMenuController;
  onUpdateReasoningEffort: (reasoningEffort: string) => void;
  onUpdateConversation: (
    update: Partial<Pick<
      Conversation,
      "interactionMode" | "accessMode"
    >>,
  ) => Promise<void>;
  conversationUpdatePending: boolean;
  conversationUpdateError: string | null;
}

export function ComposerSettings({
  selectedModel,
  selectedReasoning,
  reasoningLabel,
  conversation,
  disabled,
  running,
  menuController,
  onUpdateReasoningEffort,
  onUpdateConversation,
  conversationUpdatePending,
  conversationUpdateError,
}: ComposerSettingsProps): React.JSX.Element {
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
    handleComposerMenuNavigation,
    handleComposerMenuTriggerKeyDown,
  } = menuController;
  const access = accessOptions.find(
    (item) => item.value === conversation.accessMode,
  ) ?? accessOptions[2]!;
  const ModeIcon = conversation.interactionMode === "build"
    ? Hammer
    : ListChecks;

  return (
    <div
      className="composer-setting-family"
      role="group"
      aria-label="Composer settings"
    >
      {selectedModel && selectedModel.reasoningOptions.length > 0 && (
        <div className="popover-anchor composer-setting-control composer-reasoning-control">
          <button
            ref={(node) => setMenuTrigger("reasoning", node)}
            type="button"
            className={clsx(
              "composer-pill composer-setting-trigger",
              menu === "reasoning" && "is-active",
            )}
            aria-label={`Choose reasoning level. Current level: ${reasoningLabel}.`}
            aria-haspopup="menu"
            aria-controls={menuId("reasoning")}
            aria-expanded={menu === "reasoning"}
            disabled={disabled || running || conversationUpdatePending}
            data-composer-setting="reasoning"
            onClick={() => toggleMenu("reasoning")}
            onKeyDown={(event) =>
              handleComposerMenuTriggerKeyDown("reasoning", event)}
          >
            <Brain
              className="composer-setting-icon"
              size={13}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className="composer-setting-value">{reasoningLabel}</span>
            <ChevronDown
              className="composer-setting-chevron"
              size={11}
              aria-hidden="true"
            />
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
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selectedReasoning === option.value}
                  key={option.value}
                  onClick={() => {
                    onUpdateReasoningEffort(option.value);
                    dismissMenu("selection");
                  }}
                >
                  <span>
                    <strong>
                      {option.label}
                      {option.value === selectedModel.defaultReasoningEffort
                        ? " · Default"
                        : ""}
                    </strong>
                    <small>{option.description}</small>
                  </span>
                  {selectedReasoning === option.value && (
                    <span className="option-check" />
                  )}
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
          className={clsx(
            "composer-pill composer-setting-trigger",
            menu === "access" && "is-active",
          )}
          aria-label={`Choose project access. Current access: ${access.label}.`}
          aria-haspopup="menu"
          aria-controls={menuId("access")}
          aria-expanded={menu === "access"}
          disabled={disabled || running}
          data-composer-setting="access"
          onClick={() => toggleMenu("access")}
          onKeyDown={(event) =>
            handleComposerMenuTriggerKeyDown("access", event)}
        >
          <ShieldCheck
            className="composer-setting-icon"
            size={13}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="composer-setting-value">{access.label}</span>
          <ChevronDown
            className="composer-setting-chevron"
            size={11}
            aria-hidden="true"
          />
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
              <button
                type="button"
                role="menuitemradio"
                aria-checked={conversation.accessMode === option.value}
                key={option.value}
                disabled={conversationUpdatePending}
                onClick={() => {
                  void onUpdateConversation({ accessMode: option.value }).then(
                    () => dismissMenu("selection"),
                    () => undefined,
                  );
                }}
              >
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
                {conversation.accessMode === option.value && (
                  <span className="option-check" />
                )}
              </button>
            ))}
            {conversationUpdateError && (
              <p className="composer-control-error" role="alert">
                {conversationUpdateError}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="popover-anchor composer-setting-control composer-mode-control">
        <button
          ref={(node) => setMenuTrigger("mode", node)}
          type="button"
          className={clsx(
            "composer-pill composer-setting-trigger",
            menu === "mode" && "is-active",
          )}
          aria-label={`Choose work mode. Current mode: ${
            conversation.interactionMode === "build" ? "Build" : "Plan"
          }.`}
          aria-haspopup="menu"
          aria-controls={menuId("mode")}
          aria-expanded={menu === "mode"}
          disabled={disabled || running || conversationUpdatePending}
          data-composer-setting="mode"
          onClick={() => toggleMenu("mode")}
          onKeyDown={(event) =>
            handleComposerMenuTriggerKeyDown("mode", event)}
        >
          <ModeIcon
            className="composer-setting-icon"
            size={13}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <span className="composer-setting-value">
            {conversation.interactionMode === "build" ? "Build" : "Plan"}
          </span>
          <ChevronDown
            className="composer-setting-chevron"
            size={11}
            aria-hidden="true"
          />
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
              <button
                type="button"
                role="menuitemradio"
                aria-checked={conversation.interactionMode === mode}
                key={mode}
                disabled={conversationUpdatePending}
                onClick={() => {
                  void onUpdateConversation({ interactionMode: mode }).then(
                    () => dismissMenu("selection"),
                    () => undefined,
                  );
                }}
              >
                <span>
                  <strong>{mode === "build" ? "Build" : "Plan"}</strong>
                  <small>
                    {mode === "build"
                      ? "Work directly in the project"
                      : "Inspect and propose steps first"}
                  </small>
                </span>
                {conversation.interactionMode === mode && (
                  <span className="option-check" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
