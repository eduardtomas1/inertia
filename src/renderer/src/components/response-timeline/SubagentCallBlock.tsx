import { memo, useContext, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import { CustomAgentAvatar, customAgentTintStyle } from "../custom-agents/CustomAgentAvatar";
import { ResponseMarkdown } from "../ResponseMarkdown";
import { SubagentElapsed } from "../SubagentElapsed";
import { SubagentStatusMark } from "../SubagentStatusMark";
import {
  isLiveSubagentTrace,
  subagentStatusLabel,
  subagentTraceLabel,
} from "../../utils/subagentDisclosure";
import { formatElapsed } from "../../utils/response-timeline/timing";
import {
  sameSubagentCallEntry,
  subagentCallLine,
  subagentCallMeta,
  type SubagentCallEntry,
} from "../../utils/response-timeline/subagentCalls";
import { SubagentCallContext } from "./subagentCallContext";
import "./SubagentCallBlock.css";

interface SubagentCallBlockProps {
  entry: SubagentCallEntry;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}

function SubagentCallBlockComponent({
  entry,
  onBeforeToggle,
  onAfterToggle,
}: SubagentCallBlockProps): React.JSX.Element {
  const context = useContext(SubagentCallContext);
  const { trace, agent } = entry;
  const live = isLiveSubagentTrace(trace);
  const [remembered] = useState(() => context.memory?.read(trace.id));
  const [expanded, setExpanded] = useState(() => remembered?.expanded ?? (live || !context.autoCollapse));
  const [opened, setOpened] = useState(expanded);
  const [stopping, setStopping] = useState(false);
  const [settled, setSettled] = useState(false);
  const wasLive = useRef(remembered?.live ?? live);
  const seenAutoCollapse = useRef(context.autoCollapse);
  const bodyId = useId();
  useLayoutEffect(() => {
    if (seenAutoCollapse.current !== context.autoCollapse) {
      seenAutoCollapse.current = context.autoCollapse;
      setExpanded(live || !context.autoCollapse);
      if (live || !context.autoCollapse) setOpened(true);
    } else if (wasLive.current && !live && context.autoCollapse && trace.status === "completed") setExpanded(false);
    if (!wasLive.current && live) {
      setExpanded(true);
      setOpened(true);
      setSettled(false);
    }
    if (wasLive.current && !live) setSettled(true);
    wasLive.current = live;
  }, [context.autoCollapse, live, trace.status]);
  useLayoutEffect(() => {
    context.memory?.write(trace.id, { expanded, live });
  }, [context.memory, expanded, live, trace.id]);
  const toggle = (): void => {
    onBeforeToggle?.();
    setExpanded((current) => !current);
    setOpened(true);
    window.requestAnimationFrame(() => onAfterToggle?.());
  };
  const stop = (): void => {
    const onStop = context.onStopSubagent;
    if (!onStop || stopping) return;
    setStopping(true);
    void onStop(trace).catch(() => undefined).finally(() => setStopping(false));
  };
  const line = subagentCallLine(trace, live);
  const liveActivity = live ? trace.activity ?? trace.progress : null;
  const meta = subagentCallMeta(trace, formatElapsed);
  const canStop = entry.canStop && Boolean(context.onStopSubagent);
  const tint = customAgentTintStyle(agent.accent);
  const settledDuration = !live && trace.durationMs != null ? formatElapsed(trace.durationMs) : null;
  return (
    <section
      className={clsx("subagent-call", tint && "has-agent-tint", !remembered && "is-entering")}
      style={tint}
      data-subagent-call={trace.id}
      data-live={live ? "true" : "false"}
      data-status={trace.status}
      data-stopping={stopping && live ? "true" : undefined}
      data-settled={settled ? "true" : undefined}
      data-expanded={expanded ? "true" : "false"}
      aria-label={`Called agent ${agent.name}`}
    >
      <button
        type="button"
        className="subagent-call-header"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={toggle}
      >
        <CustomAgentAvatar agent={agent} size={agent.icon.kind === "mark" ? 36 : 32} live={live} />
        <span className="subagent-call-title">
          <strong>{agent.name}</strong>
          <span className="subagent-call-line" data-tone={line?.tone}>
            {expanded ? trace.description : line?.text ?? trace.description}
          </span>
        </span>
        <span className="subagent-call-state">
          <SubagentStatusMark trace={trace} />
          <span className="subagent-call-status">{subagentStatusLabel(trace)}</span>
        </span>
        <span className="subagent-call-time">
          {settledDuration
            ? <span className="subagent-elapsed">{settledDuration}</span>
            : <SubagentElapsed trace={trace} />}
        </span>
        <ChevronRight size={14} className="subagent-call-chevron" aria-hidden="true" />
      </button>
      <div className="subagent-call-fold" data-open={expanded ? "true" : "false"}>
        <div
          id={bodyId}
          className="subagent-call-body"
          aria-hidden={!expanded || undefined}
          inert={!expanded || undefined}
        >
          {liveActivity && <p className="subagent-call-activity" data-tone="live">{liveActivity}</p>}
          {!live && line && line.tone !== "done" && (
            <p className="subagent-call-activity" data-tone={line.tone}>{line.text}</p>
          )}
          {opened && trace.result && (
            <div className="subagent-call-result">
              <ResponseMarkdown
                content={trace.result}
                projectRoot={context.projectRoot}
                projectId={context.projectId}
                conversationId={context.conversationId}
                defaultCodeWrap={context.defaultCodeWrap}
                announceCopyFeedback={false}
                onOpenProjectFile={context.onOpenProjectFile}
              />
            </div>
          )}
          {entry.children.length > 0 && (
            <ul className="subagent-call-children" aria-label={`Agents started by ${agent.name}`}>
              {entry.children.map((child) => (
                <li
                  key={child.trace.id}
                  className="subagent-call-child"
                  style={{ paddingInlineStart: `${child.depth * 14}px` }}
                >
                  <SubagentStatusMark trace={child.trace} />
                  <span className="subagent-call-child-name">{subagentTraceLabel(child.trace)}</span>
                  <small>
                    {subagentStatusLabel(child.trace)}
                    <span aria-hidden="true"> · </span>
                    <SubagentElapsed trace={child.trace} />
                  </small>
                </li>
              ))}
            </ul>
          )}
          {(meta || canStop) && (
            <div className="subagent-call-meta">
              {meta && <small>{meta}</small>}
              {canStop && (
                <button
                  type="button"
                  className="subagent-call-stop"
                  aria-label={`${stopping ? "Stopping" : "Stop"} ${agent.name}`}
                  aria-busy={stopping || undefined}
                  disabled={stopping}
                  onClick={stop}
                >
                  {stopping ? "Stopping" : "Stop"}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export const SubagentCallBlock = memo(
  SubagentCallBlockComponent,
  (previous, next) => sameSubagentCallEntry(previous.entry, next.entry)
    && previous.onBeforeToggle === next.onBeforeToggle
    && previous.onAfterToggle === next.onAfterToggle,
);

export function SubagentCallList({
  entries,
  onBeforeToggle,
  onAfterToggle,
}: {
  entries: readonly SubagentCallEntry[];
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <div className="subagent-call-list" role="list" aria-label="Called agents">
      {entries.map((entry) => (
        <div role="listitem" key={entry.id}>
          <SubagentCallBlock entry={entry} onBeforeToggle={onBeforeToggle} onAfterToggle={onAfterToggle} />
        </div>
      ))}
    </div>
  );
}
