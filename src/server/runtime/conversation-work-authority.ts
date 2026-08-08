import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

import { normalizeIdentityPath } from "../project-identity";

export interface ConversationWorkspaceIdentity {
  projectId: string;
  checkoutPath: string;
}

interface ReservedConversationWorkspace extends ConversationWorkspaceIdentity {
  checkoutIdentity: string;
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
  private readonly workspaceByConversation = new Map<
    string,
    ReservedConversationWorkspace
  >();
  private readonly conversationByCheckout = new Map<string, string>();

  constructor(
    private readonly workspaceForConversation: (
      conversationId: string,
    ) => ConversationWorkspaceIdentity,
  ) {}

  reserve(conversationId: string): boolean {
    if (this.workspaceByConversation.has(conversationId)) return false;
    const workspace = this.workspaceForConversation(conversationId);
    const checkoutIdentity = canonicalCheckoutIdentity(
      workspace.checkoutPath,
    );
    if (this.conversationByCheckout.has(checkoutIdentity)) return false;
    this.workspaceByConversation.set(conversationId, {
      ...workspace,
      checkoutIdentity,
    });
    this.conversationByCheckout.set(checkoutIdentity, conversationId);
    return true;
  }

  release(conversationId: string): void {
    const workspace = this.workspaceByConversation.get(conversationId);
    if (!workspace) return;
    this.workspaceByConversation.delete(conversationId);
    if (
      this.conversationByCheckout.get(workspace.checkoutIdentity)
      === conversationId
    ) {
      this.conversationByCheckout.delete(workspace.checkoutIdentity);
    }
  }

  hasConversation(conversationId: string): boolean {
    if (this.workspaceByConversation.has(conversationId)) return true;
    const workspace = this.workspaceForConversation(conversationId);
    return this.hasCheckout(workspace.checkoutPath);
  }

  hasCheckout(checkoutPath: string): boolean {
    return this.conversationByCheckout.has(
      canonicalCheckoutIdentity(checkoutPath),
    );
  }

  hasProject(projectId: string): boolean {
    return [...this.workspaceByConversation.values()].some(
      (workspace) => workspace.projectId === projectId,
    );
  }

  clear(): void {
    this.workspaceByConversation.clear();
    this.conversationByCheckout.clear();
  }
}
