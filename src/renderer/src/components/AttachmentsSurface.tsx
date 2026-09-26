import { useId } from "react";
import type { AttachmentGalleryResult } from "@shared/attachment-gallery";
import type { ClientCommand, ServerEvent } from "@shared/contracts";
import { ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT, type EnvironmentSummarySnapshot } from "../utils/environmentSummary";
import { useAttachmentGallery } from "../hooks/useAttachmentGallery";
import { SentMessageAttachmentList } from "./SentMessageAttachmentList";
import "./WorkspaceSurfaces.css";

export interface AttachmentsSurfaceProps {
  attachments: EnvironmentSummarySnapshot["attachments"];
  conversationId?: string;
  runtimeGeneration?: string | null;
  requestPage?: (cursor?: string) => Promise<AttachmentGalleryResult>;
  sendCommand?: (command: ClientCommand) => Promise<ServerEvent>;
}

export function AttachmentsSurface(props: AttachmentsSurfaceProps): React.JSX.Element {
  const headingId = useId();
  const gallery = useAttachmentGallery(props);
  const attachments = gallery.attachments;
  const remote = Boolean(props.requestPage || props.sendCommand);
  return (
    <section className="workspace-surface attachments-surface" aria-label="Attachments">
      <div className="workspace-surface-scroll">
        {remote && (gallery.olderCursor || gallery.newerCursor || gallery.error) && <nav className="attachments-surface-pagination" aria-label="Attachment pages">
          <button type="button" disabled={gallery.loading} onClick={() => { void gallery.load(); }}>Newest attachments</button>
          {gallery.newerCursor && <button type="button" disabled={gallery.loading} onClick={() => { void gallery.load(gallery.newerCursor!); }}>Newer attachments</button>}
          {gallery.olderCursor && <button type="button" disabled={gallery.loading} onClick={() => { void gallery.load(gallery.olderCursor!); }}>Older attachments</button>}
        </nav>}
        {gallery.loading && <p role="status">Loading attachments…</p>}
        {gallery.error && <p role="alert">{gallery.error}</p>}
        {attachments.length === 0 ? (
          <p className="workspace-surface-empty">Attachments you send in this chat appear here.</p>
        ) : (
          <section className="workspace-surface-section attachments-surface-gallery environment-attachments"
            data-expanded="true" aria-labelledby={headingId}>
            <div className="environment-attachments-header">
              <h3 id={headingId}>{!remote && attachments.length === ENVIRONMENT_ATTACHMENT_GALLERY_LIMIT
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
