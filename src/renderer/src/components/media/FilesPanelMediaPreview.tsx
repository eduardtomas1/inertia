import { ExternalLink, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  classifyWorkspaceMediaPath,
  type WorkspaceMediaPreviewTarget,
} from "@shared/workspace-media-preview";
import { WorkspaceMediaViewer } from "./WorkspaceMediaViewer";
import "./WorkspaceMediaPreview.css";

export interface FilesPanelMediaPreviewProps {
  readonly target: WorkspaceMediaPreviewTarget;
  readonly onPreviewMedia?: (target: WorkspaceMediaPreviewTarget) => void;
  readonly onOpenFile?: (relativePath: string) => void;
}

export function FilesPanelMediaPreview({
  target,
  onPreviewMedia,
  onOpenFile,
}: FilesPanelMediaPreviewProps): React.JSX.Element {
  const [metadata, setMetadata] = useState<string | null>(null);
  const descriptor = useMemo(
    () => classifyWorkspaceMediaPath(target.relativePath),
    [target.relativePath],
  );
  const label = descriptor?.label ?? target.kind;

  useEffect(() => {
    setMetadata(null);
  }, [target.url]);

  const handleOpenExternally = useCallback((item: WorkspaceMediaPreviewTarget) => {
    onOpenFile?.(item.relativePath);
  }, [onOpenFile]);

  return (
    <div
      className="files-panel-media-preview"
      data-media-kind={target.kind}
    >
      <div className="files-panel-media-bar">
        <div className="files-panel-media-bar-info">
          <span className="workspace-media-dialog-badge">{label}</span>
          {metadata && <span>{metadata}</span>}
        </div>
        {(onPreviewMedia || onOpenFile) && (
          <div className="files-panel-media-bar-actions">
            {onPreviewMedia && (
              <button
                type="button"
                onClick={() => onPreviewMedia(target)}
              >
                <Maximize2 size={14} aria-hidden="true" />
                <span>Expand</span>
              </button>
            )}
            {onOpenFile && (
              <button
                type="button"
                onClick={() => onOpenFile(target.relativePath)}
              >
                <ExternalLink size={14} aria-hidden="true" />
                <span>Open externally</span>
              </button>
            )}
          </div>
        )}
      </div>
      <div className="files-panel-media-stage">
        <WorkspaceMediaViewer
          target={target}
          compact
          onOpenExternally={onOpenFile ? handleOpenExternally : undefined}
          onMetadata={setMetadata}
        />
      </div>
    </div>
  );
}

export default FilesPanelMediaPreview;
