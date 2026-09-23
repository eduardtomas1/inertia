import { useEffect, useId, useState } from "react";
import { ChevronDown, Laptop } from "lucide-react";

import {
  ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT,
  ENVIRONMENT_ATTACHMENT_PREVIEW_COUNT,
  type EnvironmentSummarySnapshot,
} from "../utils/environmentSummary";
import { layoutStorage } from "../utils/layoutStorage";
import { SubagentsSection, type GoalPanelProps } from "./GoalPanel";
import { SentMessageAttachmentList } from "./SentMessageAttachmentList";
import "./WorkspaceSurfaces.css";

export const ENVIRONMENT_ATTACHMENTS_EXPANDED_STORAGE_KEY = "inertia:environment:attachments-expanded:v1";

export type AgentsSurfaceProps = Pick<
  GoalPanelProps,
  | "subagents"
  | "turns"
  | "canFollowUpSubagent"
  | "onFollowUpSubagent"
  | "onOpenSubagent"
  | "canStopSubagent"
  | "onStopSubagent"
> & {
  runtimeStatus: EnvironmentSummarySnapshot["runtime"]["status"];
  attachments: EnvironmentSummarySnapshot["attachments"];
};

export function AgentsSurface({
  runtimeStatus,
  attachments,
  subagents,
  turns,
  canFollowUpSubagent,
  onFollowUpSubagent,
  onOpenSubagent,
  canStopSubagent,
  onStopSubagent,
}: AgentsSurfaceProps): React.JSX.Element {
  const surfaceId = useId();
  const [attachmentsOpen, setAttachmentsOpen] = useState(() => layoutStorage.getItem(ENVIRONMENT_ATTACHMENTS_EXPANDED_STORAGE_KEY) === "true");
  useEffect(() => {
    const syncAttachmentsOpen = (event: StorageEvent): void => {
      if (event.key === ENVIRONMENT_ATTACHMENTS_EXPANDED_STORAGE_KEY) setAttachmentsOpen(event.newValue === "true");
    };
    window.addEventListener("storage", syncAttachmentsOpen);
    return () => window.removeEventListener("storage", syncAttachmentsOpen);
  }, []);
  const attachmentsHeadingId = `${surfaceId}-attachments`;
  const attachmentsGalleryId = `${attachmentsHeadingId}-gallery`;
  const attachmentCount = attachments.length;
  const attachmentsExpandable = attachmentCount > ENVIRONMENT_ATTACHMENT_PREVIEW_COUNT;
  const attachmentsExpanded = attachmentsExpandable && attachmentsOpen;
  const visibleAttachments = attachmentsExpanded
    ? attachments
    : attachments.slice(0, ENVIRONMENT_ATTACHMENT_PREVIEW_COUNT);
  const attention = runtimeStatus === "online"
    ? null
    : runtimeStatus === "connecting"
      ? {
          title: "Connecting to workspace",
          detail: "Live agent details may be incomplete.",
        }
      : {
          title: "Workspace runtime unavailable",
          detail: "Live agent details may be out of date.",
        };
  return (
    <section className="workspace-surface agents-surface" aria-label="Agents">
      <div className="workspace-surface-scroll">
        {attention && (
          <div
            className={`workspace-surface-attention is-${runtimeStatus}`}
            role="status"
            aria-live="polite"
          >
            <Laptop size={14} aria-hidden="true" />
            <span><strong>{attention.title}</strong><small>{attention.detail}</small></span>
          </div>
        )}
        <SubagentsSection
          key={subagents[0]?.conversationId ?? turns[0]?.conversationId ?? "empty"}
          subagents={subagents}
          turns={turns}
          canFollowUpSubagent={canFollowUpSubagent}
          onFollowUpSubagent={onFollowUpSubagent}
          onOpenSubagent={onOpenSubagent}
          canStopSubagent={canStopSubagent}
          onStopSubagent={onStopSubagent}
          headingId={`${surfaceId}-agents`}
          listId={`${surfaceId}-agent-list`}
        />
        {attachmentCount > 0 && (
          <section
            className="workspace-surface-section agents-surface-attachments environment-attachments"
            data-expanded={attachmentsExpanded}
            aria-labelledby={attachmentsHeadingId}
          >
            <div className="environment-attachments-header">
              <h3 id={attachmentsHeadingId}>
                {attachmentsExpanded ? "Attachments" : "Recent attachments"}
              </h3>
              {attachmentsExpandable && (
                <button
                  type="button"
                  className="environment-attachments-toggle"
                  aria-expanded={attachmentsExpanded}
                  aria-controls={attachmentsGalleryId}
                  onClick={() => {
                    layoutStorage.setItem(
                      ENVIRONMENT_ATTACHMENTS_EXPANDED_STORAGE_KEY,
                      String(!attachmentsExpanded),
                    );
                    setAttachmentsOpen(!attachmentsExpanded);
                  }}
                >
                  <span>
                    {attachmentsExpanded
                      ? "Show fewer"
                      : `Show all ${attachmentCount}${attachmentCount === ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT ? "+" : ""}`}
                  </span>
                  <ChevronDown className="environment-attachments-chevron" size={13} aria-hidden="true" />
                </button>
              )}
            </div>
            <div id={attachmentsGalleryId} className="environment-attachments-gallery">
              <SentMessageAttachmentList
                attachments={visibleAttachments}
                deferImages={attachmentsExpanded}
                label={attachmentsExpanded ? "All attachments" : "Recent attachments"}
              />
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
