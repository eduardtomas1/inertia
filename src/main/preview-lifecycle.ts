import {
  previewContext,
  previewOwner,
  type PreviewOwner,
} from "./preview-identity.js";

export class PreviewContextRegistry {
  readonly #contexts = new Map<PreviewOwner, string>();

  connect(value: unknown): {
    ownerId: PreviewOwner;
    contextId: string;
    priorContextId: string | undefined;
  } {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid Browser connection request");
    }
    const request = value as { ownerId?: unknown; contextId?: unknown };
    const ownerId = previewOwner(request.ownerId);
    const contextId = previewContext(request.contextId);
    const priorContextId = this.#contexts.get(ownerId);
    this.#contexts.set(ownerId, contextId);
    return { ownerId, contextId, priorContextId };
  }

  ownerFor(contextId: string): PreviewOwner | undefined {
    return [...this.#contexts.entries()].find(
      ([, registeredContextId]) => registeredContextId === contextId,
    )?.[0];
  }

  release(ownerId: PreviewOwner, contextId?: string): void {
    if (!contextId || this.#contexts.get(ownerId) === contextId) {
      this.#contexts.delete(ownerId);
    }
  }

  clear(): void {
    this.#contexts.clear();
  }
}
