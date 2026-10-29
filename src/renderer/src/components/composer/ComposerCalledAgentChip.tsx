import { X } from "lucide-react";
import type { CustomAgent } from "@shared/custom-agents";
import { CustomAgentAvatar } from "../custom-agents/CustomAgentAvatar";

import "./ComposerCalledAgentChip.css";

export function ComposerCalledAgentChip({
  agent,
  onRemove,
}: {
  agent: CustomAgent;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="composer-context composer-called-agent" aria-label={`Calling ${agent.name}`}>
      <CustomAgentAvatar agent={agent} size={18} />
      <span>
        <strong>{agent.name}</strong>
        <small>Calling as a subagent</small>
      </span>
      <button type="button" aria-label={`Stop calling ${agent.name}`} onClick={onRemove}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
