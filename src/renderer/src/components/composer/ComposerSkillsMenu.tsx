import {
  useId,
} from "react";
import {
  Check,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import clsx from "clsx";

import type {
  AgentSkillSummary,
  AgentWorkflowSkillsCapability,
} from "@shared/contracts";
import { MAX_SELECTED_SKILLS } from "./config";
import type { ComposerMenuController } from "./useComposerMenus";

export interface ComposerSkillsMenuProps {
  skills: readonly AgentSkillSummary[];
  capability: AgentWorkflowSkillsCapability | null;
  selectedSkillIds: readonly string[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  running: boolean;
  menuController: ComposerMenuController;
  onList: (forceReload?: boolean) => Promise<void>;
  onToggle: (skill: AgentSkillSummary) => void;
  onClear: () => void;
}

const SCOPE_LABELS = {
  repo: "Project",
  user: "Personal",
  system: "System",
  admin: "Managed",
  provider: "Provider",
} as const;

export function ComposerSkillsMenu({
  skills,
  capability,
  selectedSkillIds,
  loading,
  error,
  disabled,
  running,
  menuController,
  onList,
  onToggle,
  onClear,
}: ComposerSkillsMenuProps): React.JSX.Element | null {
  const instanceId = useId();
  const popoverId = `${instanceId}-composer-skills-menu`;
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
  } = menuController;
  const selected = new Set(selectedSkillIds);
  const selectedCount = selected.size;
  const limitReached = selectedCount >= MAX_SELECTED_SKILLS;

  if (!capability?.available) return null;

  const menuItems = (): HTMLButtonElement[] => [
    ...(document.getElementById(popoverId)
      ?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)',
      ) ?? []),
  ];
  const focusMenuEdge = (edge: "first" | "last"): void => {
    window.requestAnimationFrame(() => {
      const items = menuItems();
      (edge === "first" ? items[0] : items.at(-1))?.focus();
    });
  };
  const openFromKeyboard = (edge: "first" | "last"): void => {
    if (menu !== "skills" && skills.length === 0 && !loading) {
      void onList(false).catch(() => undefined);
    }
    if (menu !== "skills") toggleMenu("skills");
    focusMenuEdge(edge);
  };
  const handleTriggerKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    openFromKeyboard(event.key === "ArrowUp" ? "last" : "first");
  };
  const handleMenuKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = menuItems();
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items.at(-1)?.focus();
    else if (event.key === "ArrowDown") {
      items[(current + 1 + items.length) % items.length]?.focus();
    } else {
      items[(current - 1 + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className="popover-anchor composer-skills-control">
      <button
        ref={(node) => setMenuTrigger("skills", node)}
        type="button"
        className={clsx(
          "composer-pill",
          "composer-skills-trigger",
          selectedCount > 0 && "has-selection",
          menu === "skills" && "is-active",
        )}
        aria-label={selectedCount > 0
          ? `Skills, ${selectedCount} selected`
          : `Select ${capability.label}`}
        aria-haspopup="menu"
        aria-controls={popoverId}
        aria-expanded={menu === "skills"}
        disabled={disabled || running}
        onKeyDown={handleTriggerKeyDown}
        onClick={() => {
          const opening = menu !== "skills";
          if (menu !== "skills" && skills.length === 0 && !loading) {
            void onList(false).catch(() => undefined);
          }
          toggleMenu("skills");
          if (opening) focusMenuEdge("first");
        }}
      >
        <Sparkles size={14} aria-hidden="true" />
        <span>Skills{selectedCount > 0 ? ` ${selectedCount}` : ""}</span>
      </button>
      {menu === "skills" && (
        <div
          ref={(node) => setMenuPopover("skills", node)}
          id={popoverId}
          className="composer-popover composer-skills-popover"
          role="menu"
          aria-label={capability.label}
          onKeyDown={handleMenuKeyDown}
        >
          <header>
            <span>
              <strong>{capability.label}</strong>
              <small>
                {capability.kind === "codex-native"
                  ? "Selected skills are attached to the next turn only."
                  : "Selected skills are enabled for the next Claude turn only."}
              </small>
            </span>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="icon-button"
              aria-label={`Refresh ${capability.label}`}
              disabled={loading}
              onClick={() => void onList(true).catch(() => undefined)}
            >
              <RefreshCw
                size={14}
                className={loading ? "is-spinning" : undefined}
              />
            </button>
          </header>
          {error && <p className="composer-skills-error" role="alert">{error}</p>}
          {!error && loading && skills.length === 0 && (
            <p className="composer-skills-empty" role="status">
              Discovering skills…
            </p>
          )}
          {!error && !loading && skills.length === 0 && (
            <p className="composer-skills-empty">
              No enabled skills were reported for this project.
            </p>
          )}
          <div className="composer-skills-list">
            {skills.map((skill) => {
              const checked = selected.has(skill.id);
              const disabledByLimit = limitReached && !checked;
              return (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  disabled={!skill.enabled || disabledByLimit}
                  tabIndex={-1}
                  key={skill.id}
                  onClick={() => onToggle(skill)}
                  title={disabledByLimit
                    ? `Select at most ${MAX_SELECTED_SKILLS} skills for one turn.`
                    : skill.description}
                >
                  <span className="composer-skill-check" aria-hidden="true">
                    {checked && <Check size={12} />}
                  </span>
                  <span>
                    <strong>{skill.name}</strong>
                    <small>
                      {SCOPE_LABELS[skill.scope]}
                      {" · "}
                      {skill.shortDescription ?? skill.description}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
          {selectedCount > 0 && (
            <footer>
              <span role={limitReached ? "status" : undefined}>
                {limitReached
                  ? `Maximum ${MAX_SELECTED_SKILLS} skills selected`
                  : `${selectedCount} selected for the next turn`}
              </span>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  onClear();
                  dismissMenu("selection");
                }}
              >
                Clear
              </button>
            </footer>
          )}
        </div>
      )}
    </div>
  );
}
