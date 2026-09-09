import type { FileTreeGitIndex } from "../utils/fileTreeGit";
import "./FileGitBadge.css";

export function FileGitBadge({ index, path, directory = false }: {
  index: FileTreeGitIndex; path: string; directory?: boolean;
}): React.JSX.Element | null {
  const status = directory ? null : index.files.get(path);
  if (directory && index.directories.has(path)) return <span className="file-git-badge is-modified" title="Contains Git changes" aria-label="Contains Git changes">•</span>;
  return status ? <span className={`file-git-badge is-${status.kind}`} title={status.label} aria-label={`Git: ${status.label}`}>{status.mark}</span> : null;
}
