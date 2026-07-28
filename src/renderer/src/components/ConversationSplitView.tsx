import {
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowLeftRight, PanelBottom, X } from "lucide-react";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { PaneResizeHandle } from "./PaneResizeHandle";
import { IconButton } from "./ui";

const SPLIT_PERCENT_STORAGE_KEY =
  "inertia:layout:conversation-split-percent:v1";
const MIN_SPLIT_PERCENT = 30;
const MAX_SPLIT_PERCENT = 70;

function initialSplitPercent(): number {
  const parsed = Number.parseFloat(
    window.localStorage.getItem(SPLIT_PERCENT_STORAGE_KEY) ?? "",
  );
  return Number.isFinite(parsed)
    ? Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, parsed))
    : 50;
}

interface ConversationSplitViewProps {
  primary: ReactNode;
  secondary: ReactNode;
  primaryTitle: string;
  secondaryTitle: string;
  primaryProjectName: string;
  secondaryProjectName: string;
  primaryToolsOpen: boolean;
  secondaryToolsOpen: boolean;
  onTogglePrimaryTools: () => void;
  onToggleSecondaryTools: () => void;
  canMakeSecondaryPrimary?: boolean;
  makeSecondaryPrimaryUnavailableReason?: string;
  onMakeSecondaryPrimary: () => void;
  onCloseSecondary: () => void;
}

export function ConversationSplitView({
  primary,
  secondary,
  primaryTitle,
  secondaryTitle,
  primaryProjectName,
  secondaryProjectName,
  primaryToolsOpen,
  secondaryToolsOpen,
  onTogglePrimaryTools,
  onToggleSecondaryTools,
  canMakeSecondaryPrimary = true,
  makeSecondaryPrimaryUnavailableReason,
  onMakeSecondaryPrimary,
  onCloseSecondary,
}: ConversationSplitViewProps): React.JSX.Element {
  const [splitPercent, setSplitPercent] = useState(initialSplitPercent);
  const stacked = useMediaQuery("(max-width: 860px)");
  const containerRef = useRef<HTMLElement>(null);
  const style = {
    "--conversation-split-percent": `${splitPercent}%`,
  } as CSSProperties;

  return (
    <main
      ref={containerRef}
      className={`conversation-split-view${stacked ? " is-stacked" : ""}`}
      style={style}
      aria-label="Split conversation workspace"
    >
      <section
        className="conversation-split-pane is-primary"
        id="primary-conversation-pane"
        aria-label={`Primary chat: ${primaryProjectName} · ${primaryTitle}`}
      >
        <header className="conversation-split-header">
          <span title={primaryProjectName}>{primaryProjectName}</span>
          <strong title={primaryTitle}>{primaryTitle}</strong>
          <span className="conversation-split-actions">
            <IconButton
              label={`${primaryToolsOpen ? "Close" : "Open"} tools for ${primaryTitle}`}
              aria-pressed={primaryToolsOpen}
              onClick={onTogglePrimaryTools}
            >
              <PanelBottom size={14} />
            </IconButton>
          </span>
        </header>
        <div className="conversation-split-content">{primary}</div>
      </section>

      <PaneResizeHandle
        label="Resize split chats"
        controls="primary-conversation-pane secondary-conversation-pane"
        containerRef={containerRef}
        orientation={stacked ? "horizontal" : "vertical"}
        unit="percent"
        value={splitPercent}
        min={MIN_SPLIT_PERCENT}
        max={MAX_SPLIT_PERCENT}
        defaultValue={50}
        onChange={setSplitPercent}
        onCommit={(value) => {
          window.localStorage.setItem(
            SPLIT_PERCENT_STORAGE_KEY,
            String(value),
          );
        }}
        valueText={(value) => `${value}% for the primary chat`}
        className="conversation-split-resize-handle"
      />

      <section
        className="conversation-split-pane is-secondary"
        id="secondary-conversation-pane"
        aria-label={`Second chat: ${secondaryProjectName} · ${secondaryTitle}`}
      >
        <header className="conversation-split-header">
          <span title={secondaryProjectName}>{secondaryProjectName}</span>
          <strong title={secondaryTitle}>{secondaryTitle}</strong>
          <span className="conversation-split-actions">
            <IconButton
              label={`${secondaryToolsOpen ? "Close" : "Open"} tools for ${secondaryTitle}`}
              aria-pressed={secondaryToolsOpen}
              onClick={onToggleSecondaryTools}
            >
              <PanelBottom size={14} />
            </IconButton>
            <IconButton
              label={`Make ${secondaryTitle} the primary chat`}
              disabled={!canMakeSecondaryPrimary}
              title={!canMakeSecondaryPrimary
                ? makeSecondaryPrimaryUnavailableReason
                : undefined}
              onClick={() => {
                onMakeSecondaryPrimary();
                window.setTimeout(() => {
                  document.querySelector<HTMLElement>(
                    "#primary-conversation-pane textarea",
                  )?.focus({ preventScroll: true });
                }, 0);
              }}
            >
              <ArrowLeftRight size={13} />
            </IconButton>
            <IconButton
              label={`Close split chat ${secondaryTitle}`}
              onClick={() => {
                onCloseSecondary();
                window.setTimeout(() => {
                  document.querySelector<HTMLElement>(
                    ".chat-workspace textarea",
                  )?.focus({ preventScroll: true });
                }, 0);
              }}
            >
              <X size={14} />
            </IconButton>
          </span>
        </header>
        <div className="conversation-split-content">{secondary}</div>
      </section>
    </main>
  );
}
