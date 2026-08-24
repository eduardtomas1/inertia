import { memo, useEffect, useRef, useState } from "react";
import type {
  BrowserEvidenceEntry,
  BrowserEvidenceSnapshot,
} from "@shared/browser-evidence";
import { IconButton } from "./ui";
import "./BrowserEvidenceTimeline.css";

type EvidenceInspectionState = "loading" | "opened" | "unavailable";

export interface BrowserEvidenceTimelineProps {
  id: string;
  evidence: BrowserEvidenceSnapshot;
  inspectImage: (evidenceId: string) => Promise<boolean>;
  onClose: () => void;
}

function evidenceKindLabel(kind: BrowserEvidenceEntry["kind"]): string {
  switch (kind) {
    case "screenshot": return "Screenshot";
    case "console-error": return "Console";
    case "network-failure": return "Request";
    case "navigation": return "Navigation";
    case "agent-action": return "Agent action";
  }
}

export function BrowserEvidenceTimeline({
  id,
  evidence,
  inspectImage,
  onClose,
}: BrowserEvidenceTimelineProps): React.JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  const availableImageIdsRef = useRef<ReadonlySet<string>>(new Set());
  const [inspections, setInspections] = useState<Record<string, EvidenceInspectionState>>({});
  const entries = evidence.entries.slice().reverse();
  availableImageIdsRef.current = new Set(evidence.entries.flatMap((entry) => (
    entry.screenshot?.available ? [entry.id] : []
  )));

  useEffect(() => {
    if (document.activeElement?.getAttribute("aria-controls") === id) closeRef.current?.focus();
  }, [id]);

  useEffect(() => {
    const available = availableImageIdsRef.current;
    setInspections((current) => Object.fromEntries(
      Object.entries(current).filter(([entryId]) => available.has(entryId)),
    ));
  }, [evidence.revision, evidence.entries]);

  const requestImage = (entry: BrowserEvidenceEntry): void => {
    if (!entry.screenshot?.available || inspections[entry.id] === "loading") return;
    setInspections((current) => ({ ...current, [entry.id]: "loading" }));
    void inspectImage(entry.id).then((opened) => {
      setInspections((current) => availableImageIdsRef.current.has(entry.id) ? ({
        ...current, [entry.id]: opened ? "opened" : "unavailable",
      }) : current);
    }, () => {
      setInspections((current) => availableImageIdsRef.current.has(entry.id) ? ({
        ...current, [entry.id]: "unavailable",
      }) : current);
    });
  };

  return (
    <section
      className="browser-evidence"
      id={id}
      aria-labelledby={`${id}-title`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="browser-evidence-header">
        <span className="browser-evidence-heading-icon">
          <span aria-hidden="true">•</span>
        </span>
        <span>
          <strong id={`${id}-title`}>Local evidence</strong>
          <small>Clears with this Browser session</small>
        </span>
        <IconButton ref={closeRef} label="Close Browser evidence" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </IconButton>
      </header>

      {entries.length === 0 ? (
        <div className="browser-evidence-empty">
          <span className="browser-evidence-empty-mark" aria-hidden="true">•</span>
          <strong>No evidence yet</strong>
          <span>Screenshots, page failures, navigation, and agent actions stay on this device.</span>
        </div>
      ) : (
        <ol className="browser-evidence-list" aria-label="Browser evidence timeline">
          {entries.map((entry) => {
            const time = new Date(entry.occurredAt).toLocaleTimeString();
            const kindLabel = evidenceKindLabel(entry.kind);
            const inspection = inspections[entry.id];
            return (
              <li
                key={entry.id}
                className={`browser-evidence-entry is-${entry.kind}`}
              >
                <span className="browser-evidence-entry-icon">
                  <span aria-hidden="true">{kindLabel[0]}</span>
                </span>
                <span className="browser-evidence-entry-copy">
                  <span className="browser-evidence-entry-meta">
                    <span>{kindLabel}</span>
                    <span>Page {entry.pageNumber}</span>
                    <time dateTime={entry.occurredAt}>{time}</time>
                  </span>
                  <strong>{entry.summary}</strong>
                  {entry.detail && <span>{entry.detail}</span>}
                  <span className="browser-evidence-entry-flags">
                    {entry.occurrences > 1 && <small>{entry.occurrences} occurrences</small>}
                    {entry.redacted && <small>Detail redacted</small>}
                  </span>
                  {entry.screenshot?.available ? (
                    <details
                      className="browser-evidence-screenshot"
                      onToggle={(event) => {
                        if (event.currentTarget.open) requestImage(entry);
                      }}
                    >
                      <summary>Inspect capture</summary>
                      {inspection === "loading" && (
                        <span className="browser-evidence-image-status">
                          Opening protected capture…
                        </span>
                      )}
                      {inspection === "opened" && (
                        <span className="browser-evidence-image-status">
                          Capture opened in a protected window.
                        </span>
                      )}
                      {inspection === "unavailable" && (
                        <span className="browser-evidence-image-status">Capture is no longer available.</span>
                      )}
                    </details>
                  ) : entry.screenshot ? (
                    <small className="browser-evidence-capture-expired">Capture expired</small>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      {evidence.omitted && (
        <p className="browser-evidence-omitted">Some older or repeated evidence was omitted to keep this ledger bounded.</p>
      )}
    </section>
  );
}

export default memo(BrowserEvidenceTimeline);
