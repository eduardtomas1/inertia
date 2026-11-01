import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { normalizeIdentityPath } from "../project-identity";

export const CHECKOUT_RESTORE_IN_PROGRESS = "Files are being restored in this chat's checkout. Send again when the restore finishes.";

export interface ConversationWorkspaceIdentity {
  projectId: string;
  checkoutPath: string;
}

interface ReservedConversationWorkspace extends ConversationWorkspaceIdentity {
  checkoutIdentity: string;
  kind: "provider" | "workspace" | "exclusive";
}

interface CheckoutReservations {
  kind: ReservedConversationWorkspace["kind"];
  reservationIds: Set<string>;
}

function canonicalCheckoutIdentity(path: string): string {
  const target = resolve(path);
  let existing = target;
  while (true) {
    try {
      return normalizeIdentityPath(resolve(
        realpathSync.native(existing),
        relative(existing, target),
      ));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = resolve(existing, "..");
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export class ConversationWorkAuthority {
  private readonly workspaceByReservation = new Map<
    string,
    ReservedConversationWorkspace
  >();
  private readonly reservationsByCheckout = new Map<
    string,
    CheckoutReservations
  >();
  private readonly restoreClaims = new Set<string>();

  constructor(
    private readonly workspaceForConversation: (
      conversationId: string,
    ) => ConversationWorkspaceIdentity,
  ) {}

  reserve(conversationId: string): boolean {
    const workspace = this.workspaceForConversation(conversationId);
    return this.reserveIdentity(
      conversationId,
      workspace.projectId,
      workspace.checkoutPath,
      "provider",
    );
  }

  reserveAtCheckout(
    reservationId: string,
    projectId: string,
    checkoutPath: string,
  ): boolean {
    return this.reserveIdentity(
      reservationId,
      projectId,
      checkoutPath,
      "provider",
    );
  }

  reserveProviderCheckouts(
    reservationPrefix: string,
    workspaces: readonly ConversationWorkspaceIdentity[],
  ): string[] | null {
    const distinct = new Map<string, ConversationWorkspaceIdentity>();
    for (const workspace of workspaces) {
      const identity = canonicalCheckoutIdentity(workspace.checkoutPath);
      if (!distinct.has(identity)) distinct.set(identity, workspace);
    }
    const ordered = [...distinct.entries()].sort(([left], [right]) =>
      left.localeCompare(right, "en"));
    const reservations = ordered.map(([, workspace], index) => ({
      id: `${reservationPrefix}:${index}`,
      workspace,
    }));
    if (reservations.some(({ id, workspace }) => (
      this.workspaceByReservation.has(id)
      || this.hasCheckout(workspace.checkoutPath)
    ))) return null;

    const acquired: string[] = [];
    for (const { id, workspace } of reservations) {
      if (!this.reserveAtCheckout(
        id,
        workspace.projectId,
        workspace.checkoutPath,
      )) {
        for (const reservationId of acquired) this.release(reservationId);
        return null;
      }
      acquired.push(id);
    }
    return acquired;
  }

  providerReservationsExactlyCover(
    reservationIds: readonly string[],
    workspaces: readonly ConversationWorkspaceIdentity[],
  ): boolean {
    const expected = new Set(workspaces.map(({ checkoutPath }) =>
      canonicalCheckoutIdentity(checkoutPath)));
    if (reservationIds.length !== expected.size) return false;
    const actual = new Set<string>();
    for (const reservationId of reservationIds) {
      const reservation = this.workspaceByReservation.get(reservationId);
      if (!reservation || reservation.kind !== "provider") return false;
      actual.add(reservation.checkoutIdentity);
    }
    return actual.size === expected.size
      && [...actual].every((identity) => expected.has(identity));
  }

  reserveCheckout(
    reservationId: string,
    projectId: string,
    checkoutPath: string,
  ): boolean {
    return this.reserveIdentity(
      reservationId,
      projectId,
      checkoutPath,
      "workspace",
    );
  }

  /** Background checkout mutation must exclude work in nested project folders too. */
  reserveExclusiveCheckout(reservationId: string, projectId: string, checkoutPath: string): boolean {
    return this.reserveIdentity(reservationId, projectId, checkoutPath, "exclusive");
  }

  hasExclusiveCheckout(checkoutPath: string): boolean {
    const identity = canonicalCheckoutIdentity(checkoutPath);
    return [...this.workspaceByReservation.values()].some((reservation) =>
      reservation.kind === "exclusive" && overlappingCheckout(identity, reservation.checkoutIdentity));
  }

  claimRestoreCheckout(reservationId: string): boolean {
    const reservation = this.workspaceByReservation.get(reservationId);
    if (!reservation || reservation.kind !== "provider" || this.restoreClaims.has(reservationId)) return false;
    const checkout = this.reservationsByCheckout.get(reservation.checkoutIdentity);
    if (!checkout || checkout.reservationIds.size !== 1 || !checkout.reservationIds.has(reservationId)) return false;
    if ([...this.workspaceByReservation].some(([id, other]) =>
      id !== reservationId && overlappingCheckout(reservation.checkoutIdentity, other.checkoutIdentity))) return false;
    reservation.kind = "exclusive";
    checkout.kind = "exclusive";
    this.restoreClaims.add(reservationId);
    return true;
  }

  releaseRestoreCheckout(reservationId: string): void {
    if (!this.restoreClaims.delete(reservationId)) return;
    const reservation = this.workspaceByReservation.get(reservationId);
    if (!reservation) return;
    reservation.kind = "provider";
    const checkout = this.reservationsByCheckout.get(reservation.checkoutIdentity);
    if (checkout) checkout.kind = "provider";
  }

  restoreBlocksConversation(conversationId: string): boolean {
    if (this.restoreClaims.size === 0) return false;
    try {
      return this.hasRestoreClaim(this.workspaceForConversation(conversationId).checkoutPath);
    } catch {
      return true;
    }
  }

  hasRestoreClaim(checkoutPath: string): boolean {
    if (this.restoreClaims.size === 0) return false;
    const identity = canonicalCheckoutIdentity(checkoutPath);
    return [...this.restoreClaims].some((reservationId) => {
      const claim = this.workspaceByReservation.get(reservationId);
      return claim !== undefined && overlappingCheckout(identity, claim.checkoutIdentity);
    });
  }

  overlapsReservation(reservationId: string, checkoutPath: string): boolean {
    const reservation = this.workspaceByReservation.get(reservationId);
    if (!reservation) return true;
    try {
      return overlappingCheckout(canonicalCheckoutIdentity(checkoutPath), reservation.checkoutIdentity);
    } catch {
      return true;
    }
  }

  conversationOverlapsReservation(conversationId: string, reservationId: string): boolean {
    try {
      return this.overlapsReservation(reservationId, this.workspaceForConversation(conversationId).checkoutPath);
    } catch {
      return true;
    }
  }

  release(reservationId: string): void {
    const workspace = this.workspaceByReservation.get(reservationId);
    if (!workspace) return;
    this.restoreClaims.delete(reservationId);
    this.workspaceByReservation.delete(reservationId);
    const checkout = this.reservationsByCheckout.get(
      workspace.checkoutIdentity,
    );
    if (!checkout) return;
    checkout.reservationIds.delete(reservationId);
    if (checkout.reservationIds.size === 0) {
      this.reservationsByCheckout.delete(workspace.checkoutIdentity);
    }
  }

  hasConversation(conversationId: string): boolean {
    if (this.workspaceByReservation.has(conversationId)) return true;
    const workspace = this.workspaceForConversation(conversationId);
    return this.hasCheckout(workspace.checkoutPath);
  }

  isSoleProviderReservationAtConversationCheckout(
    reservationId: string,
    conversationId: string,
  ): boolean {
    const reservation = this.workspaceByReservation.get(reservationId);
    if (!reservation || reservation.kind !== "provider") return false;
    const workspace = this.workspaceForConversation(conversationId);
    const checkoutIdentity = canonicalCheckoutIdentity(workspace.checkoutPath);
    const checkout = this.reservationsByCheckout.get(checkoutIdentity);
    return reservation.checkoutIdentity === checkoutIdentity
      && checkout?.kind === "provider"
      && checkout.reservationIds.size === 1
      && checkout.reservationIds.has(reservationId);
  }

  hasCheckout(checkoutPath: string): boolean {
    return this.reservationsByCheckout.has(
      canonicalCheckoutIdentity(checkoutPath),
    );
  }

  conversationMatchesCheckout(
    conversationId: string,
    checkoutPath: string,
  ): boolean {
    const workspace = this.workspaceForConversation(conversationId);
    return canonicalCheckoutIdentity(workspace.checkoutPath)
      === canonicalCheckoutIdentity(checkoutPath);
  }

  hasProject(projectId: string): boolean {
    return [...this.workspaceByReservation.values()].some(
      (workspace) => workspace.projectId === projectId,
    );
  }

  clear(): void {
    this.restoreClaims.clear();
    this.workspaceByReservation.clear();
    this.reservationsByCheckout.clear();
  }

  private reserveIdentity(
    reservationId: string,
    projectId: string,
    checkoutPath: string,
    kind: ReservedConversationWorkspace["kind"],
  ): boolean {
    if (this.workspaceByReservation.has(reservationId)) return false;
    const checkoutIdentity = canonicalCheckoutIdentity(checkoutPath);
    if ([...this.workspaceByReservation.values()].some((reservation) =>
      (kind === "exclusive" || reservation.kind === "exclusive")
      && overlappingCheckout(checkoutIdentity, reservation.checkoutIdentity))) return false;
    const checkout = this.reservationsByCheckout.get(checkoutIdentity);
    if (checkout && (kind === "provider" || checkout.kind === "provider")) {
      return false;
    }
    this.workspaceByReservation.set(reservationId, {
      projectId,
      checkoutPath,
      checkoutIdentity,
      kind,
    });
    if (checkout) {
      checkout.reservationIds.add(reservationId);
    } else {
      this.reservationsByCheckout.set(checkoutIdentity, {
        kind,
        reservationIds: new Set([reservationId]),
      });
    }
    return true;
  }
}

function overlappingCheckout(left: string, right: string): boolean {
  const contained = (root: string, path: string): boolean => {
    const child = relative(root, path);
    return !child || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
  };
  return contained(left, right) || contained(right, left);
}
