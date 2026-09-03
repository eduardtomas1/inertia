import {
  previewConnection,
  previewContext,
  previewOwner,
  type PreviewOwner,
} from "./preview-identity.js";

interface PreviewRegistration {
  contextId: string;
  connectionId: string;
}

export class PreviewContextRegistry {
  readonly #contexts = new Map<PreviewOwner, PreviewRegistration>();

  connect(value: unknown): {
    ownerId: PreviewOwner;
    contextId: string;
    priorContextId: string | undefined;
    accepted: boolean;
  } {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid Browser connection request");
    }
    const request = value as {
      ownerId?: unknown;
      contextId?: unknown;
      connectionId?: unknown;
      recoverMissingLease?: unknown;
    };
    const ownerId = previewOwner(request.ownerId);
    const contextId = previewContext(request.contextId);
    const connectionId = previewConnection(request.connectionId);
    const priorContextId = this.#contexts.get(ownerId)?.contextId;
    const accepted = request.recoverMissingLease !== true || !priorContextId;
    if (accepted) this.#contexts.set(ownerId, { contextId, connectionId });
    return { ownerId, contextId, priorContextId, accepted };
  }

  ownerFor(contextId: string): PreviewOwner | undefined {
    return [...this.#contexts.entries()].find(
      ([, registration]) => registration.contextId === contextId,
    )?.[0];
  }

  owns(
    ownerId: PreviewOwner,
    contextId: string,
    connectionId: string,
  ): boolean {
    const current = this.#contexts.get(ownerId);
    return current?.contextId === contextId
      && current.connectionId === connectionId;
  }

  has(ownerId: PreviewOwner): boolean { return this.#contexts.has(ownerId); }

  release(ownerId: PreviewOwner, contextId?: string): void {
    if (!contextId || this.#contexts.get(ownerId)?.contextId === contextId) {
      this.#contexts.delete(ownerId);
    }
  }

  releaseRequest(value: unknown): {
    ownerId: PreviewOwner;
    contextId: string;
  } | null {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid preview request");
    }
    const request = value as {
      ownerId?: unknown;
      contextId?: unknown;
      connectionId?: unknown;
    };
    const ownerId = previewOwner(request.ownerId);
    const contextId = previewContext(request.contextId);
    const connectionId = previewConnection(request.connectionId);
    const current = this.#contexts.get(ownerId);
    if (
      current?.contextId !== contextId
      || current.connectionId !== connectionId
    ) return null;
    this.#contexts.delete(ownerId);
    return { ownerId, contextId };
  }

  clear(): void {
    this.#contexts.clear();
  }
}
