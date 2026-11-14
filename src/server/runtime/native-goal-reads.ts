import { isProcessTreeTerminationUnconfirmed } from "../process-lifecycle";
import { RuntimeRequestError } from "../runtime-errors";
import {
  canonicalCheckoutIdentity,
  checkoutContains,
} from "./conversation-work-authority";

export interface NativeGoalRead {
  readonly signal: AbortSignal;
  finish(error?: unknown): void;
}

export interface NativeGoalReadScope {
  conversationId?: string;
  checkoutPath?: string;
}

interface ReadIdentity {
  conversationId: string;
  checkoutIdentity: string;
}

interface ActiveRead extends ReadIdentity {
  controller: AbortController;
  stopped: Promise<boolean>;
}

interface Hold {
  conversationId?: string;
  checkoutIdentity?: string;
}

function holds(hold: Hold, read: ReadIdentity): boolean {
  return hold.conversationId === read.conversationId
    || (hold.checkoutIdentity !== undefined
      && checkoutContains(hold.checkoutIdentity, read.checkoutIdentity));
}

export class NativeGoalReads {
  private readonly reads = new Set<ActiveRead>();
  private readonly holds = new Set<Hold>();

  begin(conversationId: string, checkoutPath: string): NativeGoalRead | null {
    const identity = {
      conversationId,
      checkoutIdentity: canonicalCheckoutIdentity(checkoutPath),
    };
    if ([...this.holds].some((hold) => holds(hold, identity))) return null;
    const controller = new AbortController();
    let settle!: (stopped: boolean) => void;
    const read: ActiveRead = {
      ...identity,
      controller,
      stopped: new Promise<boolean>((resolve) => {
        settle = resolve;
      }),
    };
    this.reads.add(read);
    return {
      signal: controller.signal,
      finish: (error?: unknown) => {
        if (!this.reads.delete(read)) return;
        settle(!isProcessTreeTerminationUnconfirmed(error));
      },
    };
  }

  async quiesce(scope: NativeGoalReadScope): Promise<() => void> {
    const hold: Hold = {
      ...(scope.conversationId === undefined
        ? {}
        : { conversationId: scope.conversationId }),
      ...(scope.checkoutPath === undefined
        ? {}
        : { checkoutIdentity: canonicalCheckoutIdentity(scope.checkoutPath) }),
    };
    this.holds.add(hold);
    const release = (): void => {
      this.holds.delete(hold);
    };
    const stopping = [...this.reads].filter((read) => holds(hold, read));
    for (const read of stopping) read.controller.abort();
    const stopped = await Promise.all(stopping.map((read) => read.stopped));
    if (stopped.every(Boolean)) return release;
    release();
    throw new RuntimeRequestError(
      "Inertia could not confirm that a Codex goal check in this folder stopped, so nothing was removed. Try again in a moment.",
    );
  }
}
