import {
  createContext,
  lazy,
  Suspense,
  useContext,
  type ReactNode,
} from "react";
import { GitBranch } from "lucide-react";

import type { CheckoutBranchControlModel } from "./checkoutBranchControlModel";

export type { CheckoutBranchControlModel } from "./checkoutBranchControlModel";

const CheckoutBranchMenuButton = lazy(() => import("./CheckoutBranchMenuButton"));

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
