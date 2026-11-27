import { ExternalLink, Maximize2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  const stageRef = useRef<HTMLDivElement>(null);
  const [metadata, setMetadata] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const descriptor = useMemo(
    () => classifyWorkspaceMediaPath(target.relativePath),
    [target.relativePath],
  );
  const label = descriptor?.label ?? target.kind;

  useEffect(() => {
    setMetadata(null);
  }, [target.url, reloadNonce]);

  const handleOpenExternally = useCallback((item: WorkspaceMediaPreviewTarget) => {
    onOpenFile?.(item.relativePath);
  }, [onOpenFile]);

  const handleExpand = useCallback(() => {
    if (!onPreviewMedia) return;
    const stage = stageRef.current;
    if (stage) {
      for (const element of stage.querySelectorAll<HTMLMediaElement>("video, audio")) {
        try {
          if (typeof element.pause === "function") element.pause();
        } catch {
          // Ignore pause failures in non-media DOM environments.
        }
      }
    }
    onPreviewMedia(target);
  }, [onPreviewMedia, target]);

  return (
    <div
      className="files-panel-media-preview"
      data-media-kind={target.kind}
    >
      <div className="files-panel-media-bar">
        <div className="files-panel-media-bar-info">
          <span className="workspace-media-dialog-badge" data-media-kind={target.kind}>
            {label}
          </span>
          {metadata && <span className="files-panel-media-bar-meta">{metadata}</span>}
        </div>
        <div className="files-panel-media-bar-actions">
          <button
            type="button"
            aria-label={`Reload ${target.name}`}
            title="Reload preview"
            onClick={() => setReloadNonce((value) => value + 1)}
          >
            <RotateCw size={14} aria-hidden="true" />
            <span>Reload</span>
          </button>
          {onPreviewMedia && (
            <button
              type="button"
              title="Expand preview"
              onClick={handleExpand}
            >
              <Maximize2 size={14} aria-hidden="true" />
              <span>Expand</span>
            </button>
          )}
          {onOpenFile && (
            <button
              type="button"
              title="Open externally"
              onClick={() => onOpenFile(target.relativePath)}
            >
              <ExternalLink size={14} aria-hidden="true" />
              <span>Open externally</span>
            </button>
          )}
        </div>
      </div>
      <div ref={stageRef} className="files-panel-media-stage">
        <WorkspaceMediaViewer
          key={`${target.url}:${reloadNonce}`}
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
