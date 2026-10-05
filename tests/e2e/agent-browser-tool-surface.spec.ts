// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";

interface Result {
  ok: boolean;
  code?: string;
  message?: string;
  text?: string;
  state?: { controller?: string };
}

interface PageSnapshot {
  title?: string;
  text?: string;
  controller?: string;
  dialogs?: Array<{ kind: string; message: string; answer: string }>;
  elements?: Array<{ ref?: string; name: string; offscreen?: boolean }>;
}

let app!: AppFixture;
let conversationId = "";

async function browser(command: Record<string, unknown>): Promise<Result> {
  return await app.electronApp.evaluate(async (_electron, request) => {
    const runtime = Reflect.get(globalThis, "__inertiaTestRuntime") as {
      agentBrowser: (conversationId: string, command: unknown) => Promise<Result>;
    };
    return await runtime.agentBrowser(request.id, request.command);
  }, { id: conversationId, command });
}

function parsed(result: Result): PageSnapshot & Record<string, unknown> {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return JSON.parse(result.text ?? "{}") as PageSnapshot & Record<string, unknown>;
}

function refFor(snapshot: PageSnapshot, name: string): string {
  const ref = snapshot.elements?.find((element) => element.name === name)?.ref;
  expect(ref, `${name} in ${JSON.stringify(snapshot.elements)}`).toBeTruthy();
  return ref!;
}

async function pageValue<Value>(path: string, expression: string): Promise<Value> {
  return await app.electronApp.evaluate(async ({ webContents }, request) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith(request.path));
    return await contents?.executeJavaScript(request.expression, true) as Value;
  }, { path, expression });
}

async function navigate(path: string): Promise<void> {
  expect(await browser({ action: "navigate", url: `${app.previewUrl}${path}` }), path).toMatchObject({ ok: true });
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "agent-browser-tool-surface",
    initialState: "conversation",
    beforeLaunch: ({ testDirectory, workspaceDirectory }) => {
      const store = new RuntimeStore(join(testDirectory, "data", "inertia.sqlite"), workspaceDirectory, {
        recoverInterruptedRuns: false,
      });
      try {
        conversationId = store.snapshot().conversations[0]!.id;
      } finally {
        store.close();
      }
    },
  });
});

test.afterAll(async () => {
  await app?.close();
});

test("an agent reaches a control below the fold by ref", async () => {
  await navigate("agent-browser-below-fold");
  const snapshot = parsed(await browser({ action: "snapshot" }));
  expect(snapshot.elements).toContainEqual(expect.objectContaining({ name: "Save at the bottom", offscreen: true }));
  const ref = refFor(snapshot, "Save at the bottom");
  expect(await browser({ action: "click", ref })).toMatchObject({ ok: true });
  await expect.poll(() => pageValue<boolean>("agent-browser-below-fold", "window.__bottomClicked === true")).toBe(true);
  expect(await pageValue<number>("agent-browser-below-fold", "scrollY")).toBeGreaterThan(0);

  await navigate("agent-browser-below-fold");
  const again = parsed(await browser({ action: "snapshot" }));
  const scrolled = parsed(await browser({ action: "scroll", ref: refFor(again, "Save at the bottom") }));
  expect(scrolled).toMatchObject({ viewport: { scrollY: expect.any(Number) } });
  expect((scrolled.viewport as { scrollY: number }).scrollY).toBeGreaterThan(0);
  const inView = parsed(await browser({ action: "snapshot" }));
  expect(inView.elements?.find((element) => element.name === "Save at the bottom")).not.toHaveProperty("offscreen");
});

test("an agent goes back through history and opens a schemeless loopback address", async () => {
  const origin = new URL(app.previewUrl);
  expect(await browser({ action: "navigate", url: `${origin.host}/agent-browser-history-first` })).toMatchObject({ ok: true });
  await navigate("agent-browser-history-second");
  expect(parsed(await browser({ action: "snapshot" })).title).toBe("Second page");
  expect(await browser({ action: "history", direction: "back" })).toMatchObject({ ok: true });
  const back = parsed(await browser({ action: "snapshot" }));
  expect(back.title).toBe("First page");
  expect(back.text).toContain("First page body");
  expect(await browser({ action: "history", direction: "forward" })).toMatchObject({ ok: true });
  expect(parsed(await browser({ action: "snapshot" })).title).toBe("Second page");
  expect(await browser({ action: "history", direction: "reload" })).toMatchObject({ ok: true });
  expect(parsed(await browser({ action: "snapshot" })).title).toBe("Second page");
});

test("Shift+Tab moves focus backwards", async () => {
  await navigate("agent-browser-focus-order");
  const snapshot = parsed(await browser({ action: "snapshot" }));
  expect(await browser({ action: "type", ref: refFor(snapshot, "Second field"), text: "b", replace: true }))
    .toMatchObject({ ok: true });
  expect(await pageValue<string>("agent-browser-focus-order", "document.activeElement.id")).toBe("second");
  expect(await browser({ action: "press", key: "Shift+Tab" })).toMatchObject({ ok: true });
  expect(await pageValue<string>("agent-browser-focus-order", "document.activeElement.id")).toBe("first");
});

test("an agent sees a confirmation dialog and accepts it only when it asks to", async () => {
  await navigate("agent-browser-confirm");
  const snapshot = parsed(await browser({ action: "snapshot" }));
  const ref = refFor(snapshot, "Delete item");
  const dismissed = parsed(await browser({ action: "click", ref }));
  expect(dismissed.dialogs).toEqual([{ kind: "confirm", message: "Delete?", answer: "dismiss" }]);
  const after = parsed(await browser({ action: "snapshot" }));
  expect(after.text).not.toContain("Deleted");
  expect(after).not.toHaveProperty("dialogs");

  const accepted = parsed(await browser({ action: "click", ref, dialog: "accept" }));
  expect(accepted.dialogs).toEqual([{ kind: "confirm", message: "Delete?", answer: "accept" }]);
  expect(parsed(await browser({ action: "snapshot" })).text).toContain("Deleted");
});

test("the user takes over the page during an agent command", async () => {
  await navigate("agent-browser-history-first");
  const waiting = browser({ action: "wait", text: "never shown", state: "present", timeoutMs: 20_000 });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await app.electronApp.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents()
      .find((candidate) => candidate.getURL().endsWith("agent-browser-history-first"));
    contents?.sendInputEvent({ type: "mouseDown", x: 20, y: 20, button: "left", clickCount: 1 });
    contents?.sendInputEvent({ type: "mouseUp", x: 20, y: 20, button: "left", clickCount: 1 });
  });
  expect(await waiting).toEqual({
    ok: false,
    code: "interrupted",
    message: "The user is using this page; take a new snapshot before continuing.",
  });
  expect(await browser({ action: "tabs" })).toMatchObject({ ok: true, state: { controller: "user" } });
  expect(await browser({ action: "snapshot" })).toMatchObject({ ok: true, state: { controller: "user" } });
  const tabs = await browser({ action: "tabs" });
  expect(tabs.ok).toBe(true);
  expect(tabs.state).not.toHaveProperty("controller");
  expect(app.rendererErrors).toEqual([]);
});
