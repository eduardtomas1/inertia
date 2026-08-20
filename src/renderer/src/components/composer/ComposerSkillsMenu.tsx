import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RefreshCw, Search, Sparkles } from "lucide-react";
import clsx from "clsx";

import type {
  AgentSkillSummary,
  AgentWorkflowSkillsCapability,
} from "@shared/contracts";
import { COMPOSER_LABELS } from "../../lib/interfaceLabels";
import { composerSkillsReadiness } from "../../utils/composerToolReadiness";
import type { ComposerMenuController } from "./useComposerMenus";
import "./ComposerSkillsMenu.css";

export interface ComposerSkillsMenuProps {
  skills: readonly AgentSkillSummary[];
  capability: AgentWorkflowSkillsCapability | null;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  running: boolean;
  menuController: ComposerMenuController;
  onList: (forceReload?: boolean) => Promise<void>;
  onInsert: (skill: AgentSkillSummary) => void;
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
  loading,
  error,
  disabled,
  running,
  menuController,
  onList,
  onInsert,
}: ComposerSkillsMenuProps): React.JSX.Element | null {
  const instanceId = useId();
  const popoverId = `${instanceId}-composer-skills-menu`;
  const searchId = `${instanceId}-composer-skills-search`;
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
  } = menuController;

  const visibleSkills = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return skills;
    return skills.filter((skill) =>
      `${skill.name} ${skill.shortDescription ?? skill.description}`
        .toLocaleLowerCase()
        .includes(needle));
  }, [query, skills]);

  useEffect(() => {
    if (menu === "skills") return;
    setQuery("");
  }, [menu]);

  if (!capability) return null;
  const readiness = composerSkillsReadiness({
    capability,
    composerDisabled: disabled,
    running,
    loading,
  });

  const enabledItems = (): HTMLButtonElement[] => [
    ...(document.getElementById(popoverId)
      ?.querySelectorAll<HTMLButtonElement>(
        '.composer-skills-list [role="menuitem"]:not(:disabled)',
      ) ?? []),
  ];
  const open = (): void => {
    if (!readiness.interactive) return;
    if (menu !== "skills" && skills.length === 0 && !loading) {
      void onList(false).catch(() => undefined);
    }
    if (menu !== "skills") toggleMenu("skills");
    window.requestAnimationFrame(() => searchRef.current?.focus());
  };
  const toggle = (): void => {
    if (menu === "skills") {
      toggleMenu("skills");
      return;
    }
    open();
  };
  const handlePopoverKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    const items = enabledItems();
    if (event.key === "ArrowDown" && event.target === searchRef.current) {
      event.preventDefault();
      items[0]?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") items[0]?.focus();
    else if (event.key === "End") items.at(-1)?.focus();
    else if (event.key === "ArrowDown") {
      items[(current + 1 + items.length) % items.length]?.focus();
    } else if (current <= 0) {
      searchRef.current?.focus();
    } else {
      items[current - 1]?.focus();
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
          menu === "skills" && "is-active",
        )}
        aria-label={!readiness.interactive
          ? `${COMPOSER_LABELS.skills} unavailable: ${readiness.reason}`
          : `Insert a ${capability.label.toLocaleLowerCase()} invocation`}
        aria-haspopup={readiness.interactive ? "menu" : undefined}
        aria-controls={readiness.interactive ? popoverId : undefined}
        aria-expanded={readiness.interactive ? menu === "skills" : undefined}
        aria-disabled={!readiness.interactive}
        data-readiness={readiness.state}
        title={readiness.reason ?? "Insert a $skill-name invocation"}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          open();
        }}
        onClick={toggle}
      >
        <Sparkles size={14} aria-hidden="true" />
        <span>{COMPOSER_LABELS.skills}</span>
      </button>
      {readiness.interactive && menu === "skills" && (
        <div
          ref={(node) => setMenuPopover("skills", node)}
          id={popoverId}
          className="composer-popover composer-skills-popover"
          role="menu"
          aria-label={`Insert ${capability.label}`}
          onKeyDown={handlePopoverKeyDown}
        >
          <header>
            <span>
              <strong>Invoke a skill</strong>
              <small>Inserts the provider’s exact <code>$skill-name</code> token.</small>
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
                aria-hidden="true"
              />
            </button>
          </header>
          <label className="composer-skills-search" htmlFor={searchId}>
            <Search size={13} aria-hidden="true" />
            <input
              ref={searchRef}
              id={searchId}
              name="composer-skill-search"
              type="search"
              aria-label="Find a skill"
              value={query}
              autoComplete="off"
              spellCheck={false}
              placeholder="Find a skill…"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
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
          {!error && skills.length > 0 && visibleSkills.length === 0 && (
            <p className="composer-skills-empty">No skills match this search.</p>
          )}
          <div className="composer-skills-list">
            {visibleSkills.map((skill) => (
              <button
                type="button"
                role="menuitem"
                disabled={!skill.enabled}
                tabIndex={-1}
                key={skill.id}
                onClick={() => {
                  onInsert(skill);
                  // Insertion hands focus back to the editor, so this action
                  // must not run the menu's normal trigger-focus restoration.
                  dismissMenu("context-change");
                }}
                title={skill.enabled
                  ? `Insert $${skill.name}`
                  : `${skill.name} is unavailable for this project.`}
              >
                <code translate="no">{`$${skill.name}`}</code>
                <span>
                  <strong>{skill.name}</strong>
                  <small>
                    {SCOPE_LABELS[skill.scope]}
                    {" · "}
                    {skill.shortDescription ?? skill.description}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
