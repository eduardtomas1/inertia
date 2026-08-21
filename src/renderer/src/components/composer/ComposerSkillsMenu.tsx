import { useEffect, useId, useRef, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
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
  completionQuery?: string | null;
  disabled: boolean;
  running: boolean;
  menuController: ComposerMenuController;
  onList: (forceReload?: boolean) => Promise<void>;
  onInsert: (skill: AgentSkillSummary) => void;
}

export function ComposerSkillsMenu({
  skills,
  capability,
  loading,
  error,
  completionQuery = null,
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
  const autoOpenedRef = useRef(false);
  const [query, setQuery] = useState("");
  const {
    menu,
    toggleMenu,
    dismissMenu,
    setMenuTrigger,
    setMenuPopover,
  } = menuController;

  const needle = query.trim().toLocaleLowerCase();
  const visibleSkills = completionQuery !== null
    ? skills.filter((skill) => skill.enabled && skill.name
      .toLocaleLowerCase().startsWith(completionQuery))
    : !needle
      ? skills
      : skills.filter((skill) =>
      `${skill.name} ${skill.shortDescription ?? skill.description}`
        .toLocaleLowerCase()
        .includes(needle));

  useEffect(() => {
    if (menu === "skills") return;
    setQuery("");
  }, [menu]);

  const showCompletion = completionQuery !== null
    && visibleSkills.length > 0
    && Boolean(capability?.available)
    && !disabled
    && !running;
  useEffect(() => {
    if (showCompletion && !autoOpenedRef.current && menu !== "skills") {
      autoOpenedRef.current = true;
      toggleMenu("skills");
    } else if (!showCompletion && autoOpenedRef.current) {
      autoOpenedRef.current = false;
      if (menu === "skills") dismissMenu("context-change");
    }
  }, [dismissMenu, menu, showCompletion, toggleMenu]);

  if (!capability) return null;
  const readiness = composerSkillsReadiness({
    capability,
    composerDisabled: disabled,
    running,
    loading,
  });

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
          role={completionQuery === null ? "menu" : "listbox"}
          aria-label={completionQuery === null
            ? `Insert ${capability.label}`
            : "Skill suggestions"}
        >
          <header>
            <span>
              <strong>Invoke a skill</strong>
              <small>Inserts the exact <code>$skill-name</code> token.</small>
            </span>
            {completionQuery === null && <button
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
            </button>}
          </header>
          {completionQuery === null && <label className="composer-skills-search" htmlFor={searchId}>
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
          </label>}
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
                role={completionQuery === null ? "menuitem" : "option"}
                aria-selected={completionQuery === null
                  ? undefined
                  : skill.id === visibleSkills[0]?.id}
                disabled={!skill.enabled}
                tabIndex={completionQuery === null ? 0 : -1}
                key={skill.id}
                onClick={() => {
                  onInsert(skill);
                  // Insertion hands focus back to the editor, so this action
                  // must not run the menu's normal trigger-focus restoration.
                  dismissMenu("context-change");
                }}
                title={skill.enabled ? `Insert $${skill.name}` : undefined}
              >
                <code translate="no">{`$${skill.name}`}</code>
                <span>
                  <small>{skill.shortDescription ?? skill.description}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
