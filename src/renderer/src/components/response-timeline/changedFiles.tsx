import { useState } from "react";
import {
  ChevronDown,
  ExternalLink,
  FileCode2,
  Files,
  GitCompareArrows,
  TriangleAlert,
} from "lucide-react";
import {
  shouldShowTurnGitArtifactSummary,
  type TurnGitArtifactSummary,
} from "../../utils/responseTimeline";
import { sourceLanguageForFile } from "@shared/source-language";
import { useAnchoredDetailsToggle } from "./activity";
import type { ResponseTimelineProps } from "./types";

export function ChangedFilesSummary({
  artifact,
  previousTurnId,
  props,
  onBeforeToggle,
  onAfterToggle,
}: {
  artifact: TurnGitArtifactSummary;
  previousTurnId: string | null;
  props: ResponseTimelineProps;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const anchorToggleHandlers = useAnchoredDetailsToggle(onBeforeToggle, onAfterToggle);
  const detailsId = `turn-changed-files-details-${artifact.id}`;
  if (artifact.status === "pending") {
    return (
      <div
        className="turn-changed-files is-pending"
        data-turn-git-artifact-id={artifact.id}
        data-turn-jump-target="artifact"
        tabIndex={-1}
      >
        <Files size={13} aria-hidden="true" />
        <span><strong>Capturing changes…</strong><small>Git history will appear here when ready.</small></span>
      </div>
    );
  }
  if (
    artifact.status === "unavailable"
    || artifact.status === "failed"
    || artifact.completeness === "unavailable"
  ) {
    return (
      <div
        className="turn-changed-files is-unavailable"
        data-turn-git-artifact-id={artifact.id}
        data-turn-jump-target="artifact"
        tabIndex={-1}
      >
        <TriangleAlert size={13} aria-hidden="true" />
        <span>
          <strong>Turn changes unavailable</strong>
          <small>{artifact.failureReason ?? "No authoritative Git snapshot was captured for this turn."}</small>
        </span>
      </div>
    );
  }
  const patchAvailable = turnGitArtifactPatchAvailable(artifact);
  const completenessWarning = turnGitArtifactCompletenessWarning(artifact);
  return (
    <details
      className="turn-changed-files"
      open={expanded}
      aria-label="Changed by this turn"
      data-turn-git-artifact-id={artifact.id}
      data-turn-jump-target="artifact"
      tabIndex={-1}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
      }}
    >
      <summary
        aria-expanded={expanded}
        aria-controls={detailsId}
        {...anchorToggleHandlers}
      >
        <Files size={13} aria-hidden="true" />
        <span className="turn-changed-files-summary-copy">
          <strong>{artifact.files.length} {artifact.files.length === 1 ? "file" : "files"} changed</strong>
          <small>
            · +{artifact.insertions} −{artifact.deletions}
            {artifact.branch && ` · ${artifact.branch}`}
          </small>
        </span>
        <span className="turn-changed-files-toggle">
          {expanded ? "Hide" : "View"}
          <ChevronDown size={13} aria-hidden="true" />
        </span>
      </summary>
      <div className="turn-changed-files-body" id={detailsId}>
        {completenessWarning && (
          <p className="turn-changed-files-warning">
            <TriangleAlert size={12} aria-hidden="true" />
            <span>{completenessWarning}</span>
          </p>
        )}
        <div className="turn-changed-files-list" role="list">
          {artifact.files.slice(0, 12).map((file) => {
            const language = sourceLanguageForFile(file.path);
            return (
              <span
                key={file.path}
                title={`${file.path} · ${language.label}`}
                role="listitem"
                data-language-family={language.family}
              >
                <button
                  type="button"
                  disabled={!patchAvailable}
                  title={patchAvailable ? `Open this turn's diff for ${file.path}` : "The stored patch is unavailable"}
                  onClick={() => props.onOpenTurnDiff(artifact.turnId, file.path)}
                >
                  <FileCode2
                    className="file-language-icon"
                    size={13}
                    aria-hidden="true"
                  />
                  <code>{file.path}</code>
                  <small>{file.status} · +{file.insertions} −{file.deletions}</small>
                </button>
                <button
                  type="button"
                  title={`Open ${file.path}`}
                  aria-label={`Open ${file.path}`}
                  onClick={() => props.onOpenTurnFile(file.path)}
                >
                  <ExternalLink size={12} aria-hidden="true" />
                </button>
              </span>
            );
          })}
        </div>
        {artifact.files.length > 12 && <p className="turn-changed-files-overflow">And {artifact.files.length - 12} more files.</p>}
        <div className="turn-changed-files-actions">
          <button type="button" disabled={!patchAvailable} onClick={() => props.onOpenTurnDiff(artifact.turnId)}>
            <GitCompareArrows size={12} aria-hidden="true" />Open exact turn diff
          </button>
          {previousTurnId && (
            <button type="button" onClick={() => props.onCompareTurnArtifacts(previousTurnId, artifact.turnId)}>
              <GitCompareArrows size={12} aria-hidden="true" />Compare with previous turn
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

export function turnGitArtifactPatchAvailable(
  artifact: TurnGitArtifactSummary,
): boolean {
  return artifact.patchState === "available" || artifact.patchState === "truncated";
}

export function turnGitArtifactCompletenessWarning(
  artifact: TurnGitArtifactSummary,
): string | null {
  if (artifact.failureReason) return artifact.failureReason;
  const warnings: string[] = [];
  if (artifact.completeness === "truncated") {
    warnings.push(
      "This historical artifact reached a capture limit; its file list, totals, or stored patch may be incomplete.",
    );
  } else if (artifact.completeness === "partial") {
    warnings.push("Only a partial historical Git capture is available for this turn.");
  }
  if (artifact.patchState === "expired") {
    warnings.push("The stored patch has expired; the historical file summary is still available.");
  } else if (artifact.patchState === "failed") {
    warnings.push("The historical file summary is available, but its stored patch could not be read.");
  } else if (artifact.patchState === "none") {
    warnings.push("The historical file summary is available without a stored patch.");
  }
  return warnings.length > 0 ? warnings.join(" ") : null;
}

export function shouldShowChangedFilesSummary(
  artifact: TurnGitArtifactSummary,
): boolean {
  return shouldShowTurnGitArtifactSummary(artifact);
}
