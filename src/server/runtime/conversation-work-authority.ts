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
      left.localeCompare(right));
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
