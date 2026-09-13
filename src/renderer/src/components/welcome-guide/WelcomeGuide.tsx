import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ArrowRight, Check, FolderPlus } from "lucide-react";
import type { ProviderId, ProviderInfo } from "@shared/contracts";

import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import type { WelcomeShortcut } from "../../utils/welcomeGuide";
import { WelcomeDemo } from "./WelcomeDemos";
import {
  clampWelcomeStep,
  PROVIDER_READINESS_LABELS,
  providerReadiness,
  topicDetail,
  WELCOME_STEPS,
  WELCOME_TILES,
  WELCOME_TOPICS,
  type ProviderReadiness,
  type WelcomeTopicId,
} from "./welcomeGuideModel";
import "./WelcomeGuide.css";

function order(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

function TourStep({
  titleId,
  shortcuts,
}: {
  titleId: string | undefined;
  shortcuts: readonly WelcomeShortcut[];
}): React.JSX.Element {
  const [topic, setTopic] = useState<WelcomeTopicId>("split");
  const [leaving, setLeaving] = useState<WelcomeTopicId | null>(null);
  const current = WELCOME_TOPICS.find((item) => item.id === topic)!;
  const stages = leaving === null ? [topic] : [leaving, topic];
  const choose = (next: WelcomeTopicId): void => {
    if (next === topic) return;
    const previous = topic;
    setLeaving(previous);
    setTopic(next);
    window.setTimeout(() => setLeaving((value) => (value === previous ? null : value)), 160);
  };
  const moveTopic = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = WELCOME_TOPICS.findIndex((item) => item.id === topic);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const next = WELCOME_TOPICS[(index + offset + WELCOME_TOPICS.length) % WELCOME_TOPICS.length]!;
    choose(next.id);
    document.getElementById(`welcome-topic-${next.id}`)?.focus();
  };
  return (
    <>
      <h2 id={titleId} className="welcome-guide-title">How it works</h2>
      <div className="welcome-guide-tour">
        <div
          className="welcome-guide-topics"
          role="tablist"
          aria-label="Topics"
          aria-orientation="vertical"
          onKeyDown={moveTopic}
        >
          {WELCOME_TOPICS.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`welcome-topic-${item.id}`}
              aria-selected={item.id === topic}
              aria-controls="welcome-topic-panel"
              tabIndex={item.id === topic ? 0 : -1}
              style={order(index)}
              onClick={() => choose(item.id)}
            >
              {item.title}
            </button>
          ))}
        </div>
        <div
          className="welcome-guide-topic"
          role="tabpanel"
          id="welcome-topic-panel"
          aria-labelledby={`welcome-topic-${topic}`}
        >
          <div className="welcome-demo" aria-hidden="true">
            {stages.map((id) => (
              <WelcomeDemo key={id} demo={id} shortcuts={shortcuts} leaving={id !== topic} />
            ))}
          </div>
          <div className="welcome-guide-topic-copy">
            <h3>{current.title}</h3>
            <p>{topicDetail(current.detail, shortcuts)}</p>
          </div>
        </div>
      </div>
    </>
  );
}

export function WelcomeGuide({
  providers,
  shortcuts,
  onClose,
  onOpenProviderSetup,
  onAddProject,
}: {
  providers: readonly ProviderInfo[];
  shortcuts: readonly WelcomeShortcut[];
  onClose: () => void;
  onOpenProviderSetup: (providerId: ProviderId) => void;
  onAddProject: () => void;
}): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState(1);
  const [leavingStep, setLeavingStep] = useState<number | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const last = WELCOME_STEPS.length - 1;
  const readiness = providers.map((provider): [ProviderInfo, ProviderReadiness] => [
    provider,
    providerReadiness(provider),
  ]);
  const readyCount = readiness.filter(([, state]) => state === "ready").length;
  useNativePreviewSuspension(true);
  useLayoutEffect(() => captureModalFocus(), []);
  useLayoutEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, [step]);

  const go = (offset: number): void => {
    const next = clampWelcomeStep(step + offset);
    if (next === step) return;
    const previous = step;
    setDirection(offset > 0 ? 1 : -1);
    setLeavingStep(previous);
    setStep(next);
    window.setTimeout(() => setLeavingStep((value) => (value === previous ? null : value)), 200);
  };
  const advance = (): void => {
    if (step === last) onClose();
    else go(1);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (
      (event.key === "ArrowRight" || event.key === "ArrowLeft")
      && !target.closest("[role='tablist']")
    ) {
      event.preventDefault();
      go(event.key === "ArrowRight" ? 1 : -1);
      return;
    }
    if (event.key === "Enter" && target === event.currentTarget) {
      event.preventDefault();
      advance();
      return;
    }
    trapModalFocus(event, event.currentTarget);
  };
  const renderStep = (stepIndex: number, headingId: string | undefined): React.JSX.Element => (
    <>
      {stepIndex === 0 && (
        <>
          <div className="welcome-guide-hero">
            <img className="welcome-guide-logo" src="./inertia-logo.png" alt="" />
            <h2 id={headingId}>Welcome to Inertia</h2>
            <p>A calm, local desktop workspace for building with the coding agents you already use.</p>
          </div>
          <ul className="welcome-guide-tiles">
            {WELCOME_TILES.map((tile, index) => (
              <li key={tile.demo} style={order(index)}>
                <div className="welcome-demo is-compact" aria-hidden="true">
                  <WelcomeDemo demo={tile.demo} />
                </div>
                <strong>{tile.title}</strong>
                <small>{tile.detail}</small>
              </li>
            ))}
          </ul>
        </>
      )}
      {stepIndex === 1 && <TourStep titleId={headingId} shortcuts={shortcuts} />}
      {stepIndex === 2 && (
        <>
          <h2 id={headingId} className="welcome-guide-title">Connect an agent</h2>
          <p className="welcome-guide-lede">
            Inertia works with the coding agents you already use. Each provider keeps its own sign-in.
          </p>
          {readiness.length === 0 ? (
            <p className="welcome-guide-note">Checking installed agents…</p>
          ) : (
            <ul className="welcome-guide-agents" aria-label="Agents on this computer">
              {readiness.map(([provider, state], index) => (
                <li key={provider.id} data-state={state} style={order(index)}>
                  <ProviderBrandIcon providerId={provider.id} decorative size={18} />
                  <strong>{provider.label}</strong>
                  <small>{PROVIDER_READINESS_LABELS[state]}</small>
                  {state !== "ready" && (
                    <button
                      type="button"
                      aria-label={`Set up ${provider.label}`}
                      onClick={() => onOpenProviderSetup(provider.id)}
                    >
                      Set up
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="welcome-guide-note">
            {readyCount} of {readiness.length} ready · change this any time in Settings → Providers
          </p>
        </>
      )}
      {stepIndex === 3 && (
        <>
          <div className="welcome-guide-hero">
            <span className="welcome-guide-check" aria-hidden="true"><Check size={22} /></span>
            <h2 id={headingId}>You're ready to start</h2>
            <p>
              {readyCount > 0
                ? `${readyCount} agent${readyCount === 1 ? " is" : "s are"} ready. Add a project to open your first chat.`
                : "Add a project now and connect an agent when you're ready."}
            </p>
          </div>
          <button type="button" className="welcome-guide-project" onClick={onAddProject}>
            <FolderPlus size={18} aria-hidden="true" />
            <span><strong>Add a project</strong><small>Open a local folder or clone a repository.</small></span>
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <p className="welcome-guide-note">You can replay this guide from Settings.</p>
        </>
      )}
    </>
  );

  return (
    <div className="dialog-backdrop welcome-guide-backdrop">
      <section
        className="welcome-guide"
        role="dialog"
        aria-modal="true"
        aria-label="Welcome guide"
        aria-describedby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="welcome-guide-header">
          <span className="welcome-guide-count">
            Step {step + 1} of {WELCOME_STEPS.length}
          </span>
          <button type="button" className="welcome-guide-skip" onClick={onClose}>
            Skip
          </button>
        </header>
        <div className="welcome-guide-body">
          {(leavingStep === null ? [step] : [leavingStep, step]).map((index) => {
            const leaving = index !== step;
            return (
              <div
                key={index}
                className={`welcome-guide-step${leaving ? " is-leaving" : ""}`}
                data-step={WELCOME_STEPS[index]!.id}
                style={{ "--welcome-direction": direction } as CSSProperties}
                aria-hidden={leaving || undefined}
                inert={leaving}
              >
                {renderStep(index, leaving ? undefined : titleId)}
              </div>
            );
          })}
        </div>
        <footer className="welcome-guide-footer">
          <span
            className="welcome-guide-dots"
            role="progressbar"
            aria-label="Guide progress"
            aria-valuemin={1}
            aria-valuemax={WELCOME_STEPS.length}
            aria-valuenow={step + 1}
            aria-valuetext={`Step ${step + 1} of ${WELCOME_STEPS.length}: ${WELCOME_STEPS[step]!.title}`}
          >
            {WELCOME_STEPS.map((item, index) => (
              <i key={item.id} data-state={index === step ? "current" : index < step ? "done" : "next"} />
            ))}
          </span>
          <span className="welcome-guide-actions">
            {step > 0 && (
              <button type="button" className="welcome-guide-back" onClick={() => go(-1)}>
                Back
              </button>
            )}
            <button ref={primary} type="button" className="welcome-guide-primary" onClick={advance}>
              {WELCOME_STEPS[step]!.primary}
              <ArrowRight size={15} aria-hidden="true" />
            </button>
          </span>
        </footer>
      </section>
    </div>
  );
}
