import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ArrowRight, Check, FolderPlus, ShieldCheck } from "lucide-react";
import type { ProviderId, ProviderInfo } from "@shared/contracts";

import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import type { WelcomeShortcut } from "../../utils/welcomeGuide";
import {
  clampWelcomeStep,
  PROVIDER_READINESS_LABELS,
  providerReadiness,
  WELCOME_STEPS,
  WELCOME_TOPICS,
  type ProviderReadiness,
  type WelcomeTopicId,
} from "./welcomeGuideModel";
import "./WelcomeGuide.css";

const BRAND_PROVIDERS = ["codex", "claude", "cursor", "gemini", "kimi", "opencode"];

function order(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

function Vignette({ topic }: { topic: WelcomeTopicId }): React.JSX.Element {
  return (
    <div className={`welcome-vignette is-${topic}`} aria-hidden="true">
      {topic === "chat" && (
        <>
          <span className="v-bubble is-user" />
          <span className="v-bubble is-agent"><i /><i /><i /></span>
          <span className="v-composer"><i /></span>
        </>
      )}
      {topic === "split" && (
        <>
          <span className="v-pane is-first"><i /><i /></span>
          <span className="v-pane is-second"><i /><i /></span>
        </>
      )}
      {topic === "duo" && (
        <>
          <span className="v-brief" />
          <span className="v-agent is-a"><i /><i /></span>
          <span className="v-agent is-b"><i /><i /></span>
          <span className="v-judge"><Check size={12} /></span>
        </>
      )}
      {topic === "review" && (
        <>
          <span className="v-diff">
            <i className="is-add" />
            <i className="is-del" />
            <i className="is-add" />
            <i />
            <i className="is-add" />
          </span>
          <span className="v-check"><Check size={14} /></span>
        </>
      )}
      {topic === "limits" && (
        <>
          <span className="v-meter is-first"><i /></span>
          <span className="v-meter is-second"><i /></span>
          <span className="v-ring" />
        </>
      )}
    </div>
  );
}

function TourStep({
  titleId,
  shortcuts,
}: {
  titleId: string;
  shortcuts: readonly WelcomeShortcut[];
}): React.JSX.Element {
  const [topic, setTopic] = useState<WelcomeTopicId>("chat");
  const current = WELCOME_TOPICS.find((item) => item.id === topic)!;
  const moveTopic = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = WELCOME_TOPICS.findIndex((item) => item.id === topic);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const next = WELCOME_TOPICS[(index + offset + WELCOME_TOPICS.length) % WELCOME_TOPICS.length]!;
    setTopic(next.id);
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
              onClick={() => setTopic(item.id)}
            >
              {item.title}
            </button>
          ))}
        </div>
        <div
          key={topic}
          className="welcome-guide-topic"
          role="tabpanel"
          id="welcome-topic-panel"
          aria-labelledby={`welcome-topic-${topic}`}
        >
          <Vignette topic={topic} />
          <h3>{current.title}</h3>
          <p>{current.detail}</p>
        </div>
      </div>
      <ul className="welcome-guide-shortcuts" aria-label="Keyboard shortcuts">
        {shortcuts.map((shortcut) => (
          <li key={shortcut.label}><kbd>{shortcut.keys}</kbd>{shortcut.label}</li>
        ))}
      </ul>
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
    setDirection(offset > 0 ? 1 : -1);
    setStep(next);
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
        <div
          key={step}
          className="welcome-guide-step"
          data-step={WELCOME_STEPS[step]!.id}
          style={{ "--welcome-direction": direction } as CSSProperties}
        >
          {step === 0 && (
            <>
              <div className="welcome-guide-hero">
                <span className="welcome-guide-logo"><img src="./inertia-logo.png" alt="" /></span>
                <h2 id={titleId}>Welcome to Inertia</h2>
                <p>A calm desktop workspace for building with coding agents.</p>
              </div>
              <ul className="welcome-guide-tiles">
                <li style={order(0)}>
                  <span className="welcome-tile-visual is-agents" aria-hidden="true">
                    {BRAND_PROVIDERS.map((providerId) => (
                      <ProviderBrandIcon key={providerId} providerId={providerId} decorative size={16} />
                    ))}
                  </span>
                  <strong>Your coding agents</strong>
                  <small>Codex, Claude, Cursor, Gemini CLI, Kimi Code and OpenCode, with the accounts you already have.</small>
                </li>
                <li style={order(1)}>
                  <span className="welcome-tile-visual is-local" aria-hidden="true"><ShieldCheck size={22} /></span>
                  <strong>Local by default</strong>
                  <small>History and preferences stay on this computer.</small>
                </li>
                <li style={order(2)}>
                  <span className="welcome-tile-visual is-review" aria-hidden="true"><i /><i /><i /></span>
                  <strong>Review before you ship</strong>
                  <small>Diffs, hunks and commits right beside the chat.</small>
                </li>
              </ul>
            </>
          )}
          {step === 1 && <TourStep titleId={titleId} shortcuts={shortcuts} />}
          {step === 2 && (
            <>
              <h2 id={titleId} className="welcome-guide-title">Connect an agent</h2>
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
          {step === 3 && (
            <>
              <div className="welcome-guide-hero">
                <span className="welcome-guide-check" aria-hidden="true"><Check size={22} /></span>
                <h2 id={titleId}>You're ready to start</h2>
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
