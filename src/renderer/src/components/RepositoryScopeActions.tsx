import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Ellipsis, GitPullRequest, ShieldCheck } from "lucide-react";

import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import { navigateMenuItems } from "../utils/menuKeyboard";
import { FocusFirstMenuItem } from "./workspace-header/FocusFirstMenuItem";
import { useFocusOutDismiss } from "./workspace-header/useFocusOutDismiss";
import { IconButton } from "./ui";
import { HintButton } from "./HintButton";

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

export function useCollapsedActions(actions: HTMLElement | null): number {
  const [level, setLevel] = useState(0);
  const expandedWidths = useRef<number[]>([]);
  const levelRef = useRef(level);

  const changeLevel = useCallback((next: number): void => {
    levelRef.current = next;
    setLevel(next);
  }, []);

  const collapseIfOverflowing = useCallback((): void => {
    const row = actions?.parentElement;
    if (!actions || !row || levelRef.current >= 2) return;
    if (!overflowing(row) && !overflowing(actions)) return;
    expandedWidths.current[levelRef.current] = requiredRowWidth(row, actions);
    changeLevel(levelRef.current + 1);
  }, [actions, changeLevel]);

  useLayoutEffect(() => {
    const row = actions?.parentElement;
    if (!actions || !row || typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const current = levelRef.current;
      if (current > 0 && row.clientWidth >= (expandedWidths.current[current - 1] ?? Infinity)) {
        changeLevel(current - 1);
        return;
      }
      collapseIfOverflowing();
    });
    observer.observe(row);
    observer.observe(actions);
    const mutations = new MutationObserver(collapseIfOverflowing);
    mutations.observe(actions, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [actions, changeLevel, collapseIfOverflowing]);

  useLayoutEffect(collapseIfOverflowing);

  return level;
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
  commit: RepositoryScopeAction;
  actions: readonly RepositoryScopeAction[];
  confidence: { disabled: boolean; title: string };
  pullRequest: { disabled: boolean; title?: string };
  onRequestMergeDialog: (kind: MergeDialogRequest["kind"]) => void;
  children: (compact: boolean) => ReactNode;
}): React.JSX.Element {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const level = useCollapsedActions(element);
  const compact = level > 0;
  const commitFolded = level > 1;
  const menuId = useId();
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"more">();
  const moreTrigger = useRef<HTMLButtonElement | null>(null);
  const moreAnchor = useRef<HTMLSpanElement>(null);
  const dismissOnFocusOut = useCallback(() => dismissMenu("context-change"), [dismissMenu]);
  useFocusOutDismiss(moreAnchor, menu === "more", dismissOnFocusOut);
  const items: RepositoryScopeAction[] = [
    ...(commitFolded ? [commit] : []),
    ...actions,
    {
      id: "confidence",
      label: "Confidence",
      icon: <ShieldCheck size={14} aria-hidden="true" />,
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
      {!commitFolded && (
        <HintButton
          disabled={commit.disabled}
          hint={commit.title}
          onClick={commit.onSelect}
        >
          {commit.icon}<span>{commit.label}</span>
        </HintButton>
      )}
      {compact ? (
        <span ref={moreAnchor} className="workspace-repository-more-anchor">
          <IconButton
            ref={(node) => {
              moreTrigger.current = node;
              setMenuTrigger("more", node);
            }}
            label={`More actions for ${label}`}
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
              aria-label={`More actions for ${label}`}
              onKeyDown={(event) => navigateMenuItems(event)}
            >
              {items.map((item) => (
                <HintButton
                  role="menuitem"
                  key={item.id}
                  aria-disabled={item.disabled || undefined}
                  hint={item.title}
                  onClick={() => {
                    if (item.disabled) return;
                    dismissMenu("selection");
                    moreTrigger.current?.focus();
                    item.onSelect();
                  }}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </HintButton>
              ))}
              <FocusFirstMenuItem menuId={menuId} />
            </div>
          )}
        </span>
      ) : actions.map((action) => (
        <HintButton
          key={action.id}
          disabled={action.disabled}
          hint={action.title}
          onClick={action.onSelect}
        >
          {action.icon}<span>{action.label}</span>
        </HintButton>
      ))}
      {children(compact)}
    </span>
  );
}
