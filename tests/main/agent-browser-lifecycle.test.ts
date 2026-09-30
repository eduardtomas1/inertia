import { runInNewContext } from "node:vm";

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
} from "./support/preview-broker-harness";

const harness = () => createPreviewBrokerHarness(PreviewBroker);

describe("a document with more than 4,000 inputs", () => {
  it("is withheld as too large to inspect, not as a password change", async () => {
    const actual = await vi.importActual<typeof import("../../src/main/preview-agent-page")>(
      "../../src/main/preview-agent-page",
    );
    const inputs = Array.from({ length: 4_001 }, () => ({ tagName: "INPUT", type: "checkbox", value: "on" }));
    const context = {
      __inertiaAgentBrowser: {
        privacyGuardInstalled: true,
        passwordNodes: new WeakSet(),
        passwordValues: new Set<string>(),
      },
      document: { documentElement: {}, getElementsByTagName: () => inputs },
    };
    const { broker } = harness();
    await broker.navigate({ ownerId: "primary", contextId: conversationId, url: "http://127.0.0.1:3000/grid" });
    const contents = electronState.contents.at(-1)!;
    const sendCommand = contents.debugger.sendCommand.getMockImplementation()!;
    let evaluated = 0;
    contents.debugger.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method !== "Runtime.evaluate" || typeof params?.expression !== "string"
        || !params.expression.includes("privacyGuardInstalled")) return await sendCommand(method, params);
      evaluated += 1;
      return { result: { type: "string", value: runInNewContext(params.expression, context) } };
    });
    pageTools.agentPageEvidencePrivacy.mockImplementationOnce(
      async (...args: unknown[]) => await actual.agentPageEvidencePrivacy(args[0] as never),
    );
    const result = await broker.perform(conversationId, { action: "snapshot" });
    expect(evaluated).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: false, code: "sensitive" });
    const message = result.ok ? "" : result.message;
    expect(message).toContain("more than 4,000 inputs");
    expect(message).toContain("smaller page");
    expect(message).not.toContain("a script changed a password field");
    expect(message).not.toContain("Navigate to the page again");
    broker.close();
  });
});
