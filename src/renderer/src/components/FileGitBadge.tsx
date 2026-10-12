import type { FileTreeGitIndex } from "../utils/fileTreeGit";
import { TooltipText } from "./TooltipText";
import "./FileGitBadge.css";

export function FileGitBadge({ index, path, directory = false }: {
  index: FileTreeGitIndex; path: string; directory?: boolean;
}): React.JSX.Element | null {
  const status = directory ? null : index.files.get(path);
  if (directory && index.directories.has(path)) return <TooltipText className="file-git-badge is-modified" aria-label="Contains Git changes" tooltip="Contains Git changes">•</TooltipText>;
  return status ? <TooltipText className={`file-git-badge is-${status.kind}`} aria-label={`Git: ${status.label}`} tooltip={status.label}>{status.mark}</TooltipText> : null;
}
