import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { FolderGit2, GitBranch, TriangleAlert } from "lucide-react";
import type { GitStatusSnapshot } from "@shared/contracts";

import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { conversationContextMismatch } from "../lib/newConversation";
import { onCheckoutBranchMenuRequest } from "../utils/checkoutBranchMenu";
import { checkoutBranchChip, ISOLATED_WORKTREE, type CheckoutBranchMenuOpener } from "./checkoutBranchChip";
import type { CheckoutBranchControlModel } from "./checkoutBranchControlModel";
import { SettingChevron } from "./composer/ComposerSettings";
import "./CheckoutBranchControl.css";

const WorkspaceBranchMenu = lazy(() => import("./WorkspaceBranchMenu"));

export default function CheckoutBranchMenuButton({
  branch,
  model,
  gitStatus,
  worktree = false,
  menuRef,
  fallbackAnchor,
}: {
  branch: string;
  model: CheckoutBranchControlModel;
  gitStatus: GitStatusSnapshot;
  worktree?: boolean;
  menuRef?: RefObject<CheckoutBranchMenuOpener | null>;
  fallbackAnchor?: () => HTMLButtonElement | null;
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const fallbackAnchorRef = useRef(fallbackAnchor);
  fallbackAnchorRef.current = fallbackAnchor;
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"branch">();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (menu !== "branch") return;
    const handleFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || anchorRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      dismissMenu("context-change");
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, [dismissMenu, menu]);
  useEffect(() => {
    if (menu !== "branch") return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const close = (): void => dismissMenu("context-change");
    const borrowed = anchor !== triggerRef.current;
    if (borrowed) anchor.addEventListener("pointerdown", close);
    const hidden = typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (anchor.getClientRects().length === 0) close();
        })
      : null;
    hidden?.observe(anchor);
    return () => {
      if (borrowed) anchor.removeEventListener("pointerdown", close);
      hidden?.disconnect();
    };
  }, [dismissMenu, menu]);
  useEffect(() => {
    dismissMenu("context-change");
  }, [dismissMenu, gitStatus.root, model.conversation?.id, model.project.id]);
  useNativePreviewSuspension(menu !== null);
  const refreshBranchesRef = useRef(model.onRefreshBranches);
  refreshBranchesRef.current = model.onRefreshBranches;
  const chip = checkoutBranchChip(
    branch,
    model,
    worktree,
    conversationContextMismatch(model.project, model.conversation, gitStatus) !== null,
  );
  const detached = chip.detached;

  const open = useCallback((): boolean => {
    const trigger = triggerRef.current;
    if (!trigger?.isConnected) return false;
    const anchor = trigger.getClientRects().length > 0 ? trigger : fallbackAnchorRef.current?.() ?? null;
    if (!anchor) return false;
    anchorRef.current = anchor;
    setMenuTrigger("branch", anchor);
    refreshBranchesRef.current();
    if (menu !== "branch") toggleMenu("branch");
    anchor.focus({ preventScroll: true });
    return true;
  }, [menu, setMenuTrigger, toggleMenu]);

  useEffect(() => {
    if (!model.respondsToHeaderRequests) return;
    return onCheckoutBranchMenuRequest(open);
  }, [model.respondsToHeaderRequests, open]);

  useEffect(() => {
    if (!menuRef) return;
    menuRef.current = open;
    return () => {
      if (menuRef.current === open) menuRef.current = null;
    };
  }, [menuRef, open]);

  useLayoutEffect(() => {
    if (menu !== "branch") {
      setPosition(null);
      return;
    }
    const place = (): void => {
      const bounds = (anchorRef.current ?? triggerRef.current)?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.min(380, window.innerWidth - 24);
      setPosition({
        left: `${Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12))}px`,
        bottom: `${Math.max(12, window.innerHeight - bounds.top + 4)}px`,
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [menu]);

  const label = detached
    ? "Detached HEAD, create or check out a branch"
    : chip.mismatch
      ? `Checkout context differs, current branch ${branch}`
      : `Branch ${branch}`;
  const Icon = detached ? TriangleAlert : worktree ? FolderGit2 : GitBranch;

  return (
    <span className="checkout-branch-anchor">
      <button
        ref={(node) => {
          triggerRef.current = node;
          if (!node) return;
          if (!anchorRef.current?.isConnected) anchorRef.current = node;
          setMenuTrigger("branch", anchorRef.current);
        }}
        type="button"
        className={`composer-checkout-branch checkout-branch-button composer-chip${detached ? " is-detached" : ""}`}
        aria-label={label}
        data-attention={chip.attention ? "true" : undefined}
        aria-description={worktree && !detached ? ISOLATED_WORKTREE : undefined}
        title={chip.title}
        aria-haspopup="menu"
        aria-expanded={menu === "branch"}
        aria-controls="workspace-header-branch-menu"
        onClick={(event) => {
          anchorRef.current = event.currentTarget;
          setMenuTrigger("branch", event.currentTarget);
          if (menu !== "branch") refreshBranchesRef.current();
          toggleMenu("branch");
        }}
      >
        <Icon className="composer-setting-icon" size={16} aria-hidden="true" />
        <code translate="no">{chip.text}</code>
        <SettingChevron />
      </button>
      {menu === "branch" && position && createPortal(
        <div
          ref={(node) => {
            popoverRef.current = node;
            setMenuPopover("branch", node);
          }}
          className="checkout-branch-portal"
          style={position}
        >
          <Suspense fallback={<div className="header-popover" role="status">Loading branches…</div>}>
            <WorkspaceBranchMenu
              project={model.project}
              conversation={model.conversation}
              gitStatus={gitStatus}
              branches={model.branches}
              branchesLoading={model.branchesLoading}
              branchesError={model.branchesError}
              busy={model.busy}
              onClose={() => dismissMenu("selection")}
              onRefreshBranches={model.onRefreshBranches}
              onSwitchBranch={model.onSwitchBranch}
              onCreateBranch={model.onCreateBranch}
              onCreateConversationInWorktree={model.onCreateConversationInWorktree}
              onCreateConversationOnBranch={model.onCreateConversationOnBranch}
              onCreateConversationInIsolatedWorktree={model.onCreateConversationInIsolatedWorktree}
            />
          </Suspense>
        </div>,
        document.body,
      )}
    </span>
  );
}
