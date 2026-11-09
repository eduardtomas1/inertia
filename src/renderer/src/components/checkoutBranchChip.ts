import { middleTruncate } from "../utils/middleTruncate";
import type { CheckoutBranchControlModel } from "./checkoutBranchControlModel";

export const CHECKOUT_BRANCH_CHIP_CHARACTERS = 16;
export const ISOLATED_WORKTREE = "Isolated worktree";
export const DETACHED_HEAD_CHIP = "Detached HEAD · Create branch";

export type CheckoutBranchMenuOpener = () => boolean;

export interface CheckoutBranchChip {
  text: string;
  title: string;
  detached: boolean;
  mismatch: boolean;
  interactive: boolean;
  attention: string | null;
}

export function checkoutBranchChip(
  branch: string,
  model: CheckoutBranchControlModel | null,
  worktree: boolean,
  mismatch = false,
): CheckoutBranchChip {
  const gitStatus = model?.gitStatus ?? null;
  const interactive = Boolean(model && gitStatus?.isRepository);
  const short = middleTruncate(branch, CHECKOUT_BRANCH_CHIP_CHARACTERS);
  const located = worktree ? `${ISOLATED_WORKTREE} · ${branch}` : branch;
  if (!model || !gitStatus || !interactive) {
    return { text: short, title: located, detached: false, mismatch: false, interactive, attention: null };
  }
  if (gitStatus.branch === null) {
    return {
      text: DETACHED_HEAD_CHIP,
      title: DETACHED_HEAD_CHIP,
      detached: true,
      mismatch: false,
      interactive,
      attention: "Detached HEAD",
    };
  }
  if (mismatch) {
    return {
      text: `Current checkout · ${short}`,
      title: `Current checkout · ${located}`,
      detached: false,
      mismatch: true,
      interactive,
      attention: "Checkout context differs",
    };
  }
  return { text: short, title: located, detached: false, mismatch: false, interactive, attention: null };
}
