import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  ArrowLeftRight,
  Columns2,
  GripVertical,
  PanelBottom,
  TerminalSquare,
  PictureInPicture2,
  Rows2,
  X,
} from "lucide-react";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { startChatDrag } from "../utils/chatDrag";
import {
  setSplitRatio,
  splitGeometry,
  splitLeaves,
  swapSplitPanes,
  toggleSplitAxis,
  type SplitHandle,
  type SplitLayout,
  type SplitPaneOwner,
  type SplitPaneRect,
} from "../utils/splitLayout";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { IconButton } from "./ui";

const GUTTER_PX = 7;
const POSITION_NAMES = ["Primary", "Second", "Third", "Fourth"];

export interface SplitPaneView {
  owner: SplitPaneOwner;
  content: ReactNode;
  title: string;
  projectName: string;
  conversationId?: string;
  toolsOpen: boolean;
  onToggleTools: () => void;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  onOpenInWindow?: () => void;
}

interface ConversationSplitViewProps {
  layout: SplitLayout;
  panes: readonly SplitPaneView[];
  onLayoutChange: (layout: SplitLayout) => void;
  onClosePane: (owner: SplitPaneOwner) => void;
}

function startPaneDrag(
  event: ReactPointerEvent<HTMLElement>,
  { conversationId, title }: { conversationId?: string; title: string },
): void {
  if (!conversationId || (event.target as Element).closest("button")) return;
  startChatDrag(event, { conversationId, title });
}

function placement(rect: SplitPaneRect): CSSProperties {
  const half = GUTTER_PX / 2;
  const left = rect.x > 0.001 ? half : 0;
  const right = rect.x + rect.width < 0.999 ? half : 0;
  const top = rect.y > 0.001 ? half : 0;
  const bottom = rect.y + rect.height < 0.999 ? half : 0;
  return {
    left: `calc(${rect.x * 100}% + ${left}px)`,
    top: `calc(${rect.y * 100}% + ${top}px)`,
    width: `calc(${rect.width * 100}% - ${left + right}px)`,
    height: `calc(${rect.height * 100}% - ${top + bottom}px)`,
  };
}

function focusPaneComposer(owner: SplitPaneOwner): void {
  window.setTimeout(() => {
    document.querySelector<HTMLElement>(
      `#${owner}-conversation-pane textarea`,
    )?.focus({ preventScroll: true });
  }, 0);
}

function SplitResizeFrame({
  handle,
  label,
  valueText,
  onChange,
  onCommit,
}: {
  handle: SplitHandle;
  label: string;
  valueText: (value: number) => string;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const frameRef = useRef<HTMLDivElement>(null);
  const style = {
    left: `${handle.rect.x * 100}%`,
    top: `${handle.rect.y * 100}%`,
    width: `${handle.rect.width * 100}%`,
    height: `${handle.rect.height * 100}%`,
    "--split-ratio": `${handle.ratio}%`,
  } as CSSProperties;
  return (
    <div
      ref={frameRef}
      className={`conversation-split-frame is-${handle.axis}`}
      style={style}
    >
      <PaneResizeHandle
        label={label}
        controls={[...handle.first, ...handle.second]
          .map((owner) => `${owner}-conversation-pane`)
          .join(" ")}
        containerRef={frameRef}
        orientation={handle.axis === "columns" ? "vertical" : "horizontal"}
        unit="percent"
        value={handle.ratio}
        min={30}
        max={70}
        defaultValue={50}
        onChange={onChange}
        onCommit={onCommit}
        valueText={valueText}
        className="conversation-split-resize-handle"
      />
    </div>
  );
}

export function ConversationSplitView({
  layout,
  panes,
  onLayoutChange,
  onClosePane,
}: ConversationSplitViewProps): React.JSX.Element {
  const [draft, setDraft] = useState<{ path: string; ratio: number } | null>(null);
  const narrow = useMediaQuery("(max-width: 860px)");
  const shown = draft ? setSplitRatio(layout, draft.path, draft.ratio) : layout;
  const stacked = narrow || ("axis" in layout && layout.axis === "rows");
  const { panes: rects, handles } = splitGeometry(shown, narrow);
  const order = splitLeaves(layout);
  const titleOf = (owner: SplitPaneOwner): string =>
    panes.find((pane) => pane.owner === owner)?.title ?? "chat";

  return (
    <main
      className={`conversation-split-view${stacked ? " is-stacked" : ""}`}
      aria-label="Split conversation workspace"
    >
      {panes.map((details) => {
        const rect = rects.get(details.owner);
        if (!rect) return null;
        const position = order.indexOf(details.owner);
        return (
          <section
            key={details.owner}
            className={`conversation-split-pane is-${position === 0 ? "primary" : "secondary"}-position`}
            id={`${details.owner}-conversation-pane`}
            data-split-pane-owner={details.owner}
            style={placement(rect)}
            aria-label={`${POSITION_NAMES[position]} chat: ${
              details.projectName
            } · ${details.title}`}
          >
            <header
              className={`conversation-split-header${
                details.conversationId ? " is-draggable" : ""
              }`}
              onPointerDown={(event) => startPaneDrag(event, details)}
            >
              {details.conversationId && (
                <GripVertical
                  size={12}
                  aria-hidden="true"
                  className="conversation-split-grip"
                />
              )}
              <span title={details.projectName}>{details.projectName}</span>
              <strong title={details.title}>{details.title}</strong>
              <span className="conversation-split-actions">
                {details.onOpenInWindow && (
                  <IconButton
                    label={`Open ${details.title} in a new window`}
                    onClick={details.onOpenInWindow}
                  >
                    <PictureInPicture2 size={14} />
                  </IconButton>
                )}
                <IconButton
                  label={`${details.terminalOpen ? "Close" : "Open"} terminal for ${
                    details.title
                  }`}
                  aria-pressed={details.terminalOpen}
                  onClick={details.onToggleTerminal}
                >
                  <TerminalSquare size={14} />
                </IconButton>
                <IconButton
                  label={`${details.toolsOpen ? "Close" : "Open"} tools for ${
                    details.title
                  }`}
                  aria-pressed={details.toolsOpen}
                  onClick={details.onToggleTools}
                >
                  <PanelBottom size={14} />
                </IconButton>
                {position === 1 && !narrow && (
                  <IconButton
                    label={stacked
                      ? "Place split chats side by side"
                      : "Stack split chats"}
                    onClick={() => onLayoutChange(toggleSplitAxis(layout))}
                  >
                    {stacked ? <Columns2 size={13} /> : <Rows2 size={13} />}
                  </IconButton>
                )}
                {position > 0 && (
                  <IconButton
                    label={`Move ${details.title} to the primary position`}
                    onClick={() => {
                      onLayoutChange(swapSplitPanes(layout, details.owner, order[0]!));
                      focusPaneComposer(details.owner);
                    }}
                  >
                    <ArrowLeftRight size={13} />
                  </IconButton>
                )}
                {details.owner !== "primary" && (
                  <IconButton
                    label={`Close split chat ${details.title}`}
                    onClick={() => {
                      onClosePane(details.owner);
                      window.setTimeout(() => {
                        const workspace = document.querySelector<HTMLElement>(
                          "#primary-conversation-pane .chat-workspace",
                        ) ?? document.querySelector<HTMLElement>(".chat-workspace");
                        const target = workspace?.querySelector<HTMLElement>("textarea")
                          ?? workspace?.querySelector<HTMLElement>(
                            "button:not([disabled]), [tabindex]:not([tabindex='-1'])",
                          );
                        if (workspace && !target) workspace.tabIndex = -1;
                        (target ?? workspace)?.focus({ preventScroll: true });
                      }, 0);
                    }}
                  >
                    <X size={14} />
                  </IconButton>
                )}
              </span>
            </header>
            <div className="conversation-split-content">{details.content}</div>
          </section>
        );
      })}

      {handles.map((handle) => {
        const root = handle.path === "";
        const firstTitle = handle.first.map(titleOf).join(" and ");
        return (
          <SplitResizeFrame
            key={handle.path || "root"}
            handle={handle}
            label={root
              ? "Resize split chats"
              : `Resize ${firstTitle} and ${handle.second.map(titleOf).join(" and ")}`}
            valueText={(value) => root
              ? `${value}% for the primary chat`
              : `${value}% for ${firstTitle}`}
            onChange={(ratio) => setDraft({ path: handle.path, ratio })}
            onCommit={(ratio) => {
              setDraft(null);
              onLayoutChange(setSplitRatio(layout, handle.path, ratio));
            }}
          />
        );
      })}
    </main>
  );
}
