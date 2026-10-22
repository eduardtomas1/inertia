import { describe, expect, it, vi } from "vitest";

const { electronState, pageTools } = await vi.hoisted(async () => {
  const support = await import("./support/preview-broker-harness");
  return {
    electronState: support.createPreviewBrokerElectronState(),
    pageTools: support.createPreviewBrokerPageTools(),
  };
});

vi.mock("electron", async () => (
  (await import("./support/preview-broker-harness")).createPreviewBrokerElectronMock(electronState)
));
vi.mock("../../src/main/preview-agent-page", () => pageTools);

import { PreviewBroker } from "../../src/main/preview-broker";
import { previewReloadShortcut } from "../../src/main/preview-keyboard";
import {
  connectionId,
  conversationId,
  createPreviewBrokerHarness,
} from "./support/preview-broker-harness";

const primary = process.platform === "darwin"
  ? { meta: true, control: false }
  : { meta: false, control: true };

async function loadedPage() {
  const { broker } = createPreviewBrokerHarness(PreviewBroker);
  const owner = { ownerId: "primary", contextId: conversationId, connectionId };
  broker.connect(owner);
  broker.setBounds({ ...owner, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  await broker.navigate({ ...owner, url: "http://127.0.0.1:3000/" });
  const contents = electronState.contents.at(-1)!;
  return { contents, reload: vi.spyOn(contents, "reload") };
}

function press(
  contents: { emit(name: string, ...args: unknown[]): void },
  input: Record<string, unknown>,
) {
  const event = { preventDefault: vi.fn() };
  contents.emit("before-input-event", event, {
    type: "keyDown", key: "r", alt: false, shift: false, ...primary, ...input,
  });
  return event;
}

describe("Browser page reload keys", () => {
  it.each([false, true])("reloads the Browser page instead of the app window (Shift %s)", async (shift) => {
    const { contents, reload } = await loadedPage();

    const event = press(contents, { shift });

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    contents.emit("did-stop-loading");
  });

  it("leaves other keys and the reload key with Alt to the page", async () => {
    const { contents, reload } = await loadedPage();

    expect(press(contents, { key: "e" }).preventDefault).not.toHaveBeenCalled();
    expect(press(contents, { alt: true }).preventDefault).not.toHaveBeenCalled();
    expect(press(contents, { type: "keyUp" }).preventDefault).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
  });

  it("recognizes only the platform's primary reload shortcut", () => {
    const input = { type: "keyDown", key: "R", alt: false, shift: false, meta: true, control: false };

    expect(previewReloadShortcut(input, "darwin")).toBe(true);
    expect(previewReloadShortcut({ ...input, shift: true }, "darwin")).toBe(true);
    expect(previewReloadShortcut({ ...input, meta: false, control: true }, "darwin")).toBe(false);
    expect(previewReloadShortcut({ ...input, meta: false, control: true }, "win32")).toBe(true);
    expect(previewReloadShortcut({ ...input, meta: false, control: true, shift: true }, "linux")).toBe(true);
    expect(previewReloadShortcut(input, "linux")).toBe(false);
    expect(previewReloadShortcut({ ...input, alt: true }, "darwin")).toBe(false);
    expect(previewReloadShortcut({ ...input, type: "keyUp" }, "darwin")).toBe(false);
    expect(previewReloadShortcut({ ...input, key: "t" }, "darwin")).toBe(false);
  });
});
