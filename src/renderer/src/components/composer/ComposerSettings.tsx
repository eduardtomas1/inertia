import {
  ChevronDown,
  Hammer,
  ListChecks,
  ShieldCheck,
} from "lucide-react";
import clsx from "clsx";
import type { Conversation } from "@shared/contracts";
import {
  accessOptions,
  menuId,
  RESPONSE_SPEED_LABEL,
} from "./config";
import { ComposerResponseSpeedOptions } from "./ComposerResponseSpeedOptions";
import type { ComposerMenuController } from "./useComposerMenus";

export interface ComposerSettingsModel {
  reasoningOptions: ReadonlyArray<{
    value: string;
    label: string;
    description: string;
  }>;
  defaultReasoningEffort: string;
  fastMode?: {
    providerValue: string;
    label: string;
    description: string;
    isDefault: boolean;
  } | null;
}

export interface ComposerSettingsProps {
  selectedModel: ComposerSettingsModel | undefined;
  selectedReasoning: string;
  reasoningLabel: string;
  selectedFastMode: boolean;
  conversation: Conversation;
  disabled: boolean;
  running: boolean;
  menuController: ComposerMenuController;
  onUpdateReasoningEffort: (reasoningEffort: string) => Promise<void>;
  onUpdateFastMode: (enabled: boolean) => Promise<void>;
  onUpdateConversation: (
    update: Partial<Pick<
      Conversation,
      "interactionMode" | "accessMode"
    >>,
  ) => Promise<void>;
  conversationUpdatePending: boolean;
}

export function ComposerSettings({
  selectedModel,
  selectedReasoning,
  reasoningLabel,
  selectedFastMode,
  conversation,
  disabled,
  running,
  menuController,
  onUpdateReasoningEffort,
  onUpdateFastMode,
  onUpdateConversation,
  conversationUpdatePending,
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
  const fastMode = selectedModel?.fastMode ?? null;
  const showResponseSpeed = fastMode !== null || selectedFastMode;
  const responseSpeedLabel = selectedFastMode
    ? "Fast"
    : "Standard";

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
            onKeyDown={(event) => handleComposerMenuTriggerKeyDown("reasoning", event)}
          >
            <span className="composer-setting-value">{reasoningLabel}</span>
            <ChevronDown
              className="composer-setting-chevron"
              size={14}
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
              {selectedModel.reasoningOptions.map((option) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selectedReasoning === option.value}
                  key={option.value}
                  disabled={conversationUpdatePending}
                  onClick={() => {
                    void onUpdateReasoningEffort(option.value).then(
                      () => dismissMenu("selection"),
                      () => undefined,
                    );
                  }}
                >
                  <span>
                    <strong>
                      {option.label}
                      {option.value === selectedModel.defaultReasoningEffort
                        ? " · Default"
                        : ""}
                    </strong>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {showResponseSpeed && (
        <div className="popover-anchor composer-setting-control composer-speed-control">
          <button
            ref={(node) => setMenuTrigger("speed", node)}
            type="button"
            className={clsx(
              "composer-pill composer-setting-trigger",
              menu === "speed" && "is-active",
            )}
            aria-label={`Choose response speed. Current speed: ${responseSpeedLabel}.`}
            aria-haspopup="menu"
            aria-controls={menuId("speed")}
            aria-expanded={menu === "speed"}
            disabled={disabled || running || conversationUpdatePending}
            data-composer-setting="speed"
            onClick={() => toggleMenu("speed")}
            onKeyDown={(event) => handleComposerMenuTriggerKeyDown("speed", event)}
          >
            <span className="composer-setting-value">{responseSpeedLabel}</span>
            <ChevronDown
              className="composer-setting-chevron"
              size={14}
              aria-hidden="true"
            />
          </button>
          {menu === "speed" && (
            <div
              ref={(node) => setMenuPopover("speed", node)}
              id={menuId("speed")}
              className="composer-popover composer-setting-popover option-popover response-speed-popover"
              role="menu"
              aria-label={RESPONSE_SPEED_LABEL}
              onKeyDown={handleComposerMenuNavigation}
            >
              <ComposerResponseSpeedOptions
                fastMode={fastMode}
                selectedFastMode={selectedFastMode}
                pending={conversationUpdatePending}
                onUpdate={onUpdateFastMode}
                onSelected={() => dismissMenu("selection")}
              />
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
            size={16}
            aria-hidden="true"
          />
          <span className="composer-setting-value">{access.label}</span>
          <ChevronDown
            className="composer-setting-chevron"
            size={14}
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
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="composer-setting-control composer-mode-control">
        <button
          type="button"
          className="composer-pill composer-setting-trigger"
          aria-label={`Work mode: ${
            conversation.interactionMode === "build" ? "Build" : "Plan"
          }. Switch to ${
            conversation.interactionMode === "build" ? "Plan" : "Build"
          }.`}
          data-interaction-mode={conversation.interactionMode}
          aria-disabled={conversationUpdatePending || undefined}
          disabled={disabled || running}
          data-composer-setting="mode"
          onClick={() => {
            if (conversationUpdatePending) return;
            dismissMenu("context-change");
            void onUpdateConversation({
              interactionMode: conversation.interactionMode === "build" ? "plan" : "build",
            }).catch(() => undefined);
          }}
        >
          <ModeIcon
            className="composer-setting-icon"
            size={16}
            aria-hidden="true"
          />
          <span className="composer-setting-value">
            {conversation.interactionMode === "build" ? "Build" : "Plan"}
          </span>
        </button>
      </div>
    </div>
  );
}
