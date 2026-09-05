// @inertia-test-suite portable

import { describe, expect, it } from "vitest";

import { ConversationAttachmentStoreTerminationTracker } from
  "../../src/node/conversation-attachment-store-termination";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("conversation attachment helper termination tracking", () => {
  it("keeps failed work terminal but accepts its exact late Linux exit for close", async () => {
    const tracker = new ConversationAttachmentStoreTerminationTracker(true);
    const stopped = deferred<void>();
    const termination = deferred<void>();
    const tracked = tracker.track({
      stopped: stopped.promise,
      termination: termination.promise,
    });
    stopped.reject(new Error("unconfirmed"));
    await expect(tracked).rejects.toThrow("unconfirmed");
    expect(tracker.operationFailure()).toMatchObject({ message: "unconfirmed" });
    expect(tracker.closeFailure()).toMatchObject({ message: "unconfirmed" });

    termination.resolve(undefined);
    await Promise.resolve();
    expect(tracker.operationFailure()).toMatchObject({ message: "unconfirmed" });
    expect(tracker.closeFailure()).toBeNull();
  });

  it("handles exact termination that settles before the stopped failure", async () => {
    const tracker = new ConversationAttachmentStoreTerminationTracker(true);
    const stopped = deferred<void>();
    const termination = deferred<void>();
    const tracked = tracker.track({
      stopped: stopped.promise,
      termination: termination.promise,
    });
    termination.resolve(undefined);
    await Promise.resolve();
    stopped.reject(new Error("late stopped failure"));
    await expect(tracked).rejects.toThrow("late stopped failure");
    expect(tracker.closeFailure()).toBeNull();
  });

  it("waits for every exact helper and keeps missing proof permanent", async () => {
    const tracker = new ConversationAttachmentStoreTerminationTracker(true);
    const firstStop = deferred<void>();
    const firstTermination = deferred<void>();
    const secondStop = deferred<void>();
    const secondTermination = deferred<void>();
    const first = tracker.track({ stopped: firstStop.promise,
      termination: firstTermination.promise });
    const second = tracker.track({ stopped: secondStop.promise,
      termination: secondTermination.promise });
    firstStop.reject(new Error("first")); secondStop.reject(new Error("second"));
    await Promise.allSettled([first, second]);
    firstTermination.resolve(undefined); await Promise.resolve();
    expect(tracker.closeFailure()).not.toBeNull();
    secondTermination.resolve(undefined); await Promise.resolve();
    expect(tracker.closeFailure()).toBeNull();

    const missing = tracker.track({ stopped: Promise.reject(new Error("missing")) });
    await expect(missing).rejects.toThrow("missing");
    expect(tracker.closeFailure()).not.toBeNull();
  });

  it("does not activate late-exit recovery outside Linux", async () => {
    const tracker = new ConversationAttachmentStoreTerminationTracker(false);
    const termination = deferred<void>();
    const tracked = tracker.track({
      stopped: Promise.reject(new Error("unconfirmed")),
      termination: termination.promise,
    });
    await expect(tracked).rejects.toThrow("unconfirmed");
    termination.resolve(undefined); await Promise.resolve();
    expect(tracker.closeFailure()).not.toBeNull();
  });
});
