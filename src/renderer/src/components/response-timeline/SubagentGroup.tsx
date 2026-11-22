import { memo, useContext, useEffect, useId, useMemo, useRef } from "react";
import { ChevronRight } from "lucide-react";
import clsx from "clsx";
import type { SubagentTrace } from "@shared/contracts";
import type { WorkspacePanelTab } from "../workspacePanelTypes";
import { requestBackgroundTaskReveal } from "../../utils/backgroundTaskReveal";
import { subagentReportedElapsedMs } from "../../utils/subagentDisclosure";
import { formatElapsed } from "../../utils/responseTimeline";
import {
  sameSubagentPanelTraces,
  subagentCountLabel,
  subagentGroupElapsedMs,
  subagentGroupSettledDone,
  subagentGroupSpan,
  subagentRowDetail,
  subagentRowName,
  subagentStatusWord,
  subagentTone,
  turnAgentStatus,
  turnAgentStatusParts,
  turnAgentStatusText,
} from "../../utils/turnAgentStatus";
import type { SubagentGroupEntry } from "../../utils/response-timeline/subagentGroups";
import { useDocumentVisibility } from "../../hooks/useDocumentPresence";
import { ProviderBrandIcon } from "../ProviderBrandIcon";
import { SubagentElapsed, subscribeLiveElapsed } from "../SubagentElapsed";
import { useLatestTurnSubagents } from "./subagent-trace-store";
import { UnlinkedSubagentRows } from "./SubagentActivityRow";
import { SubagentCallContext } from "./subagentCallContext";
import { setSubagentGroupOpen, useSubagentGroupOpen } from "./turn-fold-store";
import "./SubagentGroup.css";

const MAX_AVATARS = 3;

function focusFoldToggleAfterRemoval(turn: HTMLElement): void {
  queueMicrotask(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    if (!turn.isConnected) return;
    const toggle = turn.querySelector<HTMLElement>(".turn-fold-toggle");
    (toggle ?? turn).focus({ preventScroll: true });
  });
}

function keepFocusInTurnOnRemoval(node: HTMLElement | null): (() => void) | undefined {
  if (!node) return undefined;
  return () => {
    if (!node.contains(document.activeElement)) return;
    const turn = node.closest<HTMLElement>("[data-turn-id]");
    if (turn) focusFoldToggleAfterRemoval(turn);
  };
}

function SubagentAvatar({
  trace,
  withStatus = false,
}: {
  trace: SubagentTrace;
  withStatus?: boolean;
}): React.JSX.Element {
  return (
    <span className="subagent-avatar" data-subagent-tone={withStatus ? subagentTone(trace) : undefined}>
      <ProviderBrandIcon providerId={trace.providerId} size={16} decorative />
      {withStatus && (
        <>
          <span className="subagent-avatar-dot" aria-hidden="true" />
          <span className="visually-hidden">{subagentStatusWord(trace)}</span>
        </>
      )}
    </span>
  );
}

function SubagentGroupElapsed({ traces }: { traces: readonly SubagentTrace[] }): React.JSX.Element | null {
  const textRef = useRef<HTMLSpanElement>(null);
  const documentVisible = useDocumentVisibility();
  const span = useMemo(() => subagentGroupSpan(traces), [traces]);
  const startedAt = span?.startedAt ?? null;
  const live = span !== null && span.endedAt === null;
  useEffect(() => {
    if (startedAt === null || !live || !documentVisible) return;
    return subscribeLiveElapsed(() => {
      if (textRef.current) {
        textRef.current.textContent = formatElapsed(
          subagentGroupElapsedMs({ startedAt, endedAt: null }, Date.now()),
        );
      }
    });
  }, [documentVisible, live, startedAt]);
  if (!span) return null;
  return (
    <span ref={textRef} className="subagent-group-elapsed">
      {formatElapsed(subagentGroupElapsedMs(span, Date.now()))}
    </span>
  );
}

function SubagentRowElapsed({ trace }: { trace: SubagentTrace }): React.JSX.Element | null {
  if (trace.isLive) return <SubagentElapsed trace={trace} />;
  const elapsed = subagentReportedElapsedMs(trace, Date.now());
  return elapsed === null ? null : <span className="subagent-elapsed">{formatElapsed(elapsed)}</span>;
}

function SubagentRow({
  trace,
  onOpen,
}: {
  trace: SubagentTrace;
  onOpen?: (trace: SubagentTrace) => void;
}): React.JSX.Element {
  const detailId = useId();
  const name = subagentRowName(trace);
  const detail = subagentRowDetail(trace);
  const content = (
    <>
      <SubagentAvatar trace={trace} withStatus />
      <span className="subagent-group-agent-copy">
        <span className="subagent-group-agent-name">{name}</span>
        {detail && <span id={detailId} className="subagent-group-agent-detail">{detail}</span>}
      </span>
      <SubagentRowElapsed trace={trace} />
      {onOpen && <ChevronRight size={14} className="subagent-group-agent-chevron" aria-hidden="true" />}
    </>
  );
  if (!onOpen) {
    return (
      <div className="subagent-group-agent" data-subagent-tone={subagentTone(trace)}>
        {content}
      </div>
    );
  }
  return (
    <button
      ref={keepFocusInTurnOnRemoval}
      type="button"
      className="subagent-group-agent"
      data-subagent-tone={subagentTone(trace)}
      aria-label={`Open ${name} in Background tasks, ${subagentStatusWord(trace)}`}
      aria-describedby={detail ? detailId : undefined}
      data-background-task-origin=""
      onClick={() => onOpen(trace)}
    >
      {content}
    </button>
  );
}

interface SubagentGroupProps {
  conversationId: string;
  turnId: string;
  /** Keeps the open choice for one of a turn's groups; defaults to the turn. */
  groupId?: string;
  subagents: readonly SubagentTrace[];
  onOpenSurface?: (surface: WorkspacePanelTab) => void;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}

function SubagentGroupComponent({
  conversationId,
  turnId,
  groupId = turnId,
  subagents: renderedSubagents,
  onOpenSurface,
  onBeforeToggle,
  onAfterToggle,
}: SubagentGroupProps): React.JSX.Element | null {
  const panelId = useId();
  const open = useSubagentGroupOpen(groupId);
  const subagents = useLatestTurnSubagents(turnId, renderedSubagents, open);
  const status = turnAgentStatus(subagents);
  if (!status) return null;
  const count = subagentCountLabel(status);
  const statusText = turnAgentStatusText(status);
  const hidden = status.total - MAX_AVATARS;
  const toggle = (): void => {
    onBeforeToggle?.();
    setSubagentGroupOpen(groupId, !open);
    if (onAfterToggle) window.requestAnimationFrame(onAfterToggle);
  };
  const openTrace = onOpenSurface
    ? (trace: SubagentTrace): void => {
        requestBackgroundTaskReveal({ conversationId, turnId, traceId: trace.id });
        onOpenSurface("agents");
      }
    : undefined;
  return (
    <div
      ref={keepFocusInTurnOnRemoval}
      className={clsx("subagent-group", subagentGroupSettledDone(status) && "is-idle")}
      data-subagent-group={status.live > 0 ? "live" : "settled"}
    >
      <button
        type="button"
        className="subagent-group-row"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${count}, ${statusText}`}
        onClick={toggle}
      >
        <span className="subagent-group-avatars" aria-hidden="true">
          {subagents.slice(0, MAX_AVATARS).map((trace) => (
            <SubagentAvatar key={trace.id} trace={trace} />
          ))}
          {hidden > 0 && <span className="subagent-avatar is-overflow">{`+${hidden}`}</span>}
        </span>
        <span className="subagent-group-copy">
          <span className="subagent-group-title">{count}</span>
          <span className="subagent-group-status">
            {turnAgentStatusParts(status).map((part, index) => (
              <span key={part.tone} data-tone={part.tone}>
                {index > 0 && " · "}
                {part.text}
              </span>
            ))}
          </span>
        </span>
        <SubagentGroupElapsed traces={subagents} />
        <ChevronRight size={14} className="subagent-group-chevron" aria-hidden="true" />
      </button>
      <div id={panelId} className="subagent-group-panel" hidden={!open}>
        {open && (
          <ul className="subagent-group-list" aria-label="Subagents">
            {subagents.map((trace) => (
              <li key={trace.id}>
                <SubagentRow trace={trace} onOpen={openTrace} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function sameSubagentGroupProps(previous: SubagentGroupProps, next: SubagentGroupProps): boolean {
  return previous.conversationId === next.conversationId
    && previous.turnId === next.turnId
    && previous.groupId === next.groupId
    && previous.onOpenSurface === next.onOpenSurface
    && previous.onBeforeToggle === next.onBeforeToggle
    && previous.onAfterToggle === next.onAfterToggle
    && sameSubagentPanelTraces(previous.subagents, next.subagents);
}

export const SubagentGroup = memo(SubagentGroupComponent, sameSubagentGroupProps);

interface SubagentGroupBlockProps {
  entry: SubagentGroupEntry;
  onBeforeToggle?: () => void;
  onAfterToggle?: () => void;
}

/** The delegated tasks a turn started at one point of its transcript, drawn in that place. */
export function SubagentGroupBlock({
  entry,
  onBeforeToggle,
  onAfterToggle,
}: SubagentGroupBlockProps): React.JSX.Element {
  const { conversationId, onOpenSurface } = useContext(SubagentCallContext);
  return (
    <div data-subagent-group-block={entry.id}>
      <UnlinkedSubagentRows traces={entry.compact} onBeforeToggle={onBeforeToggle} onAfterToggle={onAfterToggle} />
      <SubagentGroup
        conversationId={conversationId}
        turnId={entry.turnId}
        groupId={entry.id}
        subagents={entry.traces}
        onOpenSurface={onOpenSurface}
        onBeforeToggle={onBeforeToggle}
        onAfterToggle={onAfterToggle}
      />
    </div>
  );
}
