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

import { ProviderBrandIcon } from "../ProviderBrandIcon";
import type { WelcomeShortcut } from "../../utils/welcomeGuide";
import { WelcomeDemo } from "./WelcomeDemos";
import {
  GuideDemo,
  GuideDialog,
  GuideTopicTabs,
  order,
  useGuideModal,
  useGuideTopic,
  useLeavingTransition,
} from "./GuideParts";
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

export { HelpGuide } from "./HelpGuide";

function TourStep({
  titleId,
  shortcuts,
}: {
  titleId: string | undefined;
  shortcuts: readonly WelcomeShortcut[];
}): React.JSX.Element {
  const { topic, leaving, choose } = useGuideTopic<WelcomeTopicId>("split");
  const current = WELCOME_TOPICS.find((item) => item.id === topic)!;
  const stages = leaving === null ? [topic] : [leaving, topic];
  return (
    <>
      <h2 id={titleId} className="welcome-guide-title">How it works</h2>
      <GuideTopicTabs idPrefix="welcome-topic" topics={WELCOME_TOPICS} topic={topic} onChoose={choose}>
        <GuideDemo
          stages={stages.map((id) => ({ key: id, demo: id, leaving: id !== topic }))}
          shortcuts={shortcuts}
        />
        <div className="welcome-guide-topic-copy">
          <h3>{current.title}</h3>
          <p>{topicDetail(current.detail, shortcuts)}</p>
        </div>
      </GuideTopicTabs>
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
  const [leavingStep, leaveStep] = useLeavingTransition<number>(200);
  const primary = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const last = WELCOME_STEPS.length - 1;
  const readiness = providers.map((provider): [ProviderInfo, ProviderReadiness] => [
    provider,
    providerReadiness(provider),
  ]);
  const readyCount = readiness.filter(([, state]) => state === "ready").length;
  useGuideModal();
  useLayoutEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, [step]);

  const go = (offset: number): void => {
    const next = clampWelcomeStep(step + offset);
    if (next === step) return;
    setDirection(offset > 0 ? 1 : -1);
    leaveStep(step);
    setStep(next);
  };
  const advance = (): void => {
    if (step === last) onClose();
    else go(1);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
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
    }
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
            {readyCount} of {readiness.length} ready · change this any time in Settings → Agents
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
    <GuideDialog
      className="welcome-guide"
      label="Welcome guide"
      describedBy={titleId}
      onClose={onClose}
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
    </GuideDialog>
  );
}
