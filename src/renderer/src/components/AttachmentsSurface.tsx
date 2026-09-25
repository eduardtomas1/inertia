import { useId } from "react";
import { ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT, type EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { SentMessageAttachmentList } from "./SentMessageAttachmentList";
import "./WorkspaceSurfaces.css";

export interface AttachmentsSurfaceProps {
  attachments: EnvironmentSummarySnapshot["attachments"];
}

export function AttachmentsSurface({ attachments }: AttachmentsSurfaceProps): React.JSX.Element {
  const headingId = useId();
  return (
    <section className="workspace-surface attachments-surface" aria-label="Attachments">
      <div className="workspace-surface-scroll">
        {attachments.length === 0 ? (
          <p className="workspace-surface-empty">Attachments you send in this chat appear here.</p>
        ) : (
          <section className="workspace-surface-section attachments-surface-gallery environment-attachments"
            data-expanded="true" aria-labelledby={headingId}>
            <div className="environment-attachments-header">
              <h3 id={headingId}>{attachments.length === ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT
                ? `Newest ${ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT} attachments`
                : `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`}</h3>
            </div>
            <div className="environment-attachments-gallery">
              <SentMessageAttachmentList attachments={attachments} deferImages label="Chat attachments" />
            </div>
          </section>
        )}
      </div>
    </section>
  );
}
