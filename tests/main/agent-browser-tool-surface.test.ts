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
import {
  conversationId,
  createPreviewBrokerHarness,
  runIdentity,
} from "./support/preview-broker-harness";

async function loadedHarness() {
  const contentsOffset = electronState.contents.length;
  const created = createPreviewBrokerHarness(PreviewBroker);
  await created.broker.navigate({
    ownerId: "primary",
    contextId: conversationId,
    url: "http://127.0.0.1:3000/",
  });
  return { ...created, contents: electronState.contents[contentsOffset]! };
}

describe("Browser tool surface", () => {
  it("tells the agent to take a new snapshot when a ref is stale", async () => {
    const { broker } = await loadedHarness();
    pageTools.locateAgentPageRef.mockResolvedValueOnce({ found: false });
    await expect(broker.perform(runIdentity, { action: "click", ref: "e9" })).resolves.toEqual({
      ok: false,
      code: "not-found",
      message: "That page element is stale. Take a new inertia_browser_snapshot for current refs.",
    });
  });
});
