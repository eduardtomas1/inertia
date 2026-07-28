import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  previewNavigationTarget,
  safeHttpUrl,
} from "../../src/shared/preview-url";

describe("main preview URL boundary", () => {
  it.each([
    "http://localhost:3000/",
    "https://localhost:3000/",
    "http://127.0.0.1:4173/",
    "https://[::1]:8443/",
  ])("embeds only a literal loopback origin: %s", (value) => {
    expect(previewNavigationTarget(value)).toMatchObject({
      kind: "embed",
      url: new URL(value),
    });
  });

  it.each([
    "https://example.com/",
    "https://127.0.0.2/",
    "https://[::ffff:127.0.0.1]/",
    "https://localhost.example.com/",
  ])("routes non-literal HTTPS hosts outside the embedded preview: %s", (value) => {
    expect(previewNavigationTarget(value)).toMatchObject({
      kind: "external",
      url: new URL(value),
    });
  });

  it.each([
    "http://example.com/",
    "http://127.0.0.2/",
    "http://localhost.example.com/",
    "javascript:alert(1)",
    "file:///tmp/index.html",
    "https://user:secret@example.com/",
  ])("rejects unsafe preview targets: %s", (value) => {
    expect(() => previewNavigationTarget(value)).toThrow();
  });

  it("keeps the broader external-open policy without weakening preview embedding", () => {
    expect(safeHttpUrl("https://example.com/path").toString())
      .toBe("https://example.com/path");
    expect(previewNavigationTarget("https://example.com/path").kind)
      .toBe("external");
  });

  it("keeps embedded-content navigation deny-only while explicit IPC may open externally", async () => {
    const main = await readFile(
      new URL("../../src/main/index.ts", import.meta.url),
      "utf8",
    );
    const broker = await readFile(
      new URL("../../src/main/preview-broker.ts", import.meta.url),
      "utf8",
    );
    const previewStart = broker.indexOf("#ensure(");
    const embeddedBoundary = broker.slice(previewStart);
    expect(embeddedBoundary).toContain(
      'setWindowOpenHandler(() => ({ action: "deny" }))',
    );
    expect(embeddedBoundary).toContain('on("will-navigate"');
    expect(embeddedBoundary).toContain('on("will-redirect"');
    expect(embeddedBoundary).toContain("event.preventDefault()");
    expect(embeddedBoundary).not.toContain("shell.openExternal");

    const ipcStart = main.indexOf("ipcMain.handle(IPC.previewNavigate");
    const ipcEnd = main.indexOf(
      "\n  ipcMain.handle(IPC.previewCommand",
      ipcStart,
    );
    const explicitIpc = main.slice(ipcStart, ipcEnd);
    expect(explicitIpc).toContain("previewBroker.navigate");
    expect(broker).toContain('target.kind === "external"');
    expect(broker).toContain("this.options.openExternal");
  });

  it("bounds preview ownership to the two conversation panes", async () => {
    const broker = await readFile(
      new URL("../../src/main/preview-broker.ts", import.meta.url),
      "utf8",
    );
    const ownerStart = broker.indexOf("function previewOwner(");
    const ownerEnd = broker.indexOf("\nfunction previewContext", ownerStart);
    const ownerBoundary = broker.slice(ownerStart, ownerEnd);

    expect(ownerBoundary).toContain('value !== "primary"');
    expect(ownerBoundary).toContain('value !== "secondary"');
    expect(ownerBoundary).not.toContain("RegExp");
  });

  it("hardens each shared session once and cancels download fallbacks", async () => {
    const broker = await readFile(
      new URL("../../src/main/preview-broker.ts", import.meta.url),
      "utf8",
    );
    expect(broker).toContain("new WeakSet<Session>()");
    expect(broker).toContain("if (hardenedSessions.has(session)) return");
    expect(broker).toContain('session.on("will-download"');
    expect(broker).toContain("event.preventDefault()");
    expect(broker).toContain("item.cancel()");
  });
});
