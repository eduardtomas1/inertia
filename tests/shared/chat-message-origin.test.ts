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
