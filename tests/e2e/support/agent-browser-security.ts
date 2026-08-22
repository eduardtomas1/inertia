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
  expect(evidence, `privacy evidence remained available for ${url}`).toMatchObject({
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
      type Command =
        | { action: "snapshot" }
        | { action: "click"; ref: string }
        | { action: "press"; key: "Enter" | "Space" | "Tab" };
      type Result = { code?: string; ok: boolean; text?: string };
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (id: string, command: Command) => Promise<Result>;
      };
      const snapshot = await runtime.agentBrowser(request.conversationId, { action: "snapshot" });
      if (!snapshot.ok || !snapshot.text) return { snapshot };
      const elements = (JSON.parse(snapshot.text) as {
        elements: Array<{ disabled: boolean; name: string; ref: string }>;
      }).elements;
      const outerRef = elements.find((element) => element.name === "Outer nested action")?.ref;
      const opacityRef = elements.find((element) => element.name === "Temporarily visible action")?.ref;
      const ariaDisabled = elements.find((element) => element.name === "Inherited disabled action");
      if (!outerRef || !opacityRef || !ariaDisabled) {
        return { ariaDisabled, names: elements.map((element) => element.name), outerRef, opacityRef, snapshot };
      }
      const nested = await runtime.agentBrowser(request.conversationId, { action: "click", ref: outerRef });
      const inheritedDisabled = await runtime.agentBrowser(request.conversationId, {
        action: "click", ref: ariaDisabled.ref,
      });
      const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === request.url);
      await contents?.executeJavaScript("document.querySelector('#opacity-parent').style.opacity='0'");
      const hidden = await runtime.agentBrowser(request.conversationId, { action: "click", ref: opacityRef });
      const hiddenSnapshot = await runtime.agentBrowser(request.conversationId, { action: "snapshot" });
      const hiddenNames = hiddenSnapshot.text
        ? (JSON.parse(hiddenSnapshot.text) as { elements: Array<{ name: string }> }).elements.map((element) => element.name)
        : [];
      await contents?.executeJavaScript("document.activeElement?.blur()", true);
      const tabResults = [];
      let focused = "";
      for (let index = 0; index < 8; index += 1) {
        tabResults.push(await runtime.agentBrowser(request.conversationId, { action: "press", key: "Tab" }));
        focused = await contents?.executeJavaScript("document.activeElement?.id") as string || "";
        if (focused === "aria-disabled-action") break;
      }
      const disabledEnter = await runtime.agentBrowser(request.conversationId, {
        action: "press", key: "Enter",
      });
      const disabledSpace = await runtime.agentBrowser(request.conversationId, {
        action: "press", key: "Space",
      });
      const state = await contents?.executeJavaScript(`({
        outer: window.__outerActionClicked === true,
        inner: window.__innerActionClicked === true,
        opacity: window.__opacityActionClicked === true,
        ariaDisabled: window.__ariaDisabledActionClicked === true,
      })`);
      return {
        ariaDisabled, disabledEnter, disabledSpace, focused, hidden, hiddenNames,
        hiddenSnapshot, inheritedDisabled, nested, state, tabResults,
      };
    },
    { conversationId, url },
  );
  expect(evidence.ariaDisabled, JSON.stringify(evidence)).toBeDefined();
  expect(evidence).toMatchObject({
    nested: { ok: false, code: "not-found" },
    ariaDisabled: { disabled: true },
    inheritedDisabled: { ok: false, code: "invalid" },
    disabledEnter: { ok: false, code: "invalid" },
    disabledSpace: { ok: false, code: "invalid" },
    focused: "aria-disabled-action",
    hiddenSnapshot: { ok: true },
    hidden: { ok: false, code: "not-found" },
    state: { outer: false, inner: false, opacity: false, ariaDisabled: false },
  });
  const tabResults = evidence.tabResults ?? [];
  expect(tabResults.length).toBeGreaterThan(0);
  expect(tabResults.length).toBeLessThanOrEqual(8);
  expect(tabResults.every((result) => result.ok)).toBe(true);
  expect(evidence.hiddenNames).not.toContain("Temporarily visible action");
}

export async function expectClosedShadowActivationBlocked(
  app: AppFixture,
  conversationId: string,
  url: string,
): Promise<void> {
  const evidence = await app.electronApp.evaluate(async ({ webContents }, request) => {
    type Command =
      | { action: "navigate"; url: string }
      | { action: "press"; key: "Enter" | "Space" | "Tab" };
    type Result = { code?: string; ok: boolean };
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      agentBrowser: (id: string, command: Command) => Promise<Result>;
    };
    const navigation = await runtime.agentBrowser(request.conversationId, {
      action: "navigate", url: request.url,
    });
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === request.url);
    const hostFocused = await contents?.executeJavaScript("window.__closedHostFocused === true");
    const enter = await runtime.agentBrowser(request.conversationId, { action: "press", key: "Enter" });
    const space = await runtime.agentBrowser(request.conversationId, { action: "press", key: "Space" });
    const clicked = await contents?.executeJavaScript("window.__closedDisabledActionClicked === true");
    const interleaveNavigation = await runtime.agentBrowser(request.conversationId, {
      action: "navigate", url: `${new URL(request.url).origin}/agent-browser-focus-interleave`,
    });
    const interleaveContents = webContents.getAllWebContents().find(
      (candidate) => candidate.getURL().endsWith("/agent-browser-focus-interleave"),
    );
    const prepared = await runtime.agentBrowser(request.conversationId, { action: "press", key: "Tab" });
    const armed = await interleaveContents?.executeJavaScript("window.__armDisabledFocus()", true);
    const interleavedEnter = await runtime.agentBrowser(request.conversationId, { action: "press", key: "Enter" });
    const interleavedClicked = await interleaveContents?.executeJavaScript("window.__lateDisabledClicked === true");
    const interleavedFocus = await interleaveContents?.executeJavaScript("document.activeElement?.id");
    return {
      armed, clicked, enter, hostFocused, interleaveNavigation, interleavedClicked,
      interleavedEnter, interleavedFocus, navigation, prepared, space,
    };
  }, { conversationId, url });
  expect(evidence).toMatchObject({
    clicked: false,
    enter: { code: "invalid", ok: false },
    hostFocused: true,
    interleaveNavigation: { ok: true },
    interleavedClicked: false,
    interleavedEnter: { code: "invalid", ok: false },
    interleavedFocus: "late-disabled",
    navigation: { ok: true },
    prepared: { ok: true },
    space: { code: "invalid", ok: false },
  });
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

export async function expectMicrotaskFocusTheftBlocked(
  app: AppFixture,
  conversationId: string,
  url: string,
): Promise<void> {
  const evidence = await app.electronApp.evaluate(
    async ({ webContents }, request) => {
      type Command =
        | { action: "snapshot" }
        | { action: "type"; ref: string; text: string; replace: boolean };
      type Result = { code?: string; ok: boolean; text?: string };
      const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
        agentBrowser: (id: string, command: Command) => Promise<Result>;
      };
      const snapshot = await runtime.agentBrowser(request.conversationId, { action: "snapshot" });
      if (!snapshot.ok || !snapshot.text) return { snapshot };
      const elements = (JSON.parse(snapshot.text) as {
        elements: Array<{ name: string; ref: string }>;
      }).elements;
      const ref = elements.find((element) => element.name === "Microtask focus target")?.ref;
      const nestedRef = elements.find((element) => element.name === "Nested focus target")?.ref;
      if (!ref || !nestedRef) return { names: elements.map((element) => element.name), snapshot };
      const typing = await runtime.agentBrowser(request.conversationId, {
        action: "type", ref, text: "must not reach either field", replace: true,
      });
      const nestedTyping = await runtime.agentBrowser(request.conversationId, {
        action: "type", ref: nestedRef, text: "must not reach the nested field", replace: true,
      });
      const contents = webContents.getAllWebContents().find(
        (candidate) => candidate.getURL() === request.url,
      );
      const state = await contents?.executeJavaScript(`(() => ({
        target: document.querySelector('[aria-label="Microtask focus target"]')?.value,
        decoy: document.querySelector('[aria-label="Microtask focus decoy"]')?.value,
        nestedDecoy: document.querySelector('[aria-label="Nested focus decoy"]')?.value,
        focused: document.activeElement?.getAttribute('aria-label')
      }))()`);
      return { nestedTyping, state, typing };
    },
    { conversationId, url },
  );
  expect(evidence).toMatchObject({
    typing: { ok: false, code: "not-found" },
    nestedTyping: { ok: false, code: "not-found" },
    state: { target: "", decoy: "", nestedDecoy: "", focused: "Nested focus decoy" },
  });
}
