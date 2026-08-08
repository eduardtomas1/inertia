import { describe, expect, it, vi } from "vitest";

import { queuePrivateConnectPrompt } from "../../../src/server/private-connect/prompt-admission";

const conversationId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const acquire = vi.fn(() => true);
  const release = vi.fn();
  const queue = vi.fn(() => ({ turn: { id: turnId } }));
  const start = vi.fn(() => true);
  const failBeforeStart = vi.fn();
  const dependencies = {
    authority: { acquire, release },
    turns: {
      failBeforeStart,
      isActive: vi.fn(() => false),
      queue,
      start,
    },
    isolatedRuns: { has: vi.fn(() => false) },
    onQueued: vi.fn(),
  } as unknown as Parameters<typeof queuePrivateConnectPrompt>[0];
  return {
    dependencies,
    acquire,
    release,
    queue,
    start,
    failBeforeStart,
  };
}

describe("Private Connect prompt admission", () => {
  it("rejects a resumed provider terminal before a remote turn is queued", () => {
    const subject = fixture();
    subject.acquire.mockReturnValue(false);

    expect(() => queuePrivateConnectPrompt(
      subject.dependencies,
      conversationId,
      "Continue remotely",
    )).toThrow("End the resumed provider terminal");

    expect(subject.queue).not.toHaveBeenCalled();
    expect(subject.release).not.toHaveBeenCalled();
  });

  it("holds checkout authority through remote turn admission", () => {
    const subject = fixture();
    subject.queue.mockImplementation(() => {
      expect(subject.release).not.toHaveBeenCalled();
      return { turn: { id: turnId } };
    });
    subject.start.mockImplementation(() => {
      expect(subject.release).not.toHaveBeenCalled();
      return true;
    });

    expect(queuePrivateConnectPrompt(
      subject.dependencies,
      conversationId,
      "Continue remotely",
    )).toEqual({ turnId });

    expect(subject.acquire).toHaveBeenCalledWith(conversationId);
    expect(subject.release).toHaveBeenCalledWith(conversationId);
  });

  it("settles and releases a queued turn when start is rejected", () => {
    const subject = fixture();
    subject.start.mockReturnValue(false);

    expect(() => queuePrivateConnectPrompt(
      subject.dependencies,
      conversationId,
      "Continue remotely",
    )).toThrow("could not start");

    expect(subject.failBeforeStart).toHaveBeenCalledWith(
      conversationId,
      "The remote turn could not start.",
    );
    expect(subject.release).toHaveBeenCalledWith(conversationId);
  });
});
