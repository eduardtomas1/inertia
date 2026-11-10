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

const duoComparison = {
  launchId: "launch-1",
  sides: [
    { conversationId: "side-a", providerId: "codex", title: "Simplify sign-up", status: "completed", filesChanged: 2 },
    { conversationId: "side-b", providerId: null, title: "", status: "interrupted", filesChanged: null },
  ],
};

it("accepts the server's Duo comparison brief on user messages only", () => {
  expect(chatMessageSchema({ ...message, duoComparison })).toBe(true);
  expect(chatMessageSchema({ ...message, role: "assistant", duoComparison })).toBe(false);
});

it.each([
  null,
  {},
  { ...duoComparison, sides: [duoComparison.sides[0]] },
  { ...duoComparison, sides: [{ ...duoComparison.sides[0], status: "running" }, duoComparison.sides[1]] },
  { ...duoComparison, sides: [{ ...duoComparison.sides[0], filesChanged: -1 }, duoComparison.sides[1]] },
  { ...duoComparison, sides: [{ ...duoComparison.sides[0], title: "x".repeat(201) }, duoComparison.sides[1]] },
  { ...duoComparison, kind: "duo-comparison" },
])("rejects a malformed Duo comparison brief %j", (malformed) => {
  expect(chatMessageSchema({ ...message, duoComparison: malformed })).toBe(false);
});

const customAgentCall = {
  agentId: "77777777-7777-4777-8777-777777777777",
  revision: 2,
  handle: "reviewer",
  name: "Reviewer",
  icon: { kind: "symbol", name: "shield" },
  accent: "teal",
  delivery: "subagent",
};

it("accepts custom agent call attribution on user messages", () => {
  expect(chatMessageSchema({ ...message, customAgentCall })).toBe(true);
  expect(chatMessageSchema({ ...message, customAgentCall: { ...customAgentCall, accent: null, delivery: "in-role" } })).toBe(true);
});

it.each(["assistant", "system"])("rejects custom agent call attribution on a %s message", (role) => {
  expect(chatMessageSchema({ ...message, role, customAgentCall })).toBe(false);
});

it.each([
  null,
  "reviewer",
  {},
  { ...customAgentCall, agentId: "agent-1" },
  { ...customAgentCall, revision: 0 },
  { ...customAgentCall, handle: "Bad Handle" },
  { ...customAgentCall, delivery: "inline" },
  { ...customAgentCall, icon: { kind: "symbol", name: "unknown" } },
  { ...customAgentCall, instructions: "# Reviewer" },
])("rejects malformed custom agent call attribution %j", (malformed) => {
  expect(chatMessageSchema({ ...message, customAgentCall: malformed })).toBe(false);
});

const secretRequest = {
  requestId: "77777777-7777-4777-8777-777777777777",
  title: "Tailscale auth key",
  description: "Create a reusable key.\nSettings > Keys.",
  ttlHours: 24,
  status: "pending",
  answeredAt: null,
  expiresAt: null,
  storage: null,
};

it("accepts a secret request only on a turn-scoped system message", () => {
  expect(chatMessageSchema({ ...message, role: "system", secretRequest })).toBe(true);
  expect(chatMessageSchema({ ...message, role: "system", turnId: null, secretRequest })).toBe(false);
  expect(chatMessageSchema({ ...message, secretRequest })).toBe(false);
  expect(chatMessageSchema({ ...message, role: "assistant", secretRequest })).toBe(false);
});

it.each([
  null,
  {},
  { ...secretRequest, secret: "fixture-abc" },
  { ...secretRequest, status: "saved" },
  { ...secretRequest, title: "" },
  { ...secretRequest, ttlHours: 48 },
])("rejects a malformed secret request %j", (malformed) => {
  expect(chatMessageSchema({ ...message, role: "system", secretRequest: malformed })).toBe(false);
});
