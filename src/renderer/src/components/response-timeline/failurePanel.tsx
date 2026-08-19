import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Check,
  ChevronDown,
  Copy,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type {
  AgentActivity,
  AgentTurn,
} from "@shared/contracts";
import {
  failureDiagnosticsPresentation,
  type FailureDiagnosticFact,
} from "../../utils/failureDiagnostics";
import { writeClipboardText } from "../../utils/clipboard";
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
  anchor: [onBeforeToggle, onAfterToggle],
}: {
  turn: AgentTurn;
  activity: AgentActivity;
  anchor: readonly [before?: () => void, after?: () => void];
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  const togglePrepared = useRef(false);
  const presentation = useMemo(
    () => failureDiagnosticsPresentation(turn, activity),
    [activity, turn],
  );
  const panelId = `turn-failure-details-${turn.id}`;
  const headingId = `turn-failure-heading-${turn.id}`;

  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);

  const prepareToggle = useCallback(() => {
    if (togglePrepared.current) return;
    togglePrepared.current = true;
    onBeforeToggle?.();
  }, [onBeforeToggle]);
  const toggle = (): void => {
    prepareToggle();
    setExpanded((current) => !current);
    window.requestAnimationFrame(() => {
      onAfterToggle?.();
      togglePrepared.current = false;
    });
  };
  const prepareKeyboardToggle = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "Enter" || event.key === " ") prepareToggle();
  };
  const copyDiagnostics = async (): Promise<void> => {
    if (!await writeClipboardText(presentation.copyText)) return;
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <section
      className="turn-failure-diagnostics"
      aria-labelledby={headingId}
      data-turn-failure-diagnostics=""
    >
      <div className="turn-failure-summary">
        <span className="turn-failure-mark" aria-hidden="true">
          <TriangleAlert size={15} />
        </span>
        <div className="turn-failure-summary-copy">
          <span>Run failed</span>
          <p id={headingId}>{presentation.summary}</p>
        </div>
        <div className="turn-failure-actions" aria-label="Failure diagnostic actions">
          <button
            type="button"
            className="turn-failure-action"
            aria-label={copied ? "Diagnostics copied" : "Copy diagnostics"}
            title={copied ? "Diagnostics copied" : "Copy scrubbed diagnostics"}
            onClick={() => void copyDiagnostics()}
          >
            {copied
              ? <Check size={12} aria-hidden="true" />
              : <Copy size={12} aria-hidden="true" />}
            <span>{copied ? "Copied" : "Copy"}</span>
          </button>
          <button
            type="button"
            className="turn-failure-action turn-failure-toggle"
            aria-expanded={expanded}
            aria-controls={panelId}
            onPointerDownCapture={prepareToggle}
            onPointerCancelCapture={() => {
              togglePrepared.current = false;
            }}
            onKeyDownCapture={prepareKeyboardToggle}
            onClickCapture={prepareToggle}
            onClick={toggle}
          >
            <span>{expanded ? "Hide details" : "Technical details"}</span>
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </div>
      </div>
      {expanded ? (
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
            <ShieldCheck size={12} aria-hidden="true" />
            <span>Scrubbed and bounded. Prompts, project paths, provider session IDs, credentials, and token values are excluded.</span>
          </p>
        </div>
      ) : null}
      <span className="visually-hidden" role="status" aria-live="polite">
        {copied ? "Diagnostics copied." : ""}
      </span>
    </section>
  );
});

export default FailureDiagnostics;
