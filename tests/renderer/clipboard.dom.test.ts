import { afterEach, describe, expect, it, vi } from "vitest";

import { writeClipboardText } from "../../src/renderer/src/utils/clipboard";

describe("renderer clipboard boundary", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers the privileged Electron bridge over the denied DOM clipboard", async () => {
    const copyText = vi.fn(async () => true);
    const domWrite = vi.fn(async () => {
      throw new Error("clipboard permission denied");
    });
    vi.stubGlobal("window", { inertia: { copyText } });
    vi.stubGlobal("navigator", { clipboard: { writeText: domWrite } });

    await expect(writeClipboardText("private pairing link")).resolves.toBe(true);
    expect(copyText).toHaveBeenCalledWith("private pairing link");
    expect(domWrite).not.toHaveBeenCalled();
  });
});
