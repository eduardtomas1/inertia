// @inertia-test-suite portable
import { expect, it } from "vitest";
import { chatMessageSchema } from "../../src/shared/contracts/chat-message-schema";

const message = { id: "m", conversationId: "c", turnId: "t", role: "user", content: "Remote request",
  attachments: [], createdAt: "2030-01-01T00:00:00.000Z" };
const deviceId = "33333333-3333-4333-8333-333333333333";

it("accepts legacy messages and authenticated user-message device identities", () => {
  expect(chatMessageSchema(message)).toBe(true);
  expect(chatMessageSchema({ ...message, privateConnectDeviceId: deviceId })).toBe(true);
});

it.each([null, "", "not-a-device", "a".repeat(500), { deviceId }])("rejects malformed device origin %j", (privateConnectDeviceId) => {
  expect(chatMessageSchema({ ...message, privateConnectDeviceId })).toBe(false);
});

it.each(["assistant", "system"])("rejects remote user attribution on a %s message", (role) => {
  expect(chatMessageSchema({ ...message, role, privateConnectDeviceId: deviceId })).toBe(false);
});

const watcherNote = {
  linkId: "44444444-4444-4444-8444-444444444444",
  wakeId: "55555555-5555-4555-8555-555555555555",
  watcherConversationId: "66666666-6666-4666-8666-666666666666",
  preset: "reviewer",
  watcherLabel: "Reviewer",
  delivery: "queue",
};

it("accepts forwarded watcher-note attribution on user messages", () => {
  expect(chatMessageSchema({ ...message, watcherNote })).toBe(true);
  expect(chatMessageSchema({ ...message, watcherNote: { ...watcherNote, delivery: "steer" } })).toBe(true);
});

it.each(["assistant", "system"])("rejects watcher-note attribution on a %s message", (role) => {
  expect(chatMessageSchema({ ...message, role, watcherNote })).toBe(false);
});

it.each([
  null,
  "Reviewer",
  {},
  { ...watcherNote, linkId: "link-1" },
  { ...watcherNote, preset: "auditor" },
  { ...watcherNote, delivery: "auto" },
  { ...watcherNote, watcherLabel: "" },
  { ...watcherNote, watcherLabel: "x".repeat(81) },
  { ...watcherNote, executionAuthority: true },
])("rejects malformed watcher-note attribution %j", (malformed) => {
  expect(chatMessageSchema({ ...message, watcherNote: malformed })).toBe(false);
});
