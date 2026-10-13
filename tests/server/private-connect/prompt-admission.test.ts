import { afterEach, describe, expect, it, vi } from "vitest";

import { queuePrivateConnectPrompt } from "../../../src/server/private-connect/prompt-admission";
import { hold, release } from "../../../src/server/runtime/update-hold";

const conversationId = "11111111-1111-4111-8111-111111111111";
const deviceId = "33333333-3333-4333-8333-333333333333";
const turnId = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const acquire = vi.fn(() => true);
  const release = vi.fn();
  const queue = vi.fn(() => ({ turn: { id: turnId } }));
  const start = vi.fn(() => true);
  const failBeforeStart = vi.fn();
  let title = "Existing title";
  let hasMessages = false;
  const store = {
    conversation: vi.fn(() => ({ title })),
    hasConversationMessages: vi.fn(() => hasMessages),
    updateConversation: vi.fn((_id: string, update: { title: string }) => {
      title = update.title;
    }),
  };
  queue.mockImplementation(() => {
    hasMessages = true;
    return { turn: { id: turnId } };
  });
  const dependencies = {
    store,
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
    store,
    setTitle: (next: string) => { title = next; },
    title: () => title,
    acquire,
    release,
    queue,
    start,
    failBeforeStart,
  };
}

describe("Private Connect prompt admission", () => {
  afterEach(() => release());

  it("refuses a remote prompt while Inertia is updating", () => {
    const subject = fixture();
    hold();

    expect(() => queuePrivateConnectPrompt(
      subject.dependencies,
      conversationId,
      "Continue remotely",
      deviceId,
    )).toThrow("Inertia is updating.");

    expect(subject.acquire).not.toHaveBeenCalled();
    expect(subject.queue).not.toHaveBeenCalled();
  });

  it("rejects a resumed provider terminal before a remote turn is queued", () => {
    const subject = fixture();
    subject.acquire.mockReturnValue(false);

    expect(() => queuePrivateConnectPrompt(
      subject.dependencies,
      conversationId,
      "Continue remotely",
      deviceId,
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
      deviceId,
    )).toEqual({ turnId });

    expect(subject.queue).toHaveBeenCalledWith(expect.objectContaining({ privateConnectDeviceId: deviceId }));
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
      deviceId,
    )).toThrow("could not start");

    expect(subject.failBeforeStart).toHaveBeenCalledWith(
      conversationId,
      "The remote turn could not start.",
    );
    expect(subject.release).toHaveBeenCalledWith(conversationId);
  });

  it("gives an untitled chat a quick title from its first remote prompt", () => {
    const subject = fixture();
    subject.setTitle("New chat");
    subject.dependencies.onQueued = vi.fn(() => {
      expect(subject.title()).toBe("Review the failing upload test");
    });

    queuePrivateConnectPrompt(
      subject.dependencies,
      conversationId,
      "Review the failing upload test\nwith more detail",
      deviceId,
    );

    expect(subject.store.updateConversation).toHaveBeenCalledWith(conversationId, {
      title: "Review the failing upload test",
    });
    expect(subject.dependencies.onQueued).toHaveBeenCalledOnce();
  });

  it("keeps existing titles, earlier history and prompts with no usable text", () => {
    const titled = fixture();
    queuePrivateConnectPrompt(titled.dependencies, conversationId, "Continue remotely", deviceId);
    expect(titled.store.updateConversation).not.toHaveBeenCalled();

    const withHistory = fixture();
    withHistory.setTitle("New thread");
    withHistory.store.hasConversationMessages.mockReturnValue(true);
    queuePrivateConnectPrompt(withHistory.dependencies, conversationId, "Continue remotely", deviceId);
    expect(withHistory.store.updateConversation).not.toHaveBeenCalled();

    const codeOnly = fixture();
    codeOnly.setTitle("New chat");
    queuePrivateConnectPrompt(codeOnly.dependencies, conversationId, "```\nconst a = 1;\n```", deviceId);
    expect(codeOnly.store.updateConversation).not.toHaveBeenCalled();
  });

  it("keeps a title chosen while the remote turn was being queued", () => {
    const subject = fixture();
    subject.setTitle("New chat");
    subject.queue.mockImplementation(() => {
      subject.setTitle("Renamed meanwhile");
      return { turn: { id: turnId } };
    });

    queuePrivateConnectPrompt(subject.dependencies, conversationId, "Continue remotely", deviceId);

    expect(subject.store.updateConversation).not.toHaveBeenCalled();
  });
});
