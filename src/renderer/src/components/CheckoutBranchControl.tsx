import {
  createContext,
  lazy,
  Suspense,
  useContext,
  type ReactNode,
  type RefObject,
} from "react";
import { FolderGit2, GitBranch } from "lucide-react";

import {
  checkoutBranchChip,
  ISOLATED_WORKTREE,
  type CheckoutBranchMenuOpener,
} from "./checkoutBranchChip";
import type { CheckoutBranchControlModel } from "./checkoutBranchControlModel";

export type { CheckoutBranchControlModel } from "./checkoutBranchControlModel";

const CheckoutBranchMenuButton = lazy(() => import("./CheckoutBranchMenuButton"));

export const CheckoutBranchControlContext = createContext<CheckoutBranchControlModel | null>(null);

export function CheckoutBranchControlProvider({
  value,
  children,
}: {
  value: CheckoutBranchControlModel | null;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <CheckoutBranchControlContext.Provider value={value}>
      {children}
    </CheckoutBranchControlContext.Provider>
  );
}

function StaticCheckoutBranch({ branch, worktree }: { branch: string; worktree: boolean }): React.JSX.Element {
  const chip = checkoutBranchChip(branch, null, worktree);
  const Icon = worktree ? FolderGit2 : GitBranch;
  return (
    <span className="composer-checkout-branch composer-chip" title={chip.title}>
      <Icon className="composer-setting-icon" size={16} aria-hidden="true" />
      <code translate="no">{chip.text}</code>
      {worktree && <span className="visually-hidden">{`, ${ISOLATED_WORKTREE}`}</span>}
    </span>
  );
}

export function CheckoutBranchSlot({
  branch,
  worktree = false,
  menuRef,
  fallbackAnchor,
}: {
  branch: string;
  worktree?: boolean;
  menuRef?: RefObject<CheckoutBranchMenuOpener | null>;
  fallbackAnchor?: () => HTMLButtonElement | null;
}): React.JSX.Element {
  const model = useContext(CheckoutBranchControlContext);
  const gitStatus = model?.gitStatus ?? null;
  if (!model || !gitStatus?.isRepository) return <StaticCheckoutBranch branch={branch} worktree={worktree} />;
  return (
    <Suspense fallback={<StaticCheckoutBranch branch={branch} worktree={worktree} />}>
      <CheckoutBranchMenuButton
        branch={branch}
        model={model}
        gitStatus={gitStatus}
        worktree={worktree}
        menuRef={menuRef}
        fallbackAnchor={fallbackAnchor}
      />
    </Suspense>
  );
}
