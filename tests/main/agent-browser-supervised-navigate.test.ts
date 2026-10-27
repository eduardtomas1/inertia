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
import { createPreviewBrokerHarness, runIdentity } from "./support/preview-broker-harness";

describe("Supervised Browser navigation", () => {
  it("performs an approved navigate in a tab that has never loaded a page", async () => {
    const contentsOffset = electronState.contents.length;
    const { broker } = createPreviewBrokerHarness(PreviewBroker);
    const command = { action: "navigate", url: "http://localhost:3000/" } as const;
    const prepared = await broker.perform(runIdentity, { action: "prepare-approval", command });
    expect(prepared).toMatchObject({ ok: true });
    const { token } = JSON.parse((prepared as { text: string }).text) as { token: string };
    await expect(broker.perform(runIdentity, { action: "perform-approved", token }))
      .resolves.toMatchObject({ ok: true });
    const contents = electronState.contents[contentsOffset]!;
    expect(contents.getURL()).toBe("http://localhost:3000/");
    expect(contents.navigationHistory.removeEntryAtIndex).toHaveBeenCalledExactlyOnceWith(0);
  });
});
