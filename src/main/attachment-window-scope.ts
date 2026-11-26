import type { DesktopWindowContext } from "../shared/desktop.js";
import type { AttachmentRegistry } from "./attachment-registry.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";

export type AttachmentWindowOwner =
  | { readonly kind: "main" }
  | { readonly kind: "detached-chat"; readonly conversationId: string };

export interface AttachmentPreviewScopePolicy {
  readonly allowTemporary?: () => boolean;
  readonly allowRetained?: () => Promise<boolean> | boolean;
}

const MAX_TRACKED_ENTRIES = 1_024;

export function attachmentWindowOwnerForContext(
  context: DesktopWindowContext,
): AttachmentWindowOwner {
  return context.role === "detached-chat"
    ? { kind: "detached-chat", conversationId: context.conversationId }
    : { kind: "main" };
}

export class AttachmentWindowScopeTracker {
  private readonly attachments = new Map<string, AttachmentWindowOwner>();
  private readonly handoffs = new Map<string, AttachmentWindowOwner>();

  recordAttachment(attachmentId: string, owner: AttachmentWindowOwner): void {
    this.attachments.delete(attachmentId);
    this.attachments.set(attachmentId, owner);
    this.trim(this.attachments);
  }

  recordAttachments(
    attachmentIds: readonly string[],
    owner: AttachmentWindowOwner,
  ): void {
    for (const attachmentId of attachmentIds) {
      this.recordAttachment(attachmentId, owner);
    }
  }

  forgetAttachment(attachmentId: string): void {
    this.attachments.delete(attachmentId);
  }

  ownsTemporaryAttachment(
    attachmentId: string,
    conversationScope: string,
  ): boolean {
    const owner = this.attachments.get(attachmentId);
    return owner?.kind === "detached-chat"
      && owner.conversationId === conversationScope;
  }

  canAccessTemporaryAttachment(
    attachmentId: string,
    context: DesktopWindowContext,
  ): boolean {
    if (context.role !== "detached-chat") return true;
    return this.ownsTemporaryAttachment(attachmentId, context.conversationId);
  }

  recordHandoff(requestId: string, owner: AttachmentWindowOwner): void {
    this.handoffs.delete(requestId);
    this.handoffs.set(requestId, owner);
    this.trim(this.handoffs);
  }

  forgetHandoff(requestId: string): void {
    this.handoffs.delete(requestId);
  }

  canFinishHandoff(requestId: string, context: DesktopWindowContext): boolean {
    if (context.role !== "detached-chat") return true;
    const owner = this.handoffs.get(requestId);
    return owner?.kind === "detached-chat"
      && owner.conversationId === context.conversationId;
  }

  private trim(map: Map<string, AttachmentWindowOwner>): void {
    while (map.size > MAX_TRACKED_ENTRIES) {
      const oldest = map.keys().next().value;
      if (typeof oldest !== "string") break;
      map.delete(oldest);
    }
  }
}

const trackers = new WeakMap<AttachmentRegistry, AttachmentWindowScopeTracker>();

export function attachmentWindowScopeForRegistry(
  registry: AttachmentRegistry,
): AttachmentWindowScopeTracker {
  let tracker = trackers.get(registry);
  if (!tracker) {
    tracker = new AttachmentWindowScopeTracker();
    trackers.set(registry, tracker);
  }
  return tracker;
}

export function authorizeAttachmentForConversationScope(
  attachmentId: string,
  conversationScope: string,
  scopeTracker: AttachmentWindowScopeTracker | null,
  supervisor: Pick<RuntimeSupervisor, "attachmentConversations"> | null,
): AttachmentPreviewScopePolicy {
  return {
    allowTemporary: () => scopeTracker?.ownsTemporaryAttachment(
      attachmentId,
      conversationScope,
    ) === true,
    allowRetained: async () => {
      if (!supervisor) return false;
      const conversations = await supervisor
        .attachmentConversations(attachmentId)
        .catch(() => [] as readonly string[]);
      return conversations.includes(conversationScope);
    },
  };
}
