import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

import { normalizeIdentityPath } from "../project-identity";

export interface ConversationWorkspaceIdentity {
  projectId: string;
  checkoutPath: string;
}

interface ReservedConversationWorkspace extends ConversationWorkspaceIdentity {
  checkoutIdentity: string;
  kind: "provider" | "workspace";
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

  release(reservationId: string): void {
    const workspace = this.workspaceByReservation.get(reservationId);
    if (!workspace) return;
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
