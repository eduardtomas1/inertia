import { EventEmitter } from "node:events";
import type { Page } from "@playwright/test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeBranchSwitch, type BranchSwitchTarget } from "../e2e/support/git-branch-switch-observer";

const target: BranchSwitchTarget = {
  projectId: "project", conversationId: "conversation", repositoryPath: ".", name: "origin/topic", remote: true,
};
function fixture() {
  const session = Object.assign(new EventEmitter(), {
    send: vi.fn(async () => ({})), detach: vi.fn(async () => {}),
  });
  const page = { context: () => ({ newCDPSession: async () => session }) } as unknown as Page;
  const frame = (direction: "Sent" | "Received", value: unknown) => session.emit(`Network.webSocketFrame${direction}`, {
    response: { payloadData: typeof value === "string" ? value : JSON.stringify(value) },
  });
  const admit = (requestId = "exact", payload: object = target) => frame("Sent", { type: "git.branch.switch", requestId, payload });
  const reply = (requestId = "exact", kind = "git.action") => frame("Received", { type: "request.result", requestId, result: { kind } });
  return { session, page, frame, admit, reply };
}
function expectObservationRemoved(session: EventEmitter): void {
  expect(session.listenerCount("Network.webSocketFrameSent")).toBe(0);
  expect(session.listenerCount("Network.webSocketFrameReceived")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("ignores unrelated payloads and stale replies, then accepts only the observed request's real result", async () => {
  const f = fixture();
  const observer = await observeBranchSwitch(f.page, target);
  f.frame("Sent", "not JSON");
  f.frame("Received", "not JSON");
  for (const key of Object.keys(target)) f.admit(`wrong-${key}`, { ...target, [key]: key === "remote" ? false : "other" });
  f.reply("exact"); // A reply before admission cannot settle the future command.
  f.admit();
  f.admit("later"); // A second command must not replace the observed request ID.
  f.reply("later");
  f.frame("Received", { type: "request.error", requestId: "unrelated", message: "Wrong request" });
  f.frame("Received", { type: "request.ok", requestId: "exact" });
  expect(f.session.listenerCount("Network.webSocketFrameReceived")).toBe(1);
  f.frame("Received", { type: "runtime.event", event: { type: "request.result", requestId: "exact", result: { kind: "git.action" } } });
  await expect(observer.waitForResult()).resolves.toBeUndefined();
  expectObservationRemoved(f.session);
  await observer.dispose();
  await observer.dispose();
  expect(f.session.detach).toHaveBeenCalledTimes(1);
});

it("accepts successful backend settlement after 15s without changing the later UI assertion's budget", async () => {
  const f = fixture();
  const observer = await observeBranchSwitch(f.page, target);
  f.admit();
  await vi.advanceTimersByTimeAsync(20_000);
  f.reply();
  await expect(observer.waitForResult()).resolves.toBeUndefined();
  expectObservationRemoved(f.session);
  await observer.dispose();
});

it.each([
  [{ type: "request.error", requestId: "exact", message: "Checkout was rejected" }, "Checkout was rejected"],
  [{ type: "request.result", requestId: "exact", result: { kind: "git.status" } }, "unexpected result kind"],
  [{ type: "request.result", requestId: "exact" }, "unexpected result kind"],
])("rejects a matching error or malformed/wrong result: %j", async (reply, error) => {
  const f = fixture();
  const observer = await observeBranchSwitch(f.page, target);
  f.admit();
  f.frame("Received", reply);
  await expect(observer.waitForResult()).rejects.toThrow(error);
  expectObservationRemoved(f.session);
  await observer.dispose();
  expect(f.session.detach).toHaveBeenCalledTimes(1);
});

it("fails missing admission at 15s even when unrelated commands and stale replies continue", async () => {
  const f = fixture();
  const observer = await observeBranchSwitch(f.page, target);
  await vi.advanceTimersByTimeAsync(14_999);
  f.admit("wrong-target", { ...target, conversationId: "other" });
  f.reply();
  expect(f.session.listenerCount("Network.webSocketFrameSent")).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(observer.waitForResult()).rejects.toThrow("not sent within 15000ms");
  expectObservationRemoved(f.session);
  await observer.dispose();
});

it("bounds missing completion at 60s from admission without refreshing the deadline for other traffic", async () => {
  const f = fixture();
  const observer = await observeBranchSwitch(f.page, target);
  await vi.advanceTimersByTimeAsync(14_999);
  f.admit();
  await vi.advanceTimersByTimeAsync(59_999);
  f.reply("wrong-request");
  f.admit("later");
  expect(f.session.listenerCount("Network.webSocketFrameReceived")).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await expect(observer.waitForResult()).rejects.toThrow("did not return a result within 60000ms");
  expectObservationRemoved(f.session);
  await observer.dispose();
});

it.each([false, true])("disposes before completion with admitted=%s and no retained timers/listeners", async (admitted) => {
  const f = fixture();
  const observer = await observeBranchSwitch(f.page, target);
  if (admitted) f.admit();
  await observer.dispose();
  f.admit();
  f.reply();
  await expect(observer.waitForResult()).rejects.toThrow("disposed before completion");
  expectObservationRemoved(f.session);
  expect(f.session.detach).toHaveBeenCalledTimes(1);
});

it("detaches its owned session if enabling observation fails", async () => {
  const f = fixture();
  f.session.send.mockRejectedValueOnce(new Error("CDP setup failed"));
  await expect(observeBranchSwitch(f.page, target)).rejects.toThrow("CDP setup failed");
  expectObservationRemoved(f.session);
  expect(f.session.detach).toHaveBeenCalledTimes(1);
});
