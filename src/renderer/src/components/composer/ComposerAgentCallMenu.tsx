import { useEffect, useRef } from "react";
import { Settings } from "lucide-react";
import type { CustomAgent } from "@shared/custom-agents";
import { CustomAgentAvatar } from "../custom-agents/CustomAgentAvatar";
import { Highlight } from "../../utils/paletteMatch";

import "./ComposerCommandMenu.css";

interface ComposerAgentCallMenuProps {
  listboxId: string;
  agents: readonly CustomAgent[];
  query: string;
  hasAgents: boolean;
  activeAgentId: string | null;
  canOpenSettings: boolean;
  onActiveAgentChange: (agentId: string) => void;
  onPick: (agent: CustomAgent) => void;
  onOpenSettings: () => void;
}

export function ComposerAgentCallMenu({
  listboxId,
  agents,
  query,
  hasAgents,
  activeAgentId,
  canOpenSettings,
  onActiveAgentChange,
  onPick,
  onOpenSettings,
}: ComposerAgentCallMenuProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeAgentId]);

  return (
    <div className="composer-command-menu composer-agent-call-menu">
      <div
        ref={listRef}
        id={listboxId}
        className="composer-command-list"
        role="listbox"
        aria-label="Custom agents"
      >
        {!hasAgents ? (
          <>
            <div className="composer-command-empty" role="status">No custom agents yet</div>
            {canOpenSettings && (
              <button
                id={`${listboxId}-settings`}
                type="button"
                role="option"
                aria-selected="true"
                data-active="true"
                tabIndex={-1}
                onMouseDown={(event) => event.preventDefault()}
                onClick={onOpenSettings}
              >
                <Settings size={14} aria-hidden="true" />
                <span className="composer-command-copy">
                  <strong>Create one in Settings</strong>
                </span>
              </button>
            )}
          </>
        ) : agents.length === 0 ? (
          <div className="composer-command-empty" role="status">No matching agent.</div>
        ) : (
          <>
            <div className="composer-agent-call-heading" aria-hidden="true">Custom agents</div>
            <div className="composer-agent-call-group" role="group" aria-label="Custom agents">
              {agents.map((agent) => {
                const active = agent.id === activeAgentId;
                return (
                  <button
                    key={agent.id}
                    id={`${listboxId}-${agent.id}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-active={active ? "true" : undefined}
                    tabIndex={-1}
                    onPointerEnter={() => onActiveAgentChange(agent.id)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onPick(agent)}
                  >
                    <CustomAgentAvatar agent={agent} size={20} />
                    <span className="composer-command-copy composer-agent-call-copy">
                      <strong><Highlight text={agent.name} query={query} /></strong>
                      {agent.description && <small>{agent.description}</small>}
                    </span>
                    <kbd className="composer-agent-call-handle">
                      /calling <Highlight text={agent.handle} query={query} />
                    </kbd>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
