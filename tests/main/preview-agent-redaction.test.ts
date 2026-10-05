import { runInContext } from "node:vm";

import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";

import { installAgentPagePrivacyGuard, semanticPageSnapshot } from "../../src/main/preview-agent-page";

const windows: Window[] = [];

function page(markup: string) {
  const window = new Window({ url: "http://127.0.0.1:3000/" });
  windows.push(window);
  window.document.body.innerHTML = markup;
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: 1, y: 1, left: 1, top: 1, right: 101, bottom: 21, width: 100, height: 20 }),
  });
  const contents = {
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: Array<{ code: string }>) =>
      runInContext(scripts[0]!.code, window as never),
  };
  const snapshot = async () => JSON.parse(await semanticPageSnapshot(contents as never)) as {
    text: string;
    elements: Array<{ name: string; value?: string }>;
  };
  const type = (selector: string, text: string) => {
    const input = window.document.querySelector(selector) as unknown as HTMLInputElement;
    for (let length = 1; length <= text.length; length += 1) {
      input.value = text.slice(0, length);
      const event = new window.Event("input", { bubbles: true });
      Object.defineProperty(event, "isTrusted", { value: true });
      input.dispatchEvent(event as never);
    }
  };
  return { window, contents, snapshot, type };
}

afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.abort();
});

describe("Browser snapshot redaction", () => {
  it("keeps a page readable after a password is typed one key at a time", async () => {
    const { contents, snapshot, type } = page(`<h1>Welcome back</h1>
      <label>Username <input id="username"></label>
      <label>Password <input id="password" type="password"></label>
      <p>Create a new account. Signed in as admin</p>`);
    await installAgentPagePrivacyGuard(contents as never);
    type("#username", "admin");
    type("#password", "admin123");
    const result = await snapshot();
    expect(result.text).toBe("Welcome back Username Password Create a new account. Signed in as admin");
    expect(result.elements).toEqual([
      expect.objectContaining({ name: "Username", value: "admin" }),
      expect.objectContaining({ name: "Password", value: "[redacted]" }),
    ]);
  });

  it("redacts altered copies of a remembered value in page text", async () => {
    const { snapshot } = page(`<label>Password <input type="password" value="Summer 2026!"></label>
      <p>One <b>Sum</b>mer 2026! two SUMMER 2026! three Summer​ 2026! four</p>`);
    const result = await snapshot();
    expect(result.text).toBe("Password One [redacted] two [redacted] three [redacted] four");
  });

  it("redacts before clipping page text and long control names", async () => {
    const { snapshot } = page(`<label>Password <input type="password" value="hunter2"></label>
      <p>${"a".repeat(11_986)} hunter2 tail</p>
      <button aria-label="${" ".repeat(1_195)}hunter2">Go</button>
      <button>${" ".repeat(1_195)}hunter2</button>`);
    const result = await snapshot();
    expect(JSON.stringify(result)).not.toContain("hunt");
    expect(result.text).toContain(`Password ${"a".repeat(100)}`);
    expect(result.elements).toContainEqual(expect.objectContaining({ name: "[redacted]" }));
  });

  it("keeps whitespace-heavy page text complete once a value is remembered", async () => {
    const words = Array.from({ length: 1_500 }, (_, index) => `w${String(index).padStart(4, "0")}`);
    const { snapshot } = page(`<label>Password <input type="password" value="hunter2"></label>
      <p>${words.join(" ".repeat(10))}</p>`);
    const result = await snapshot() as { text: string; omitted?: unknown };
    expect(result.text.endsWith("w1499")).toBe(true);
    expect(result.omitted).toBeUndefined();
  });
});
