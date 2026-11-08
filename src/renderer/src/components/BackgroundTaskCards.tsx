import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ChevronDown, Square } from "lucide-react";

import type { AgentTurn, SubagentTrace, WorkspaceRun } from "@shared/contracts";
import { useDocumentVisibility } from "../hooks/useDocumentPresence";
import { usePhaseLockedAnimations } from "../hooks/usePhaseLockedAnimations";
import { formatCompact } from "../lib/compactFormat";
import { formatCount } from "../lib/usageFormat";
import { backgroundCommandIsLive } from "../utils/backgroundTaskRuns";
import {
  backgroundCommandElapsedMs,
  backgroundCommandStateWord,
  backgroundTaskCurrentActivity,
  backgroundTaskDoingNow,
  backgroundTaskElapsedMs,
  backgroundTaskKind,
  backgroundTaskStateWord,
  backgroundTaskTitle,
  backgroundTaskTranscriptMeta,
  type BackgroundTaskStateWord,
} from "../utils/backgroundTasks";
import { formatElapsed } from "../utils/responseTimeline";
import { isLiveSubagentTrace } from "../utils/subagentDisclosure";
import { subagentAccessibleName, subagentModelLabel } from "../utils/subagentTaskPresentation";
import { SubagentElapsed, subscribeLiveElapsed } from "./SubagentElapsed";
import { TooltipButton } from "./TooltipButton";

function KindLine({
  kind,
  state,
  children,
}: {
  kind: string;
  state: BackgroundTaskStateWord | null;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span className="background-task-meta">
      <span className="background-task-value">
        {kind}
        {state && (
          <>
            {" · "}
            <span className={state.danger ? "background-task-danger" : undefined}>{state.word}</span>
          </>
        )}
      </span>
      {children}
    </span>
  );
}

function StopButton({
  name,
  stopping = false,
  onStop,
}: {
  name: string;
  stopping?: boolean;
  onStop: () => void;
}): React.JSX.Element {
  return (
    <TooltipButton
      className="background-task-stop"
      data-focus-key="stop"
      tooltip={stopping ? "Stopping" : "Stop"}
      describeTooltip={false}
      aria-label={`${stopping ? "Stopping" : "Stop"} ${name}`}
      disabled={stopping}
      onClick={onStop}
    >
      <Square size={14} aria-hidden="true" />
    </TooltipButton>
  );
}

function ClampedText({
  text,
  lines,
  label,
}: {
  text: string;
  lines: number;
  label: string;
}): React.JSX.Element {
  const id = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const toggleFocused = useRef(false);
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const shown = overflowing || open;
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || open) return;
    const measure = (): void => setOverflowing(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, text]);
  useLayoutEffect(() => {
    if (shown || !toggleFocused.current) return;
    toggleFocused.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    textRef.current?.closest("[data-focus-row]")
      ?.querySelector<HTMLElement>('[data-focus-key="transcript"]')?.focus();
  }, [shown]);
  return (
    <>
      <p
        ref={textRef}
        id={id}
        className="background-task-clamp"
        data-open={open ? "true" : undefined}
        style={{ "--clamp-lines": lines } as CSSProperties}
      >
        {text}
      </p>
      {shown && (
        <button
          type="button"
          className="background-task-link"
          aria-expanded={open}
          aria-controls={id}
          onFocus={() => { toggleFocused.current = true; }}
          onBlur={(event) => {
            const target = event.currentTarget;
            queueMicrotask(() => {
              if (target.isConnected) toggleFocused.current = false;
            });
          }}
          aria-label={`${open ? "Show less" : "Show more"} of ${label}`}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  );
}

function Transcript({
  id,
  trace,
  turns,
  title,
  name,
  line,
  canOpen,
  canFollowUp,
  onOpen,
  onFollowUp,
}: {
  id: string;
  trace: SubagentTrace;
  turns: readonly AgentTurn[];
  title: string;
  name: string;
  line: string | null;
  canOpen: boolean;
  canFollowUp: boolean;
  onOpen: () => void;
  onFollowUp: () => void;
}): React.JSX.Element {
  const live = isLiveSubagentTrace(trace);
  const reported = live ? trace.progress : trace.result;
  const update = reported === line ? null : reported;
  const task = trace.description?.trim() === title ? null : trace.description;
  const texts = live
    ? [[task, 4, "the task"], [update, 6, "the progress"]] as const
    : [[update, 6, "the outcome"], [task, 4, "the task"]] as const;
  const meta = backgroundTaskTranscriptMeta(trace, turns);
  return (
    <div id={id} className="background-task-transcript">
      {texts.map(([text, lines, label]) => text && (
        <ClampedText key={label} text={text} lines={lines} label={`${label} for ${name}`} />
      ))}
      {meta && <p>{meta}</p>}
      {(canOpen || canFollowUp) && (
        <div className="background-task-links">
          {canOpen && (
            <button
              type="button"
              className="background-task-link"
              data-focus-key="open"
              aria-label={`View turn for ${name}`}
              onClick={onOpen}
            >
              View turn
            </button>
          )}
          {canFollowUp && (
            <button
              type="button"
              className="background-task-link"
              data-focus-key="guide"
              aria-label={`Guide parent about ${name}`}
              onClick={onFollowUp}
            >
              Guide parent
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface AgentCardProps {
  trace: SubagentTrace;
  turns: readonly AgentTurn[];
  parentTitle: string | null;
  transcriptId: string;
  expanded: boolean;
  stopping: boolean;
  now?: number;
  canOpen: boolean;
  canFollowUp: boolean;
  canStop: boolean;
  canMoveToBackground?: boolean;
  moving?: boolean;
  onToggle: (traceId: string) => void;
  onOpen: (traceId: string) => void;
  onFollowUp: (traceId: string) => void;
  onStop: (traceId: string) => void;
  onMoveToBackground?: (traceId: string) => void;
}

export const AgentCard = memo(function AgentCard({
  trace,
  turns,
  parentTitle,
  transcriptId,
  expanded,
  stopping,
  now,
  canOpen,
  canFollowUp,
  canStop,
  canMoveToBackground = false,
  moving = false,
  onToggle,
  onOpen,
  onFollowUp,
  onStop,
  onMoveToBackground,
}: AgentCardProps): React.JSX.Element {
  const title = backgroundTaskTitle(trace);
  const name = subagentAccessibleName(trace);
  const cardRef = useRef<HTMLLIElement>(null);
  const moveHadFocus = useRef(false);
  const showsMove = canMoveToBackground && Boolean(onMoveToBackground);
  useLayoutEffect(() => {
    if (showsMove || !moveHadFocus.current) return;
    moveHadFocus.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) cardRef.current?.focus();
  }, [showsMove]);
  const doing = backgroundTaskDoingNow(trace);
  const live = isLiveSubagentTrace(trace);
  const running = live && (trace.status === "running" || trace.status === "spawned");
  const liveLineRef = usePhaseLockedAnimations<HTMLSpanElement>(running);
  const current = backgroundTaskCurrentActivity(trace);
  const line = expanded && current === null && doing === (live ? trace.progress : trace.result) ? null : doing;
  const elapsed = live ? 0 : backgroundTaskElapsedMs(trace, now ?? Date.now());
  const total = trace.usage?.totalTokens ?? null;
  const model = subagentModelLabel(trace);
  const facts = model !== null || total !== null || trace.toolUseCount !== null;
  return (
    <li ref={cardRef} className="background-task-card" tabIndex={-1} data-focus-row={`agent:${trace.id}`} data-reveal-turn={trace.turnId}>
      <div className="background-task-body">
        <span className="background-task-title">{title}</span>
        <KindLine
          kind={backgroundTaskKind(trace, parentTitle)}
          state={backgroundTaskStateWord(trace)}
        >
          {live
            ? <SubagentElapsed trace={trace} now={now} />
            : elapsed !== null && <span className="subagent-elapsed">{formatElapsed(elapsed)}</span>}
        </KindLine>
        {facts && (
          <span className="background-task-meta">
            {model && <span className="background-task-value">{model}</span>}
            {total !== null && (
              <span><span className="background-task-value">{formatCompact(total)}</span> tokens</span>
            )}
            {trace.toolUseCount !== null && (
              <span>
                <span className="background-task-value">{formatCount(trace.toolUseCount)}</span>
                {trace.toolUseCount === 1 ? " tool use" : " tool uses"}
              </span>
            )}
          </span>
        )}
      </div>
      {canStop && <StopButton name={name} stopping={stopping} onStop={() => onStop(trace.id)} />}
      <p className="background-task-doing">
        {line && <span ref={liveLineRef} className={running ? "background-task-line background-task-live" : "background-task-line"}>{line}</span>}
        <button
          type="button"
          className="background-task-link background-task-transcript-toggle"
          data-focus-key="transcript"
          aria-expanded={expanded}
          aria-controls={expanded ? transcriptId : undefined}
          aria-label={`View transcript for ${name}`}
          onClick={() => onToggle(trace.id)}
        >
          View transcript
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {showsMove && (
          <button
            type="button"
            className="background-task-link"
            data-focus-key="background"
            disabled={moving || stopping}
            aria-label={`Move ${name} to the background`}
            onFocus={() => { moveHadFocus.current = true; }}
            onBlur={(event) => {
              if (event.relatedTarget instanceof Element && event.relatedTarget.isConnected) moveHadFocus.current = false;
            }}
            onClick={() => onMoveToBackground?.(trace.id)}
          >
            Move to background
          </button>
        )}
      </p>
      {expanded && (
        <Transcript
          id={transcriptId}
          trace={trace}
          turns={turns}
          title={title}
          name={name}
          line={line}
          canOpen={canOpen}
          canFollowUp={canFollowUp}
          onOpen={() => onOpen(trace.id)}
          onFollowUp={() => onFollowUp(trace.id)}
        />
      )}
    </li>
  );
});

export interface CommandTaskCardProps {
  trace: SubagentTrace;
  parentTitle: string | null;
  stopping: boolean;
  now?: number;
  canStop: boolean;
  onStop: (traceId: string) => void;
}

/** A background command, monitor or MCP task the agent started. */
export const CommandTaskCard = memo(function CommandTaskCard({
  trace,
  parentTitle,
  stopping,
  now,
  canStop,
  onStop,
}: CommandTaskCardProps): React.JSX.Element {
  const title = backgroundTaskTitle(trace);
  const name = subagentAccessibleName(trace);
  const live = isLiveSubagentTrace(trace);
  const elapsed = live ? 0 : backgroundTaskElapsedMs(trace, now ?? Date.now());
  const showCommand = Boolean(trace.command && trace.description);
  const notice = live ? trace.progress : trace.result;
  return (
    <li className="background-task-card" data-focus-row={`agent:${trace.id}`} data-reveal-turn={trace.turnId} data-task-kind={trace.taskKind}>
      <div className="background-task-body">
        <span className={trace.description ? "background-task-title" : "background-task-title background-task-command"}>{title}</span>
        <KindLine kind={backgroundTaskKind(trace, parentTitle)} state={backgroundTaskStateWord(trace)}>
          {live
            ? <SubagentElapsed trace={trace} now={now} />
            : elapsed !== null && <span className="subagent-elapsed">{formatElapsed(elapsed)}</span>}
        </KindLine>
      </div>
      {canStop && <StopButton name={name} stopping={stopping} onStop={() => onStop(trace.id)} />}
      {showCommand && <p className="background-task-doing"><code className="background-task-command">{trace.command}</code></p>}
      {notice && <p className="background-task-doing"><span>{notice}</span></p>}
    </li>
  );
});

function CommandElapsed({
  run,
  now,
}: {
  run: WorkspaceRun;
  now?: number;
}): React.JSX.Element | null {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = backgroundCommandIsLive(run);
  const documentVisible = useDocumentVisibility();
  useEffect(() => {
    if (!live || now !== undefined || !documentVisible) return;
    return subscribeLiveElapsed(() => {
      const elapsed = backgroundCommandElapsedMs(run, Date.now());
      if (textRef.current && elapsed !== null) textRef.current.textContent = formatElapsed(elapsed);
    });
  }, [documentVisible, live, now, run]);
  const elapsed = backgroundCommandElapsedMs(run, now ?? Date.now());
  if (elapsed === null) return null;
  return <span ref={textRef} className="subagent-elapsed">{formatElapsed(elapsed)}</span>;
}

export const CommandCard = memo(function CommandCard({
  run,
  now,
  onStop,
}: {
  run: WorkspaceRun;
  now?: number;
  onStop?: (run: WorkspaceRun) => void;
}): React.JSX.Element {
  return (
    <li className="background-task-card" data-focus-row={`command:${run.id}`}>
      <div className="background-task-body">
        <span className="background-task-title">{run.label}</span>
        <KindLine kind="Command" state={backgroundCommandStateWord(run)}>
          <CommandElapsed run={run} now={now} />
        </KindLine>
      </div>
      {onStop && run.canStop && backgroundCommandIsLive(run) && (
        <StopButton name={run.label} onStop={() => onStop(run)} />
      )}
      {run.detail && <p className="background-task-doing"><span>{run.detail}</span></p>}
    </li>
  );
});
