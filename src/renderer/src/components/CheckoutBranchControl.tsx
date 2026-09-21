import {
  createContext,
  lazy,
  Suspense,
  useContext,
  type ReactNode,
} from "react";
import { GitBranch } from "lucide-react";
import type {
  Conversation,
  GitBranchInfo,
  GitStatusSnapshot,
  Project,
} from "@shared/contracts";

const CheckoutBranchMenuButton = lazy(() => import("./CheckoutBranchMenuButton"));

export interface CheckoutBranchControlModel {
  project: Project;
  conversation: Conversation | null;
  gitStatus: GitStatusSnapshot | null;
  branches: GitBranchInfo[];
  branchesLoading?: boolean;
  branchesError?: string | null;
  busy: boolean;
  respondsToHeaderRequests?: boolean;
  onRefreshBranches: () => void;
  onSwitchBranch: (name: string, remote?: boolean) => void | Promise<void>;
  onCreateBranch: (name: string) => void | Promise<void>;
  onCreateConversationOnBranch: (branch: string) => void;
  onCreateConversationInWorktree: () => void;
  onCreateConversationInIsolatedWorktree: () => void;
}

const CheckoutBranchControlContext = createContext<CheckoutBranchControlModel | null>(null);

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

function StaticCheckoutBranch({ branch }: { branch: string }): React.JSX.Element {
  return (
    <span className="composer-checkout-branch" title={branch}>
      <GitBranch size={12} aria-hidden="true" />
      <code translate="no">{branch}</code>
    </span>
  );
}

export function CheckoutBranchSlot({ branch }: { branch: string }): React.JSX.Element {
  const model = useContext(CheckoutBranchControlContext);
  const gitStatus = model?.gitStatus ?? null;
  if (!model || !gitStatus?.isRepository) return <StaticCheckoutBranch branch={branch} />;
  return (
    <Suspense fallback={<StaticCheckoutBranch branch={branch} />}>
      <CheckoutBranchMenuButton branch={branch} model={model} gitStatus={gitStatus} />
    </Suspense>
  );
}
