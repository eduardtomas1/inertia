import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, GitBranch, TriangleAlert } from "lucide-react";
import type { GitStatusSnapshot } from "@shared/contracts";

import { useDismissibleMenu } from "../hooks/useDismissibleMenu";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { conversationContextMismatch } from "../lib/newConversation";
import { onCheckoutBranchMenuRequest } from "../utils/checkoutBranchMenu";
import type { CheckoutBranchControlModel } from "./checkoutBranchControlModel";
import "./CheckoutBranchControl.css";

const WorkspaceBranchMenu = lazy(() => import("./WorkspaceBranchMenu"));

export default function CheckoutBranchMenuButton({
  branch,
  model,
  gitStatus,
}: {
  branch: string;
  model: CheckoutBranchControlModel;
  gitStatus: GitStatusSnapshot;
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const { menu, toggleMenu, dismissMenu, setMenuTrigger, setMenuPopover } =
    useDismissibleMenu<"branch">();
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (menu !== "branch") return;
    const handleFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      dismissMenu("context-change");
    };
    document.addEventListener("focusin", handleFocusIn);
    return () => document.removeEventListener("focusin", handleFocusIn);
  }, [dismissMenu, menu]);
  useEffect(() => {
    dismissMenu("context-change");
  }, [dismissMenu, gitStatus.root, model.conversation?.id, model.project.id]);
  useNativePreviewSuspension(menu !== null);
  const refreshBranchesRef = useRef(model.onRefreshBranches);
  refreshBranchesRef.current = model.onRefreshBranches;
  const detached = gitStatus.branch === null;
  const contextMismatch = conversationContextMismatch(model.project, model.conversation, gitStatus);

  const open = useCallback((): boolean => {
    if (!triggerRef.current?.isConnected) return false;
    refreshBranchesRef.current();
    if (menu !== "branch") toggleMenu("branch");
    triggerRef.current.focus({ preventScroll: true });
    return true;
  }, [menu, toggleMenu]);

  useEffect(() => {
    if (!model.respondsToHeaderRequests) return;
    return onCheckoutBranchMenuRequest(open);
  }, [model.respondsToHeaderRequests, open]);

  useLayoutEffect(() => {
    if (menu !== "branch") {
      setPosition(null);
      return;
    }
    const place = (): void => {
      const bounds = triggerRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const width = Math.min(380, window.innerWidth - 24);
      setPosition({
        left: `${Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12))}px`,
        bottom: `${Math.max(12, window.innerHeight - bounds.top + 8)}px`,
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [menu]);

  const label = detached
    ? "Detached HEAD, create or check out a branch"
    : contextMismatch
      ? `Checkout context differs, current branch ${branch}`
      : `Branch ${branch}`;

  return (
    <span className="checkout-branch-anchor">
      <button
        ref={(node) => {
          triggerRef.current = node;
          setMenuTrigger("branch", node);
        }}
        type="button"
        className={`composer-checkout-branch checkout-branch-button${detached ? " is-detached" : ""}${contextMismatch ? " has-context-mismatch" : ""}`}
        aria-label={label}
        title={detached ? "Detached HEAD · Create branch" : branch}
        aria-haspopup="menu"
        aria-expanded={menu === "branch"}
        aria-controls="workspace-header-branch-menu"
        onClick={() => {
          if (menu !== "branch") refreshBranchesRef.current();
          toggleMenu("branch");
        }}
      >
        {detached
          ? <TriangleAlert size={12} aria-hidden="true" />
          : <GitBranch size={12} aria-hidden="true" />}
        <code translate="no">{detached ? "Detached HEAD · Create branch" : branch}</code>
        {contextMismatch && <span className="checkout-context-dot" aria-hidden="true" />}
        <ChevronDown size={11} aria-hidden="true" className="checkout-branch-chevron" />
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
