import { X } from "lucide-react";
import clsx from "clsx";
import type { CustomAgent } from "@shared/custom-agents";
import { CustomAgentAvatar, type CustomAgentIdentity } from "../custom-agents/CustomAgentAvatar";

import "./ComposerCalledAgentChip.css";

const DELETED_AGENT: CustomAgentIdentity = { name: "Agent deleted", icon: { kind: "symbol", name: "orbit" }, accent: null };

export function ComposerCalledAgentChip({
  agent,
  onRemove,
}: {
  agent: CustomAgent | null;
  onRemove: () => void;
}): React.JSX.Element {
  const label = agent ? `Calling ${agent.name}` : "Agent deleted";
  return (
    <div
      className={clsx("composer-context composer-called-agent", !agent && "is-deleted")}
      role="group"
      aria-label={label}
    >
      <CustomAgentAvatar agent={agent ?? DELETED_AGENT} size={agent?.icon.kind === "mark" ? 28 : 20} />
      <span>
        <strong>{agent ? agent.name : "Agent deleted"}</strong>
        <small>{agent ? "Calling as a subagent" : "Remove it to send"}</small>
      </span>
      <button type="button" aria-label={agent ? `Stop calling ${agent.name}` : "Remove deleted agent"} onClick={onRemove}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
