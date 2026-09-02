import { RuntimeRequestError } from "../../runtime-errors";
import type { TurnAdmissionLease } from "./turn-controller-types";

interface TurnAdmissionCoordinatorOptions {
  isClosing(): boolean;
  isActive(conversationId: string): boolean;
  hasProviderCleanup(conversationId: string): boolean;
  waitForProviderCleanup(
    conversationId: string,
    deadlineAt: number,
  ): Promise<boolean>;
  blocksForGoalMutation(conversationId: string): boolean;
  waitForGoalIdle(conversationId: string, deadlineAt: number): Promise<boolean>;
}

interface AdmissionRecord {
  token: symbol;
  released: Promise<void>;
  resolveReleased(): void;
}

export class TurnAdmissionCoordinator {
  private readonly admissions = new Map<string, AdmissionRecord>();

  constructor(private readonly options: TurnAdmissionCoordinatorOptions) {}

  releaseBarrier(conversationId: string): Promise<void> | null {
    return this.admissions.get(conversationId)?.released ?? null;
  }

  has(conversationId: string): boolean {
    return this.admissions.has(conversationId);
  }

  assertQueueAuthority(
    conversationId: string,
    admission?: TurnAdmissionLease,
  ): void {
    const reserved = this.admissions.get(conversationId);
    if (
      reserved
      && (
        admission?.conversationId !== conversationId
        || admission.token !== reserved.token
      )
    ) {
      throw new RuntimeRequestError(
        "Another message is being prepared for this conversation.",
      );
    }
    if (admission && !reserved) {
      throw new RuntimeRequestError(
        "Message admission expired before the turn could be queued.",
      );
    }
  }

  consume(admission: TurnAdmissionLease): void {
    this.release(admission.conversationId, admission.token);
  }

  async acquire(
    conversationId: string,
    timeoutMs: number,
  ): Promise<TurnAdmissionLease | null> {
    const deadlineAt = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      if (this.options.isClosing() || Date.now() >= deadlineAt) return null;
      if (!await this.options.waitForProviderCleanup(
        conversationId,
        deadlineAt,
      )) return null;
      if (!await this.options.waitForGoalIdle(
        conversationId,
        deadlineAt,
      )) return null;
      if (this.options.isClosing() || Date.now() >= deadlineAt) return null;
      if (this.options.isActive(conversationId)) return null;
      if (
        this.options.hasProviderCleanup(conversationId)
        || this.options.blocksForGoalMutation(conversationId)
      ) continue;

      const prior = this.admissions.get(conversationId);
      if (prior) {
        if (!await waitUntilReleased(
          () => this.admissions.get(conversationId) === prior,
          deadlineAt,
          this.options.isClosing,
        )) return null;
        continue;
      }

      if (this.options.isClosing() || Date.now() >= deadlineAt) return null;
      const token = Symbol();
      let resolveReleased!: () => void;
      const released = new Promise<void>((resolve) => {
        resolveReleased = resolve;
      });
      this.admissions.set(conversationId, {
        token,
        released,
        resolveReleased,
      });
      let releasedByCaller = false;
      return {
        conversationId,
        token,
        release: () => {
          if (releasedByCaller) return;
          releasedByCaller = true;
          this.release(conversationId, token);
        },
      };
    }
  }

  dispose(): void {
    for (const [conversationId, admission] of this.admissions) {
      this.release(conversationId, admission.token);
    }
  }

  private release(conversationId: string, token: symbol): void {
    const admission = this.admissions.get(conversationId);
    if (!admission || admission.token !== token) return;
    this.admissions.delete(conversationId);
    admission.resolveReleased();
  }
}

async function waitUntilReleased(
  pending: () => boolean,
  deadlineAt: number,
  isClosing: () => boolean,
): Promise<boolean> {
  while (pending()) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0 || isClosing()) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(25, remaining));
    });
  }
  return true;
}

export async function waitForProviderCleanupBarriers(
  barriersByConversation: ReadonlyMap<string, Promise<void>>,
  conversationIds: readonly string[],
  deadlineAt = Number.POSITIVE_INFINITY,
): Promise<void | boolean> {
  const expected = new Set(conversationIds);
  await Promise.resolve();
  while (true) {
    const barriers = [...barriersByConversation.entries()]
      .filter(([conversationId]) => expected.has(conversationId))
      .map(([, barrier]) => barrier);
    if (barriers.length === 0) {
      return Number.isFinite(deadlineAt) ? true : undefined;
    }
    if (!Number.isFinite(deadlineAt)) {
      await Promise.allSettled(barriers);
      continue;
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(25, remaining));
    });
  }
}
