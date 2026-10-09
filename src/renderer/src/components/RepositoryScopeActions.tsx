import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Ellipsis, GitPullRequest } from "lucide-react";

import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import { navigateMenuItems } from "../utils/menuKeyboard";
import { FocusFirstMenuItem } from "./workspace-header/FocusFirstMenuItem";
import { IconButton } from "./ui";

export interface RepositoryScopeAction {
  id: string;
  label: string;
  icon: ReactNode;
  disabled: boolean;
  title?: string;
  onSelect: () => void;
}

export type MergeDialogRequest = { kind: "confidence" | "pull-request"; id: number };

export function confidenceTitle(authorityRef: string | undefined, forge: string | undefined): string {
  return !authorityRef
    ? "Refresh this repository before loading remote evidence."
    : forge !== "github"
      ? "Exact-head confidence is currently available for GitHub repositories."
      : "Compare this local head with authoritative GitHub checks, reviews, and merge state.";
}

function overflowing(element: Element): boolean {
  return element.scrollWidth > element.clientWidth + 1;
}

function requiredRowWidth(row: Element, actions: Element): number {
  return Math.max(row.scrollWidth, row.clientWidth - actions.clientWidth + actions.scrollWidth);
}

export function useCollapsedActions(actions: HTMLElement | null): boolean {
  const [compact, setCompact] = useState(false);
  const expandedWidth = useRef(0);
  const compactRef = useRef(compact);

  const collapseIfOverflowing = useCallback((): void => {
    const row = actions?.parentElement;
    if (!actions || !row || compactRef.current) return;
    if (!overflowing(row) && !overflowing(actions)) return;
    expandedWidth.current = requiredRowWidth(row, actions);
    compactRef.current = true;
    setCompact(true);
  }, [actions]);

  useLayoutEffect(() => {
    const row = actions?.parentElement;
    if (!actions || !row || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (compactRef.current && row.clientWidth >= expandedWidth.current) {
        compactRef.current = false;
        setCompact(false);
        return;
      }
      collapseIfOverflowing();
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [actions, collapseIfOverflowing]);

  useLayoutEffect(collapseIfOverflowing);

  return compact;
}

export function RepositoryScopeActions({
  label,
  commit,
  actions,
  confidence,
  pullRequest,
  onRequestMergeDialog,
  children,
}: {
  label: string;
  commit: ReactNode;
  actions: readonly RepositoryScopeAction[];
  confidence: { disabled: boolean; title: string };
  pullRequest: { disabled: boolean; title?: string };
  onRequestMergeDialog: (kind: MergeDialogRequest["kind"]) => void;
  children: (compact: boolean) => ReactNode;
}): React.JSX.Element {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const compact = useCollapsedActions(element);
  const menuId = useId();
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"more">();
  const items: RepositoryScopeAction[] = [
    ...actions,
    {
      id: "confidence",
      label: "Confidence",
      icon: <GitPullRequest size={14} aria-hidden="true" />,
      disabled: confidence.disabled,
      title: confidence.title,
      onSelect: () => onRequestMergeDialog("confidence"),
    },
    {
      id: "pull-request",
      label: "PR",
      icon: <GitPullRequest size={14} aria-hidden="true" />,
      disabled: pullRequest.disabled,
      ...(pullRequest.title ? { title: pullRequest.title } : {}),
      onSelect: () => onRequestMergeDialog("pull-request"),
    },
  ];

  return (
    <span
      ref={setElement}
      className={`workspace-repository-scope-actions${compact ? " is-compact" : ""}`}
      aria-label={`Actions for ${label}`}
    >
      {commit}
      {compact ? (
        <span className="workspace-repository-more-anchor">
          <IconButton
            ref={(node) => setMenuTrigger("more", node)}
            label="More Git actions"
            aria-haspopup="menu"
            aria-expanded={menu === "more"}
            aria-controls={menuId}
            onClick={() => toggleMenu("more")}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </IconButton>
          {menu === "more" && (
            <div
              ref={(node) => setMenuPopover("more", node)}
              id={menuId}
              className="header-popover workspace-repository-more-menu"
              role="menu"
              aria-label="More Git actions"
              onKeyDown={(event) => navigateMenuItems(event, '[role="menuitem"]:not([aria-disabled="true"])')}
            >
              {items.map((item) => (
                <button
                  type="button"
                  role="menuitem"
                  key={item.id}
                  aria-disabled={item.disabled || undefined}
                  title={item.title}
                  onClick={() => {
                    if (item.disabled) return;
                    dismissMenu("context-change");
                    item.onSelect();
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
              <FocusFirstMenuItem menuId={menuId} />
            </div>
          )}
        </span>
      ) : actions.map((action) => (
        <button
          type="button"
          key={action.id}
          disabled={action.disabled}
          title={action.title}
          onClick={action.onSelect}
        >
          {action.icon}<span>{action.label}</span>
        </button>
      ))}
      {children(compact)}
    </span>
  );
}
