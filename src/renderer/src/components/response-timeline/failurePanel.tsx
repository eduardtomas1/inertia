import {
  memo,
  useId,
  useMemo,
} from "react";
import {
  Check,
  Copy,
} from "lucide-react";
import type {
  AgentActivity,
  AgentTurn,
} from "@shared/contracts";
import {
  failureDiagnosticsPresentation,
  type FailureDiagnosticFact,
} from "../../utils/failureDiagnostics";
import { useCopiedState } from "../../hooks/useCopiedState";
import { navigateDiagnosticContext } from "../../utils/diagnosticNavigation";
import { TooltipButton } from "../TooltipButton";
import "./failureDiagnostics.css";

function DiagnosticFacts({ facts }: { facts: FailureDiagnosticFact[] }): React.JSX.Element {
  return (
    <dl className="turn-failure-facts">
      {facts.map(({ label, value, technical }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{technical ? <code>{value}</code> : value}</dd>
        </div>
      ))}
    </dl>
  );
}

const FailureDiagnostics = memo(function FailureDiagnostics({
  turn,
  activity,
}: {
  turn: AgentTurn;
  activity: AgentActivity;
}): React.JSX.Element {
  const { copied, error: copyError, copy } = useCopiedState();
  const presentation = useMemo(
    () => failureDiagnosticsPresentation(turn, activity),
    [activity, turn],
  );
  const panelId = useId();
  const headingId = useId();

  return (
    <section
      className="turn-failure-diagnostics"
      aria-labelledby={headingId}
      data-turn-failure-diagnostics=""
    >
      <div className="turn-failure-summary">
        <p id={headingId}>{presentation.summary}</p>
        <div className="turn-failure-actions" aria-label="Failure diagnostic actions">
          {typeof window.inertia?.queryDiagnostics === "function" && <button type="button" className="turn-failure-action" onClick={() => navigateDiagnosticContext({
            section: "help", anchor: "diagnostics-incidents", selection: { turnId: turn.id },
          })}>View diagnostics</button>}
          <TooltipButton
            className="turn-failure-action"
            aria-label={copied ? "Diagnostics copied" : copyError ? "Copy diagnostics failed" : "Copy diagnostics"}
            tooltip={copied ? "Diagnostics copied" : copyError ? "Copy diagnostics failed" : "Copy scrubbed diagnostics"}
            onClick={() => void copy(presentation.copyText)}
          >
            {copied
              ? <Check size={14} aria-hidden="true" />
              : <Copy size={14} aria-hidden="true" />}
            <span>{copied ? "Copied" : copyError ? "Copy failed" : "Copy"}</span>
          </TooltipButton>
        </div>
      </div>
      <div className="turn-failure-detail" id={panelId}>
        <div className="turn-failure-detail-grid">
          <section aria-labelledby={`${panelId}-execution`}>
            <h4 id={`${panelId}-execution`}>Execution</h4>
            <DiagnosticFacts facts={presentation.executionFacts} />
          </section>
          {presentation.providerFacts.length > 0 ? (
            <section aria-labelledby={`${panelId}-provider`}>
              <h4 id={`${panelId}-provider`}>Provider &amp; process</h4>
              <DiagnosticFacts facts={presentation.providerFacts} />
            </section>
          ) : null}
        </div>
        {presentation.cause ? (
          <section className="turn-failure-context" aria-labelledby={`${panelId}-cause`}>
            <h4 id={`${panelId}-cause`}>Error cause</h4>
            <pre>{presentation.cause}</pre>
          </section>
        ) : null}
        {presentation.context ? (
          <section className="turn-failure-context" aria-labelledby={`${panelId}-context`}>
            <h4 id={`${panelId}-context`}>Recent provider context</h4>
            <pre>{presentation.context}</pre>
          </section>
        ) : null}
        <p className="turn-failure-privacy">
          Scrubbed and bounded. Prompts, project paths, provider session IDs, credentials, and token values are excluded.
        </p>
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {copied ? "Diagnostics copied." : ""}
      </span>
      {copyError && <span className="visually-hidden" role="alert">{copyError}</span>}
    </section>
  );
});

export default FailureDiagnostics;
