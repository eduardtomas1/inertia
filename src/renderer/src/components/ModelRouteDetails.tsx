import type { ModelCapability, ModelCapabilityId } from "../../../shared/model-routing";
import { harnessImageInputUnavailableReason } from "../../../shared/provider";
import type { ComposerModelRoute } from "../utils/modelChooserRoutes";
import type { SelectedModelChipRoute } from "../utils/selectedModelChip";
import "./ModelRouteDetails.css";

const labels: Record<ModelCapabilityId, string> = {
  streaming: "Streaming", tools: "Tools", images: "Images", reasoning: "Reasoning",
  "prompt-caching": "Prompt caching", "structured-output": "Structured output",
  usage: "Usage", subagents: "Subagents", compaction: "Compaction",
  "web-fetch": "Web fetch", "tool-search": "Tool search", "session-continuation": "Session continuation",
};
const states: Record<ModelCapability["state"], string> = {
  verified: "Verified", "partially-compatible": "Partial", "user-declared": "User declared",
  unavailable: "Unavailable", unknown: "Not reported",
};

export function ModelRouteDetails({ route, selection }: {
  route: ComposerModelRoute | null;
  selection: SelectedModelChipRoute;
}): React.JSX.Element {
  const identity = route ?? selection;
  const capabilities = route?.selection.capabilities ?? [];
  const imageReason = harnessImageInputUnavailableReason(identity.harnessId);
  const imageCapability = capabilities.find(({ id }) => id === "images");
  const imageStatus = imageReason ?? (imageCapability ? states[imageCapability.state]
    : route?.inputModalities ? route.inputModalities.includes("image") ? "Advertised by provider" : "Text only"
      : "Not reported");
  return <details className="model-route-details">
    <summary>Model details</summary>
    <div className="model-route-details-content">
      <strong>{identity.displayName}</strong>
      <dl>
        <dt>Selected model ID</dt><dd>{identity.modelId}</dd>
        {identity.alias && identity.alias !== identity.modelId && <><dt>Display alias</dt><dd>{identity.alias}</dd></>}
        <dt>Provider-resolved model ID</dt><dd>Not reported before the turn</dd>
        <dt>Images</dt><dd>{imageStatus}</dd>
        <dt>Selected reasoning level</dt><dd>{identity.reasoningEffort ?? "Provider default"}</dd>
        <dt>Fast response control</dt><dd>{route?.supportsNativeFastModeControl ? "Available" : "Not offered by this route"}</dd>
        {route && <><dt>Changing models</dt><dd>{route.compatibility.allowsModelSwitchWithinSession ? "Can continue the same session" : "Starts a new session"}</dd></>}
        {capabilities.filter(({ id }) => id !== "images").map((capability) => <div className="model-route-capability" key={capability.id}>
          <dt>{labels[capability.id]}</dt><dd>{states[capability.state]}{capability.detail ? ` — ${capability.detail}` : ""}</dd>
        </div>)}
      </dl>
    </div>
  </details>;
}
