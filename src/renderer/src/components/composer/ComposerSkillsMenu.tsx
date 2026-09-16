import { useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";

import type {
  AgentSkillSummary,
  AgentWorkflowSkillsCapability,
} from "@shared/contracts";
import type { ComposerMenuController } from "./useComposerMenus";
import "./ComposerSkillsMenu.css";

export interface ComposerSkillsMenuProps {
  skills: readonly AgentSkillSummary[];
  capability: AgentWorkflowSkillsCapability | null;
  loading: boolean;
  error: string | null;
  completion?: string | null;
  listboxId: string;
  activeSkillId?: string | null;
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
  completion = null,
  listboxId,
  activeSkillId = null,
  disabled,
  running,
  menuController,
  onList,
  onInsert,
}: ComposerSkillsMenuProps): React.JSX.Element | null {
  const activeOption = useRef<HTMLButtonElement>(null);
  const openedQuery = useRef<string | null>(null);
  const discoveryRequested = useRef(false);
  const { menu, toggleMenu, dismissMenu, setMenuPopover } = menuController;
  const available = Boolean(capability?.available) && !disabled && !running;
  const showCompletion = completion !== null && available;
  const visibleSkills = skills.filter((skill) => skill.enabled
    && skill.name.toLowerCase().startsWith(completion ?? ""));

  useEffect(() => {
    if (!showCompletion) {
      openedQuery.current = null;
      discoveryRequested.current = false;
      if (menu === "skills") dismissMenu("context-change");
      return;
    }
    // Escape/outside dismissal holds for the current query. Editing it opens
    // suggestions again, without taking focus away from the composer.
    if (openedQuery.current !== completion) {
      openedQuery.current = completion;
      if (menu !== "skills") toggleMenu("skills");
    }
    if (!discoveryRequested.current && !loading && skills.length === 0 && !error) {
      discoveryRequested.current = true;
      void onList(false).catch(() => undefined);
    }
  }, [completion, dismissMenu, error, loading, menu, onList, showCompletion, skills.length, toggleMenu]);

  useEffect(() => {
    activeOption.current?.scrollIntoView({ block: "nearest" });
  }, [activeSkillId, menu]);

  if (!showCompletion || menu !== "skills") return null;
  return (
    <div className="popover-anchor composer-skills-control">
      <div
        ref={(node) => setMenuPopover("skills", node)}
        className="composer-popover composer-skills-popover"
      >
        <header>
          <span>
            <strong>Skills</strong>
            <small>Choose with ↑ ↓, insert with Tab or Enter.</small>
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh skills"
            disabled={loading}
            onClick={() => void onList(true).catch(() => undefined)}
          >
            <RefreshCw size={14} className={loading ? "is-spinning" : undefined} aria-hidden="true" />
          </button>
        </header>
        {error && <p className="composer-skills-error" role="alert">{error}</p>}
        {loading && <p className="composer-skills-empty" role="status">Discovering skills…</p>}
        {!error && !loading && visibleSkills.length === 0 && (
          <p className="composer-skills-empty" role="status">
            {skills.some((skill) => skill.enabled)
              ? "No skills match. Edit the name or press Escape to keep typing."
              : "No enabled skills were reported for this project."}
          </p>
        )}
        <div id={listboxId} className="composer-skills-list" role="listbox" aria-label="Skill suggestions">
          {visibleSkills.map((skill) => (
            <button
              ref={skill.id === activeSkillId ? activeOption : undefined}
              id={`${listboxId}-${skill.id}`}
              type="button"
              role="option"
              aria-selected={skill.id === activeSkillId}
              tabIndex={0}
              key={skill.id}
              onClick={() => {
                onInsert(skill);
                dismissMenu("context-change");
              }}
              title={`Insert $${skill.name}`}
            >
              <code translate="no">{`$${skill.name}`}</code>
              <span><small>{skill.shortDescription ?? skill.description}</small></span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
