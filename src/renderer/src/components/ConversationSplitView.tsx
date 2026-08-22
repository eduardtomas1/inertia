import {
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowLeftRight, PanelBottom, PictureInPicture2, X } from "lucide-react";

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
  secondaryFirst: boolean;
  onTogglePrimaryTools: () => void;
  onToggleSecondaryTools: () => void;
  onSwapPanes: () => void;
  onCloseSecondary: () => void;
  onOpenPrimaryInWindow?: () => void;
  onOpenSecondaryInWindow?: () => void;
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
  secondaryFirst,
  onTogglePrimaryTools,
  onToggleSecondaryTools,
  onSwapPanes,
  onCloseSecondary,
  onOpenPrimaryInWindow,
  onOpenSecondaryInWindow,
}: ConversationSplitViewProps): React.JSX.Element {
  const [splitPercent, setSplitPercent] = useState(initialSplitPercent);
  const stacked = useMediaQuery("(max-width: 860px)");
  const containerRef = useRef<HTMLElement>(null);
  const style = {
    "--conversation-split-percent": `${splitPercent}%`,
  } as CSSProperties;
  const primaryPane = {
    owner: "primary",
    content: primary,
    title: primaryTitle,
    projectName: primaryProjectName,
    toolsOpen: primaryToolsOpen,
    onToggleTools: onTogglePrimaryTools,
    onOpenInWindow: onOpenPrimaryInWindow,
  } as const;
  const secondaryPane = {
    owner: "secondary",
    content: secondary,
    title: secondaryTitle,
    projectName: secondaryProjectName,
    toolsOpen: secondaryToolsOpen,
    onToggleTools: onToggleSecondaryTools,
    onOpenInWindow: onOpenSecondaryInWindow,
  } as const;

  const pane = (
    details: typeof primaryPane | typeof secondaryPane,
    position: "primary" | "secondary",
  ): React.JSX.Element => (
    <section
      className={`conversation-split-pane is-${position}-position`}
      id={`${details.owner}-conversation-pane`}
      aria-label={`${position === "primary" ? "Primary" : "Second"} chat: ${
        details.projectName
      } · ${details.title}`}
    >
      <header className="conversation-split-header">
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
            label={`${details.toolsOpen ? "Close" : "Open"} tools for ${
              details.title
            }`}
            aria-pressed={details.toolsOpen}
            onClick={details.onToggleTools}
          >
            <PanelBottom size={14} />
          </IconButton>
          {position === "secondary" && (
            <IconButton
              label={`Move ${details.title} to the primary position`}
              onClick={() => {
                onSwapPanes();
                const nextPrimaryOwner = details.owner;
                window.setTimeout(() => {
                  document.querySelector<HTMLElement>(
                    `#${nextPrimaryOwner}-conversation-pane textarea`,
                  )?.focus({ preventScroll: true });
                }, 0);
              }}
            >
              <ArrowLeftRight size={13} />
            </IconButton>
          )}
          {details.owner === "secondary" && (
            <IconButton
              label={`Close split chat ${details.title}`}
              onClick={() => {
                onCloseSecondary();
                window.setTimeout(() => {
                  const workspace = document.querySelector<HTMLElement>(
                    ".chat-workspace",
                  );
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

  return (
    <main
      ref={containerRef}
      className={`conversation-split-view${stacked ? " is-stacked" : ""}`}
      style={style}
      aria-label="Split conversation workspace"
    >
      {pane(
        primaryPane,
        secondaryFirst ? "secondary" : "primary",
      )}

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

      {pane(
        secondaryPane,
        secondaryFirst ? "primary" : "secondary",
      )}
    </main>
  );
}
