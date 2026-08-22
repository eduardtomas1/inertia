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

export async function expectHoverRetargetingGuard(
  app: AppFixture,
  conversationId: string,
  url: string,
  ref: string,
): Promise<void> {
  const evidence = await app.electronApp.evaluate(
    async ({ webContents }, request) => {
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (
          id: string,
          command: { action: "click"; ref: string },
        ) => Promise<{ code?: string; ok: boolean }>;
      };
      const result = await runtime.agentBrowser(request.conversationId, {
        action: "click",
        ref: request.ref,
      });
      const contents = webContents.getAllWebContents().find(
        (candidate) => candidate.getURL() === request.url,
      );
      const state = await contents?.executeJavaScript(`({
        target: window.__hoverTargetClicked === true,
        decoy: window.__hoverDecoyClicked === true,
      })`);
      return { result, state };
    },
    { conversationId, ref, url },
  );
  expect(evidence).toMatchObject({
    result: { ok: false, code: "not-found" },
    state: { target: false, decoy: false },
  });
}

export async function expectSemanticClickBoundaries(
  app: AppFixture,
  conversationId: string,
  url: string,
): Promise<void> {
  const evidence = await app.electronApp.evaluate(
    async ({ webContents }, request) => {
      type Command = { action: "snapshot" } | { action: "click"; ref: string };
      type Result = { code?: string; ok: boolean; text?: string };
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (id: string, command: Command) => Promise<Result>;
      };
      const snapshot = await runtime.agentBrowser(request.conversationId, { action: "snapshot" });
      if (!snapshot.ok || !snapshot.text) return { snapshot };
      const elements = (JSON.parse(snapshot.text) as {
        elements: Array<{ name: string; ref: string }>;
      }).elements;
      const outerRef = elements.find((element) => element.name === "Outer nested action")?.ref;
      const opacityRef = elements.find((element) => element.name === "Temporarily visible action")?.ref;
      if (!outerRef || !opacityRef) return { outerRef, opacityRef, snapshot };
      const nested = await runtime.agentBrowser(request.conversationId, { action: "click", ref: outerRef });
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === request.url);
      await contents?.executeJavaScript("document.querySelector('#opacity-parent').style.opacity='0'");
      const hidden = await runtime.agentBrowser(request.conversationId, { action: "click", ref: opacityRef });
      const hiddenSnapshot = await runtime.agentBrowser(request.conversationId, { action: "snapshot" });
      const hiddenNames = hiddenSnapshot.text
        ? (JSON.parse(hiddenSnapshot.text) as { elements: Array<{ name: string }> }).elements.map((element) => element.name)
        : [];
      const state = await contents?.executeJavaScript(`({
        outer: window.__outerActionClicked === true,
        inner: window.__innerActionClicked === true,
        opacity: window.__opacityActionClicked === true,
      })`);
      return { hidden, hiddenNames, hiddenSnapshot, nested, state };
    },
    { conversationId, url },
  );
  expect(evidence).toMatchObject({
    nested: { ok: false, code: "not-found" },
    hiddenSnapshot: { ok: true },
    hidden: { ok: false, code: "not-found" },
    state: { outer: false, inner: false, opacity: false },
  });
  expect(evidence.hiddenNames).not.toContain("Temporarily visible action");
}

export async function expectFocusNavigationSettlement(
  app: AppFixture,
  conversationId: string,
  destinationUrl: string,
): Promise<void> {
  const evidence = await app.electronApp.evaluate(
    async (_electron, request) => {
      type Command =
        | { action: "snapshot" | "tabs" }
        | { action: "type"; ref: string; replace: boolean; text: string };
      type Result = { ok: boolean; text?: string };
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (id: string, command: Command) => Promise<Result>;
      };
      const snapshot = await runtime.agentBrowser(request.conversationId, {
        action: "snapshot",
      });
      if (!snapshot.ok || !snapshot.text) return { snapshot };
      const parsed = JSON.parse(snapshot.text) as {
        elements: Array<{ name: string; ref: string }>;
      };
      const ref = parsed.elements.find(
        (element) => element.name === "Focus navigation",
      )?.ref;
      if (!ref) return { snapshot, ref };
      let typeSettled = false;
      let tabsSettled = false;
      const typing = runtime.agentBrowser(request.conversationId, {
        action: "type", ref, replace: true, text: "wait for navigation",
      }).finally(() => { typeSettled = true; });
      const tabs = runtime.agentBrowser(request.conversationId, { action: "tabs" })
        .finally(() => { tabsSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const early = { tabsSettled, typeSettled };
      return { early, tabs: await tabs, typing: await typing };
    },
    { conversationId },
  );
  expect(evidence).toMatchObject({
    early: { tabsSettled: false, typeSettled: false },
    tabs: { ok: true },
  });
  await expect.poll(() => app.electronApp.evaluate(
    ({ webContents }, url) => webContents.getAllWebContents().some(
      (contents) => contents.getURL() === url
        && contents.getTitle() === "Agent browser focus destination",
    ),
    destinationUrl,
  )).toBe(true);
}
