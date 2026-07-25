import type { RuntimeSyncCursor } from "@shared/contracts";

export interface RuntimeProjectionState extends RuntimeSyncCursor {
  synchronized: boolean;
  synchronizationTarget: number | null;
}

export type RuntimeFrameDecision = "apply" | "ignore" | "gap" | "generation-mismatch";
export type RuntimeCompletionDecision = "completed" | "ignore" | "gap" | "generation-mismatch";

function validCursor(cursor: RuntimeSyncCursor): boolean {
  return (
    typeof cursor.runtimeGeneration === "string"
    && cursor.runtimeGeneration.length > 0
    && Number.isSafeInteger(cursor.latestSequence)
    && cursor.latestSequence >= 0
  );
}

/**
 * Mutable connection-local sequence guard. Domain state remains in React; this
 * object only decides whether a transport frame may be projected into it.
 */
export class RuntimeProjectionSequence {
  private state: RuntimeProjectionState | null = null;

  current(): RuntimeProjectionState | null {
    return this.state ? { ...this.state } : null;
  }

  replaceFromSnapshot(cursor: RuntimeSyncCursor): RuntimeProjectionState {
    if (!validCursor(cursor)) throw new Error("Invalid runtime snapshot cursor.");
    this.state = {
      ...cursor,
      synchronized: false,
      synchronizationTarget: cursor.latestSequence,
    };
    return this.current()!;
  }

  beginResume(cursor: RuntimeSyncCursor): "resume" | "generation-mismatch" | "gap" {
    if (!validCursor(cursor) || !this.state || cursor.runtimeGeneration !== this.state.runtimeGeneration) {
      return "generation-mismatch";
    }
    if (cursor.latestSequence < this.state.latestSequence) {
      return "gap";
    }
    this.state = {
      ...this.state,
      synchronized: false,
      synchronizationTarget: cursor.latestSequence,
    };
    return "resume";
  }

  classifyFrame(cursor: RuntimeSyncCursor): RuntimeFrameDecision {
    if (!validCursor(cursor) || !this.state || cursor.runtimeGeneration !== this.state.runtimeGeneration) {
      return "generation-mismatch";
    }
    if (cursor.latestSequence <= this.state.latestSequence) return "ignore";
    if (cursor.latestSequence !== this.state.latestSequence + 1) return "gap";
    this.state = {
      ...this.state,
      latestSequence: cursor.latestSequence,
    };
    return "apply";
  }

  complete(cursor: RuntimeSyncCursor): RuntimeCompletionDecision {
    if (!validCursor(cursor) || !this.state || cursor.runtimeGeneration !== this.state.runtimeGeneration) {
      return "generation-mismatch";
    }
    if (cursor.latestSequence < this.state.latestSequence) return "ignore";
    if (
      this.state.synchronizationTarget !== null
      && cursor.latestSequence !== this.state.synchronizationTarget
    ) {
      return "gap";
    }
    if (cursor.latestSequence !== this.state.latestSequence) return "gap";
    this.state = {
      ...this.state,
      synchronized: true,
      synchronizationTarget: null,
    };
    return "completed";
  }

  disconnect(): void {
    if (!this.state) return;
    this.state = {
      ...this.state,
      synchronized: false,
      synchronizationTarget: null,
    };
  }

  reset(): void {
    this.state = null;
  }
}

export function runtimeResumeUrl(
  websocketUrl: string,
  cursor: RuntimeSyncCursor | null,
  conversationId: string | null,
): string {
  if (!cursor || !validCursor(cursor)) return websocketUrl;
  const url = new URL(websocketUrl);
  url.searchParams.set("runtimeGeneration", cursor.runtimeGeneration);
  url.searchParams.set("afterSequence", String(cursor.latestSequence));
  if (conversationId) url.searchParams.set("conversationId", conversationId);
  return url.toString();
}
