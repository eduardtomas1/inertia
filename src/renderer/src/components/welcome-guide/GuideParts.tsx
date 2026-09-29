import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import { useNativePreviewSuspension } from "../../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../../utils/modalFocus";
import type { WelcomeShortcut } from "../../utils/welcomeGuide";
import { WelcomeDemo } from "./WelcomeDemos";
import type { WelcomeTopicId } from "./welcomeGuideModel";

export function order(index: number): CSSProperties {
  return { "--i": index } as CSSProperties;
}

export function useGuideModal(): () => void {
  const release = useRef<() => void>(() => undefined);
  useNativePreviewSuspension(true);
  useLayoutEffect(() => {
    let restore: (() => void) | null = captureModalFocus();
    const restoreOnce = (): void => {
      const back = restore;
      restore = null;
      back?.();
    };
    release.current = restoreOnce;
    return restoreOnce;
  }, []);
  return () => release.current();
}

export function GuideDialog({
  className,
  label,
  labelledBy,
  describedBy,
  onClose,
  onKeyDown,
  children,
}: {
  className: string;
  label?: string;
  labelledBy?: string;
  describedBy?: string;
  onClose: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => void;
  children: ReactNode;
}): React.JSX.Element {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    trapModalFocus(event, event.currentTarget);
  };
  return (
    <div className="dialog-backdrop welcome-guide-backdrop">
      <section
        className={className}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </section>
    </div>
  );
}

export function useGuideTopic<Id extends string>(initial: Id): {
  topic: Id;
  leaving: Id | null;
  choose: (next: Id) => void;
} {
  const [topic, setTopic] = useState<Id>(initial);
  const [leaving, setLeaving] = useState<Id | null>(null);
  const choose = (next: Id): void => {
    if (next === topic) return;
    const previous = topic;
    setLeaving(previous);
    setTopic(next);
    window.setTimeout(() => setLeaving((value) => (value === previous ? null : value)), 160);
  };
  return { topic, leaving, choose };
}

export function GuideTopicTabs<Id extends string>({
  idPrefix,
  topics,
  topic,
  onChoose,
  panelFocusable = false,
  children,
}: {
  idPrefix: string;
  topics: ReadonlyArray<{ id: Id; title: string }>;
  topic: Id;
  onChoose: (next: Id) => void;
  panelFocusable?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const moveTopic = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const index = topics.findIndex((item) => item.id === topic);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const next = topics[(index + offset + topics.length) % topics.length]!;
    onChoose(next.id);
    document.getElementById(`${idPrefix}-${next.id}`)?.focus();
  };
  return (
    <div className="welcome-guide-tour">
      <div
        className="welcome-guide-topics"
        role="tablist"
        aria-label="Topics"
        aria-orientation="vertical"
        onKeyDown={moveTopic}
      >
        {topics.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`${idPrefix}-${item.id}`}
            aria-selected={item.id === topic}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={item.id === topic ? 0 : -1}
            style={order(index)}
            onClick={() => onChoose(item.id)}
          >
            {item.title}
          </button>
        ))}
      </div>
      <div
        className="welcome-guide-topic"
        role="tabpanel"
        id={`${idPrefix}-panel`}
        aria-labelledby={`${idPrefix}-${topic}`}
        tabIndex={panelFocusable ? 0 : undefined}
      >
        {children}
      </div>
    </div>
  );
}

export function GuideDemo({
  stages,
  shortcuts,
}: {
  stages: ReadonlyArray<{ key: string; demo: WelcomeTopicId; leaving: boolean }>;
  shortcuts: readonly WelcomeShortcut[];
}): React.JSX.Element {
  return (
    <div className="welcome-demo" aria-hidden="true">
      {stages.map((stage) => (
        <WelcomeDemo key={stage.key} demo={stage.demo} shortcuts={shortcuts} leaving={stage.leaving} />
      ))}
    </div>
  );
}
