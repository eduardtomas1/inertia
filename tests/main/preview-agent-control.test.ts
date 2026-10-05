import { afterEach, describe, expect, it, vi } from "vitest";

import { agentPageInputIsUser, sendAgentPageInput } from "../../src/main/preview-agent-control";

function contents() {
  const emitted: Array<Record<string, unknown>> = [];
  return {
    emitted,
    sendInputEvent: vi.fn((input: Record<string, unknown>) => { emitted.push(input); }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("agent page input ownership", () => {
  it("consumes each expected agent click or key once and treats anything else as the user", () => {
    const page = contents();
    sendAgentPageInput(page as never, { type: "mouseDown", x: 40, y: 20, button: "left", clickCount: 1 });
    sendAgentPageInput(page as never, { type: "keyDown", keyCode: "Tab" });
    expect(page.sendInputEvent).toHaveBeenCalledTimes(2);
    expect(agentPageInputIsUser(page as never, { type: "mouseDown", x: 40.4, y: 19.6 } as never)).toBe(false);
    expect(agentPageInputIsUser(page as never, { type: "rawKeyDown", keyCode: "Tab" } as never)).toBe(false);
    expect(agentPageInputIsUser(page as never, { type: "mouseDown", x: 40, y: 20 } as never)).toBe(true);
    expect(agentPageInputIsUser(page as never, { type: "keyDown", keyCode: "a" } as never)).toBe(true);
    sendAgentPageInput(page as never, { type: "mouseDown", x: 40, y: 20, button: "left", clickCount: 1 });
    expect(agentPageInputIsUser(page as never, { type: "mouseDown", x: 300, y: 200 } as never)).toBe(true);
  });

  it("ignores pointer movement, wheels and characters, which are not the user taking over", () => {
    const page = contents();
    for (const type of ["mouseMove", "mouseUp", "mouseWheel", "char", "keyUp", "mouseEnter"]) {
      expect(agentPageInputIsUser(page as never, { type, x: 1, y: 1 } as never), type).toBe(false);
    }
  });

  it("forgets expectations after two seconds and keeps at most 64", () => {
    vi.useFakeTimers();
    const page = contents();
    sendAgentPageInput(page as never, { type: "keyDown", keyCode: "Tab" });
    vi.advanceTimersByTime(2_001);
    expect(agentPageInputIsUser(page as never, { type: "keyDown", keyCode: "Tab" } as never)).toBe(true);
    for (let index = 0; index < 65; index += 1) {
      sendAgentPageInput(page as never, { type: "mouseDown", x: index * 10, y: 0, button: "left", clickCount: 1 });
    }
    expect(agentPageInputIsUser(page as never, { type: "mouseDown", x: 0, y: 0 } as never)).toBe(true);
    expect(agentPageInputIsUser(page as never, { type: "mouseDown", x: 640, y: 0 } as never)).toBe(false);
  });
});
