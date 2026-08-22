import { expect } from "@playwright/test";

import type { AppFixture } from "./app-fixture";

export async function expectDocumentStartPrivacyGuard(
  app: AppFixture,
  conversationId: string,
  url: string,
  forbiddenText = "document-start-password-sentinel",
): Promise<void> {
  const evidence = await app.electronApp.evaluate(
    async (_electron, request) => {
      type Command =
        | { action: "snapshot" | "screenshot" | "tabs" }
        | { action: "tab-open"; url: string }
        | { action: "tab-activate" | "tab-close"; tabId: string };
      type Result = {
        code?: string;
        ok: boolean;
        state?: { activeTabId: string };
        text?: string;
      };
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (id: string, command: Command) => Promise<Result>;
      };
      const before = await runtime.agentBrowser(request.conversationId, {
        action: "tabs",
      });
      if (!before.ok || !before.state) return { before };
      const previousTabId = before.state.activeTabId;
      const opened = await runtime.agentBrowser(request.conversationId, {
        action: "tab-open",
        url: request.url,
      });
      if (!opened.ok || !opened.state) return { opened };
      const tabId = opened.state.activeTabId;
      const snapshot = await runtime.agentBrowser(request.conversationId, {
        action: "snapshot",
      });
      const screenshot = await runtime.agentBrowser(request.conversationId, {
        action: "screenshot",
      });
      const closed = await runtime.agentBrowser(request.conversationId, {
        action: "tab-close",
        tabId,
      });
      const restored = await runtime.agentBrowser(request.conversationId, {
        action: "tab-activate",
        tabId: previousTabId,
      });
      return { opened, snapshot, screenshot, closed, restored };
    },
    { conversationId, url },
  );
  expect(evidence).toMatchObject({
    opened: { ok: true },
    snapshot: { ok: false, code: "invalid" },
    screenshot: { ok: false, code: "invalid" },
    closed: { ok: true },
    restored: { ok: true },
  });
  expect(JSON.stringify(evidence)).not.toContain(forbiddenText);
}
