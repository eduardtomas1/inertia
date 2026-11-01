import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  advanceThinkingLine,
  createReasoningLinesReader,
  IDLE_THINKING_LINE,
  parseReasoningSummary,
  reasoningLineAt,
  thinkingLineWakeAt,
  type ReasoningLine,
} from "../../utils/reasoningSummary";
import { WorkingOrb } from "../working-indicator/WorkingOrb";
import { useWorkingIndicator } from "../working-indicator/WorkingIndicatorContext";
import { ACTIVITY_ORB_MOTION, resolveOrbMotion, usesActivityOrbs } from "../working-indicator/orbMotion";

export function ReasoningSummary({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}): React.JSX.Element {
  const segments = useMemo(() => parseReasoningSummary(content), [content]);
  const indicator = useWorkingIndicator();
  const stepOrb = streaming && usesActivityOrbs(indicator)
    ? resolveOrbMotion(indicator, ACTIVITY_ORB_MOTION.reasoning)
    : null;
  if (segments.length === 0) {
    return (
      <p className="turn-reasoning-body">
        {content}
      </p>
    );
  }
  return (
    <ol className="turn-reasoning-steps">
      {segments.map((segment, index) => (
        <li
          key={segment.id}
          className={clsx(
            "turn-reasoning-step",
            streaming && index === segments.length - 1 && "is-active",
          )}
          data-step-indicator={stepOrb && index === segments.length - 1 ? "orb" : undefined}
        >
          {stepOrb && index === segments.length - 1 && (
            <WorkingOrb
              className="turn-reasoning-step-orb"
              size={12}
              design={stepOrb.design}
              pace={stepOrb.pace}
            />
          )}
          {segment.title && (
            <span className="turn-reasoning-step-title">{segment.title}</span>
          )}
          {segment.body && (
            <span className="turn-reasoning-step-body">{segment.body}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

export interface ThinkingLineView {
  current: ReasoningLine | null;
  previous: ReasoningLine | null;
  holding: boolean;
}

const NO_REASONING_LINES: ReasoningLine[] = [];

export function useReadableThinkingLine(
  content: string,
  active: boolean,
): ThinkingLineView {
  const [state, setState] = useState(IDLE_THINKING_LINE);
  const [readReasoningLines] = useState(createReasoningLinesReader);
  const reading = active || state.offset !== null;
  const lines = useMemo(
    () => reading ? readReasoningLines(content) : NO_REASONING_LINES,
    [content, reading, readReasoningLines],
  );
  const next = advanceThinkingLine(state, lines, {
    active,
    length: content.length,
    now: Date.now(),
  });
  if (next !== state) setState(next);
  const wakeAt = thinkingLineWakeAt(next, lines, active);
  const length = content.length;
  useEffect(() => {
    if (wakeAt === null) return;
    const timer = window.setTimeout(() => {
      setState((current) => advanceThinkingLine(current, lines, {
        active,
        length,
        now: Date.now(),
      }));
    }, Math.max(0, wakeAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [active, length, lines, wakeAt]);
  return {
    current: next.offset === null ? null : reasoningLineAt(lines, next.offset),
    previous: next.previousOffset === null
      ? null
      : reasoningLineAt(lines, next.previousOffset),
    holding: !active && next.offset !== null,
  };
}

export interface ReasoningSpan {
  startedAt: string;
  durationMs: number | null;
}

export function useReasoningSpan(active: boolean): ReasoningSpan {
  const [span, setSpan] = useState(() => ({
    active,
    since: active ? Date.now() : 0,
    spentMs: 0,
  }));
  let current = span;
  if (span.active !== active) {
    const now = Date.now();
    current = active
      ? { active, since: now, spentMs: span.spentMs }
      : { active, since: 0, spentMs: span.spentMs + now - span.since };
    setSpan(current);
  }
  return {
    startedAt: new Date((current.active ? current.since : Date.now()) - current.spentMs)
      .toISOString(),
    durationMs: !current.active && current.spentMs > 0 ? current.spentMs : null,
  };
}
