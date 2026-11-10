import type { CustomAgentCallAttribution } from "@shared/custom-agents";
import { CustomAgentAvatar } from "../custom-agents/CustomAgentAvatar";
import "./MessageAgentCall.css";

export function MessageAgentCall({
  attribution,
}: {
  attribution: CustomAgentCallAttribution;
}): React.JSX.Element {
  return (
    <div className="message-agent-call" data-delivery={attribution.delivery}>
      <CustomAgentAvatar agent={attribution} size={attribution.icon.kind === "mark" ? 24 : 18} />
      <span className="message-agent-call-name">Called {attribution.name}</span>
      {attribution.delivery === "in-role" && (
        <small className="message-agent-call-delivery">in role</small>
      )}
    </div>
  );
}
