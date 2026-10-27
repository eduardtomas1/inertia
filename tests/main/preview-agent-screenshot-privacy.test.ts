import { runInContext } from "node:vm";

import { Window } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ nativeImage: {} }));

import { installAgentPagePrivacyGuard } from "../../src/main/preview-agent-page";
import { agentPageScreenshotPrivacy } from "../../src/main/preview-agent-screenshot";

const secret = "API_KEY=sk-visible-token-that-must-not-enter-a-bitmap";
const windows: Window[] = [];

function painted(window: Window): void {
  Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ x: 1, y: 1, left: 1, top: 1, right: 101, bottom: 21, width: 100, height: 20 }),
  });
}

async function page(markup: string) {
  const window = new Window({ url: "http://127.0.0.1:3000/" });
  windows.push(window);
  painted(window);
  window.document.body.innerHTML = markup;
  const contents = {
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: Array<{ code: string }>) =>
      runInContext(scripts[0]!.code, window as never),
  };
  await installAgentPagePrivacyGuard(contents as never);
  const frame = (selector: string, inner: string) => {
    const child = new Window({ url: "http://127.0.0.1:3000/child" });
    windows.push(child);
    painted(child);
    child.document.body.innerHTML = inner;
    Object.defineProperty(window.document.querySelector(selector), "contentDocument", {
      configurable: true,
      get: () => child.document,
    });
  };
  const privacy = async () => await agentPageScreenshotPrivacy(contents as never);
  return { window, frame, privacy };
}

afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.abort();
});

describe("Browser screenshot privacy beyond the top-level document", () => {
  it("captures an ordinary page with ordinary frames and components", async () => {
    const { window, frame, privacy } = await page(
      "<h1>Orders</h1><div id='host'></div><iframe id='help' title='Help'></iframe>",
    );
    window.document.querySelector("#host")!.attachShadow({ mode: "open" }).innerHTML = "<p>Ordinary widget</p>";
    frame("#help", "<p>Ordinary help</p><label>Search <input value='orders'></label>");
    await expect(privacy()).resolves.toBe("clear");
  });

  it("withholds a token shown inside an open shadow root", async () => {
    const { window, privacy } = await page("<h1>Settings</h1><div id='host'></div>");
    const outer = window.document.querySelector("#host")!.attachShadow({ mode: "open" });
    outer.innerHTML = "<section><span id='inner'></span></section>";
    outer.querySelector("#inner")!.attachShadow({ mode: "open" }).innerHTML = `<code>${secret}</code>`;
    await expect(privacy()).resolves.toBe("sensitive");
  });

  it("withholds a token or a filled password inside a same-origin frame", async () => {
    const shown = await page("<h1>Dashboard</h1><iframe id='report'></iframe>");
    shown.frame("#report", `<pre>${secret}</pre>`);
    await expect(shown.privacy()).resolves.toBe("sensitive");

    const filled = await page("<h1>Dashboard</h1><iframe id='login'></iframe>");
    filled.frame("#login", "<label>Password <input type='password' value='frame-password-sentinel'></label>");
    await expect(filled.privacy()).resolves.toBe("sensitive");
  });

  it("keeps the image local when a closed shadow root or a cross-origin frame is shown", async () => {
    const closed = await page("<h1>Component</h1><div id='host'></div>");
    closed.window.document.dispatchEvent(new closed.window.Event("__inertia_agent_closed_boundary__"));
    await expect(closed.privacy()).resolves.toBe("unreadable");

    const remote = await page("<h1>Embed</h1><iframe src='http://127.0.0.1:4000/widget'></iframe>");
    await expect(remote.privacy()).resolves.toBe("unreadable");
  });

  it("ignores a cross-origin frame that paints nothing", async () => {
    const { window, privacy } = await page("<h1>Embed</h1><iframe id='beacon' src='http://127.0.0.1:4000/beacon'></iframe>");
    Object.defineProperty(window.document.querySelector("#beacon"), "getBoundingClientRect", {
      value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    });
    await expect(privacy()).resolves.toBe("clear");
  });

  it("fails closed when nested content is larger than Inertia reads", async () => {
    const { window, privacy } = await page("<div id='host'></div>");
    window.document.querySelector("#host")!.attachShadow({ mode: "open" }).innerHTML = "<i>x</i>".repeat(2_100);
    await expect(privacy()).resolves.toBe("sensitive");
  });
});
