import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Command,
  SlidersHorizontal,
} from "lucide-react";
import clsx from "clsx";
import type {
  Conversation,
  InteractionMode,
  ProjectAction,
} from "@shared/contracts";
import {
  accessOptions,
  menuId,
} from "./config";
import type { ComposerSettingsModel } from "./ComposerSettings";
import type { MoreSection } from "./types";
import {
  moreSectionLabel,
  type ComposerMenuController,
} from "./useComposerMenus";

export interface ComposerMoreMenuProps {
  actions: ProjectAction[];
  selectedModel: ComposerSettingsModel | undefined;
  selectedReasoning: string;
  reasoningLabel: string;
  conversation: Conversation;
  disabled: boolean;
  running: boolean;
  menuController: ComposerMenuController;
  onRunAction: (action: ProjectAction) => void;
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

export function ComposerMoreMenu({
  actions,
  selectedModel,
  selectedReasoning,
  reasoningLabel,
  conversation,
  disabled,
  running,
  menuController,
  onRunAction,
  onUpdateReasoningEffort,
  onUpdateConversation,
  conversationUpdatePending,
  conversationUpdateError,
}: ComposerMoreMenuProps): React.JSX.Element {
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
    moreSection,
    moreSubmenuSide,
    morePopoverMaxHeight,
    morePopoverRef,
    moreSectionTriggerRefs,
    clearMoreHoverTimer,
    openMoreSection,
    previewMoreSection,
    closeMorePreview,
    returnToMoreRoot,
    handleMoreMenuNavigation,
    handleComposerMenuTriggerKeyDown,
  } = menuController;
  const access = accessOptions.find(
    (item) => item.value === conversation.accessMode,
  ) ?? accessOptions[2]!;

  const renderMoreSectionOptions = (section: MoreSection) => {
    if (section === "actions") {
      return actions.map((action) => (
        <button
          type="button"
          role="menuitem"
          key={action.id}
          onClick={() => {
            dismissMenu("selection");
            onRunAction(action);
          }}
        >
          <Command size={14} />
          <span>
            <strong>{action.label}</strong>
            <small>{action.command}</small>
          </span>
        </button>
      ));
    }
    if (section === "reasoning") {
      if (!selectedModel?.reasoningOptions.length) {
        return (
          <p className="popover-empty">
            This model does not expose reasoning choices.
          </p>
        );
      }
      return selectedModel.reasoningOptions.map((option) => (
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
      ));
    }
    if (section === "mode") {
      return (["build", "plan"] as InteractionMode[]).map((mode) => (
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
      ));
    }
    return accessOptions.map((option) => (
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
    ));
  };

  const moreRootItems: Array<{
    section: MoreSection;
    label: string;
    value: string;
    disabled?: boolean;
  }> = [
    ...(actions.length > 0
      ? [{
          section: "actions" as const,
          label: "Actions",
          value: `${actions.length} available`,
        }]
      : []),
    {
      section: "reasoning",
      label: "Reasoning",
      value: reasoningLabel,
      disabled: !selectedModel?.reasoningOptions.length,
    },
    {
      section: "mode",
      label: "Mode",
      value: conversation.interactionMode === "build" ? "Build" : "Plan",
    },
    {
      section: "access",
      label: "Access",
      value: access.label,
    },
  ];

  return (
    <div className="popover-anchor composer-more-control">
      <button
        ref={(node) => setMenuTrigger("more", node)}
        type="button"
        className={clsx(
          "composer-pill",
          menu === "more" && "is-active",
        )}
        aria-label="More composer options"
        aria-haspopup="menu"
        aria-controls={menuId("more")}
        aria-expanded={menu === "more"}
        disabled={disabled || running || conversationUpdatePending}
        onClick={() => {
          if (menu !== "more") returnToMoreRoot();
          toggleMenu("more");
        }}
        onKeyDown={(event) =>
          handleComposerMenuTriggerKeyDown("more", event)}
      >
        <SlidersHorizontal
          size={13}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <span>More</span>
        <ChevronDown size={11} aria-hidden="true" />
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
            style={morePopoverMaxHeight === null
              ? undefined
              : { maxHeight: morePopoverMaxHeight }}
            role="menu"
            aria-label={moreSection && !moreSubmenuSide
              ? `${moreSectionLabel(moreSection)} options`
              : "More composer options"}
            onKeyDown={handleMoreMenuNavigation}
          >
            {moreSection && !moreSubmenuSide ? (
              <>
                <div className="composer-more-drilldown-header">
                  <button
                    type="button"
                    className="composer-more-back"
                    aria-label="Back to composer options"
                    onClick={() => returnToMoreRoot(true)}
                  >
                    <ArrowLeft size={14} />
                  </button>
                  <div>
                    <strong>{moreSectionLabel(moreSection)}</strong>
                    <small>Composer options</small>
                  </div>
                </div>
                <div className="composer-more-options" data-more-submenu>
                  {renderMoreSectionOptions(moreSection)}
                  {moreSection === "access" && conversationUpdateError && (
                    <p className="composer-control-error" role="alert">
                      {conversationUpdateError}
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="popover-title">Composer options</div>
                <div className="composer-more-root">
                  {moreRootItems.map((item) => (
                    <button
                      ref={(node) => {
                        if (node) {
                          moreSectionTriggerRefs.current.set(
                            item.section,
                            node,
                          );
                        } else {
                          moreSectionTriggerRefs.current.delete(item.section);
                        }
                      }}
                      type="button"
                      role="menuitem"
                      aria-haspopup="menu"
                      aria-expanded={
                        moreSection === item.section
                        && moreSubmenuSide !== null
                      }
                      disabled={item.disabled}
                      className={clsx(
                        moreSection === item.section && "is-open",
                      )}
                      key={item.section}
                      onPointerEnter={() =>
                        previewMoreSection(item.section)}
                      onFocus={() => previewMoreSection(item.section)}
                      onClick={() => openMoreSection(item.section, true)}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowRight") return;
                        event.preventDefault();
                        openMoreSection(item.section, true);
                      }}
                    >
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.value}</small>
                      </span>
                      <ChevronRight size={13} />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {moreSection && moreSubmenuSide && (
            <div
              className={clsx(
                "composer-popover composer-more-submenu",
                `opens-${moreSubmenuSide}`,
              )}
              style={morePopoverMaxHeight === null
                ? undefined
                : { maxHeight: morePopoverMaxHeight }}
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
              <div className="popover-title">
                {moreSectionLabel(moreSection)}
              </div>
              {renderMoreSectionOptions(moreSection)}
              {moreSection === "access" && conversationUpdateError && (
                <p className="composer-control-error" role="alert">
                  {conversationUpdateError}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
