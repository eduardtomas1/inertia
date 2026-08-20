import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DETACHED_CHAT_DEFAULT_BOUNDS,
  DetachedChatWindowStateStore,
  parseDetachedChatWindowState,
  restoreDetachedChatWindowBounds,
} from "../../src/main/detached-chat-window-state";

const firstConversation = "11111111-1111-4111-8111-111111111111";
const secondConversation = "22222222-2222-4222-8222-222222222222";
const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];

describe("detached chat window state", () => {
  it("parses a strict versioned file while isolating invalid entries", () => {
    expect(parseDetachedChatWindowState({
      version: 1,
      windows: [
        {
          conversationId: firstConversation,
          bounds: { x: 40, y: 50, width: 600, height: 700 },
        },
        {
          conversationId: "not-a-conversation",
          bounds: { x: 0, y: 0, width: 600, height: 700 },
        },
        {
          conversationId: secondConversation,
          bounds: { x: 10, y: 20, width: 500, height: 650 },
          injected: true,
        },
      ],
    })).toEqual({
      version: 1,
      windows: [{
        conversationId: firstConversation,
        bounds: { x: 40, y: 50, width: 600, height: 700 },
      }],
    });
    expect(parseDetachedChatWindowState({
      version: 2,
      windows: [],
    }).windows).toEqual([]);
    expect(parseDetachedChatWindowState({
      version: 1,
      windows: [],
      injected: true,
    }).windows).toEqual([]);
  });

  it("clamps saved sizes and drops positions that are no longer visible", () => {
    expect(restoreDetachedChatWindowBounds(null, displays)).toEqual(
      DETACHED_CHAT_DEFAULT_BOUNDS,
    );
    expect(restoreDetachedChatWindowBounds({
      x: 120,
      y: 80,
      width: 200,
      height: 8_000,
    }, displays)).toEqual({
      x: 120,
      y: 80,
      width: 440,
      height: 2_400,
    });
    expect(restoreDetachedChatWindowBounds({
      x: 8_000,
      y: 8_000,
      width: 700,
      height: 800,
    }, displays)).toEqual({ width: 700, height: 800 });
  });

  it("persists independent per-chat bounds without persisting open windows", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-detached-state-"));
    const path = join(directory, "detached-chat-window-state.json");
    try {
      const store = new DetachedChatWindowStateStore(path);
      store.remember(firstConversation, {
        x: 100,
        y: 120,
        width: 620,
        height: 760,
      });
      store.remember(secondConversation, {
        x: 300,
        y: 200,
        width: 720,
        height: 820,
      });
      store.flush();

      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        version: 1,
        windows: [
          {
            conversationId: firstConversation,
            bounds: { x: 100, y: 120, width: 620, height: 760 },
          },
          {
            conversationId: secondConversation,
            bounds: { x: 300, y: 200, width: 720, height: 820 },
          },
        ],
      });

      const restored = new DetachedChatWindowStateStore(path);
      expect(restored.restore(firstConversation, displays)).toEqual({
        x: 100,
        y: 120,
        width: 620,
        height: 760,
      });
      expect(restored.restore(
        "33333333-3333-4333-8333-333333333333",
        displays,
      )).toEqual(DETACHED_CHAT_DEFAULT_BOUNDS);
      expect(restored.snapshot()).not.toHaveProperty("openWindows");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails safely for oversized and malformed persistence files", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-detached-state-"));
    const path = join(directory, "detached-chat-window-state.json");
    try {
      writeFileSync(path, "x".repeat(64 * 1024 + 1));
      expect(new DetachedChatWindowStateStore(path).snapshot().windows)
        .toEqual([]);
      writeFileSync(path, "{not-json");
      expect(new DetachedChatWindowStateStore(path).snapshot().windows)
        .toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
