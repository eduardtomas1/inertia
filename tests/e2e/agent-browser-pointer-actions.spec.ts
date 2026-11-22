// @inertia-e2e-resource isolated
import { expect, test } from "@playwright/test";
import { join } from "node:path";

import { RuntimeStore } from "../../src/server/database";
import { createAppFixture, type AppFixture } from "./support/app-fixture";
import { closeWorkspaceTools, ensureWorkspaceTools, selectWorkspaceTool } from "./support/workspace-tools";

interface Result {
  ok: boolean;
  code?: string;
  message?: string;
  text?: string;
}

interface PageSnapshot {
  elements?: Array<{ ref?: string; name: string }>;
}

const PATH = "agent-browser-pointer-actions";

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

function parsed(result: Result): Record<string, unknown> {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
  return JSON.parse(result.text ?? "{}") as Record<string, unknown>;
}

async function refs(): Promise<(name: string) => string> {
  const snapshot = parsed(await browser({ action: "snapshot" })) as PageSnapshot;
  return (name) => {
    const ref = snapshot.elements?.find((element) => element.name === name)?.ref;
    expect(ref, `${name} in ${JSON.stringify(snapshot.elements)}`).toBeTruthy();
    return ref!;
  };
}

async function pageValue<Value>(expression: string, path = PATH): Promise<Value> {
  return await app.electronApp.evaluate(async ({ webContents }, request) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().endsWith(request.path));
    return await contents?.executeJavaScript(request.expression, true) as Value;
  }, { path, expression });
}

async function open(): Promise<void> {
  expect(await browser({ action: "navigate", url: `${app.previewUrl}${PATH}` })).toMatchObject({ ok: true });
}

test.beforeAll(async () => {
  app = await createAppFixture({
    name: "agent-browser-pointer-actions",
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

test("an agent double-clicks and clicks holding keys", async () => {
  await open();
  const ref = await refs();
  expect(parsed(await browser({ action: "click", ref: ref("Open twice"), clickCount: 2 })))
    .toMatchObject({ clickCount: 2 });
  await expect.poll(() => pageValue<string[]>("window.__clicks")).toEqual(["1:false:false:false:false", "2:false:false:false:false", "dblclick"]);
  await pageValue("window.__clicks = []");
  expect(await browser({ action: "click", ref: ref("Open twice"), modifiers: ["Shift", "Alt"] })).toMatchObject({ ok: true });
  await expect.poll(() => pageValue<string[]>("window.__clicks")).toEqual(["1:true:false:true:false"]);
});

test("an agent presses keys holding modifiers in the focused field", async () => {
  await open();
  const ref = await refs();
  expect(await browser({ action: "click", ref: ref("Keys field") })).toMatchObject({ ok: true });
  await pageValue("document.querySelector('#field').setSelectionRange(3, 3)");
  expect(parsed(await browser({ action: "press", key: "ArrowLeft", modifiers: ["Shift"] })))
    .toMatchObject({ pressed: "Shift+ArrowLeft" });
  expect(await pageValue<number[]>("[document.querySelector('#field').selectionStart, document.querySelector('#field').selectionEnd]"))
    .toEqual([2, 3]);
  expect(parsed(await browser({ action: "press", key: "Shift+Tab", modifiers: ["Control"] })))
    .toMatchObject({ pressed: "Control+Shift+Tab" });
  await expect.poll(() => pageValue<string[]>("window.__keys"))
    .toEqual(["ArrowLeft:true:false:false:false", "Tab:true:true:false:false"]);
});

test("an agent scrolls down and right by the pixels it asks for", async () => {
  await open();
  expect(parsed(await browser({ action: "scroll", deltaY: 300 }))).toMatchObject({ scrolled: 300 });
  await expect.poll(() => pageValue<number>("scrollY")).toBe(300);
  expect(parsed(await browser({ action: "scroll", deltaX: 200 }))).toMatchObject({ scrolled: { deltaX: 200 } });
  await expect.poll(() => pageValue<number>("scrollX")).toBe(200);
  expect(await browser({ action: "scroll", deltaX: -50, deltaY: -100 })).toMatchObject({ ok: true });
  await expect.poll(() => pageValue<number[]>("[scrollX, scrollY]")).toEqual([150, 200]);
});

test("an agent drags with the pointer and with native drag and drop", async () => {
  await open();
  const ref = await refs();
  expect(parsed(await browser({ action: "drag", ref: ref("Pointer card"), targetRef: ref("Done column") })))
    .toMatchObject({ native: false });
  await expect.poll(() => pageValue<string[]>("window.__drops")).toEqual(["pointer:column:true"]);
  await pageValue("window.__drops = []");
  expect(parsed(await browser({ action: "drag", ref: ref("Native card"), targetRef: ref("Native zone") })))
    .toMatchObject({ native: true });
  await expect.poll(() => pageValue<string[]>("window.__drops")).toEqual(["native:card-7", "dragend"]);
  expect(app.rendererErrors).toEqual([]);
});

test("an agent drags precisely on a desktop viewport scaled into a narrower panel", async () => {
  const panel = await ensureWorkspaceTools(app.page);
  try {
    await selectWorkspaceTool(panel, "Browser");
    await open();
    await expect.poll(() => app.nativePreviewIsVisible(`${app.previewUrl}${PATH}`)).toBe(true);
    // Let the opening panel settle first: a drag refuses if the page's bounds change while it runs.
    const stage = panel.locator(".preview-safe-stage");
    await expect.poll(async () => {
      const box = await stage.boundingBox();
      const view = (await app.nativePreviewSnapshot(`${app.previewUrl}${PATH}`)).bounds;
      return box !== null && view !== null
        && view.x === Math.round(box.x) && view.y === Math.round(box.y)
        && view.width === Math.round(box.width) && view.height === Math.round(box.height);
    }).toBe(true);
    expect(await browser({ action: "resize", preset: "desktop" })).toMatchObject({ ok: true });
    await expect.poll(() => pageValue<number>("innerWidth")).toBe(1_280);
    const ref = await refs();
    await pageValue("window.__drops = []");
    // Name the refusal when a drag fails, so a CI failure says why.
    const pointerDrag = await browser({ action: "drag", ref: ref("Pointer card"), targetRef: ref("Done column") });
    expect(pointerDrag, JSON.stringify(pointerDrag)).toMatchObject({ ok: true });
    const nativeDrag = await browser({ action: "drag", ref: ref("Native card"), targetRef: ref("Native zone") });
    expect(nativeDrag, JSON.stringify(nativeDrag)).toMatchObject({ ok: true });
    await expect.poll(() => pageValue<string[]>("window.__drops"))
      .toEqual(["pointer:column:true", "native:card-7", "dragend"]);
  } finally {
    expect(await browser({ action: "resize", preset: "fit" })).toMatchObject({ ok: true });
    await closeWorkspaceTools(app.page);
  }
});

test("an agent waits for the page path, never seeing it", async () => {
  await open();
  const ref = await refs();
  expect(parsed(await browser({ action: "wait", path: `/${PATH}`, state: "present", timeoutMs: 1_000 })))
    .toMatchObject({ matched: true });
  expect(await browser({ action: "click", ref: ref("Open order") })).toMatchObject({ ok: true });
  const reached = parsed(await browser({ action: "wait", path: "/orders/*", state: "present", timeoutMs: 5_000 }));
  expect(reached).toMatchObject({ matched: true });
  expect(JSON.stringify(reached)).not.toContain("/orders/7");
  expect(parsed(await browser({ action: "wait", path: "/orders", state: "present", timeoutMs: 250 })))
    .toMatchObject({ matched: false });
  expect(parsed(await browser({ action: "wait", ref: ref("Open order"), state: "absent", timeoutMs: 250 })))
    .toMatchObject({ matched: false });
});
