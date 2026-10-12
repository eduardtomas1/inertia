import { expect, it, vi } from "vitest";
import { parseMascotFeed } from "../../src/shared/mascot-feed";
import { mascotPublisher, mascotShell } from "../helpers/mascot-fixture";

vi.mock("../../src/server/runtime/mascot-message", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/server/runtime/mascot-message")>();
  return { ...actual, mascotPreview: (value: string | null | undefined, limit?: number) => value === "Chat broken" ? "\ud83d" : actual.mascotPreview(value, limit) };
});

it("sanitises a chat whose text is still malformed instead of letting it sink the whole feed", () => {
  const { publisher, feed } = mascotPublisher();
  publisher.replace([mascotShell("broken", "waiting-for-input"), mascotShell("fine", "running")], [{ id: "project", name: "Inertia" }]);
  expect(parseMascotFeed(JSON.parse(JSON.stringify(feed())) as Record<string, unknown>)).not.toBeNull();
  expect(feed().status).toMatchObject({ conversationId: "broken", phase: "waiting-for-input", chatTitle: null });
  expect(feed().rows).toEqual([expect.objectContaining({ conversationId: "fine", chatTitle: "Chat fine", projectName: "Inertia" })]);
});
