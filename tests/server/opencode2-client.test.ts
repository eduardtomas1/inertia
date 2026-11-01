// @inertia-test-suite portable
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCode2Client } from "../../src/server/provider/opencode2-client";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });
async function server(handle: (request: import("node:http").IncomingMessage, response: ServerResponse) => void) {
  const native = createServer(handle); await new Promise<void>((resolve) => native.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { native.closeAllConnections(); await new Promise<void>((resolve) => native.close(() => resolve())); });
  const address = native.address(); if (!address || typeof address === "string") throw Error("Missing address");
  return `http://127.0.0.1:${address.port}`;
}
const password = "inertia-test-password-never-print";
describe("OpenCode 2 bounded HTTP protocol", () => {
  it("uses the fixed Basic username, exact API path, JSON payload, and no provider error body", async () => {
    const observed: unknown[] = [];
    const url = await server((request, response) => {
      const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        observed.push([request.url, request.headers.authorization, Buffer.concat(chunks).toString()]);
        response.setHeader("content-type", "application/json");
        response.statusCode = request.url === "/api/bad" ? 401 : 200;
        response.end(JSON.stringify(request.url === "/api/bad" ? { error: password } : { data: { id: "ses_exact" } }));
      });
    });
    const client = new OpenCode2Client(url, password);
    expect(await client.request("POST", "/api/session", { title: "literal $() `value`" })).toEqual({ data: { id: "ses_exact" } });
    expect(observed).toEqual([["/api/session", `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, '{"title":"literal $() `value`"}']]);
    await expect(client.request("GET", "/api/bad")).rejects.toThrow("HTTP 401");
    expect(() => new OpenCode2Client("https://example.com", password)).toThrow();
    expect(() => new OpenCode2Client("http://localhost:9999", password)).toThrow();
    await expect(client.request("GET", "//example.com/api/info")).rejects.toThrow();
  });

  it("rejects redirects, malformed UTF-8, oversized bodies and request timeout", async () => {
    let redirected = false;
    const url = await server((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/redirect") { response.writeHead(302, { location: "/api/target" }); response.end(); }
      else if (request.url === "/api/target") { redirected = true; response.end("{}"); }
      else if (request.url === "/api/invalid") response.end(Buffer.from([0xff]));
      else if (request.url === "/api/large") response.end('"' + "x".repeat(17 * 1024 * 1024) + '"');
    });
    const client = new OpenCode2Client(url, password, { timeoutMs: 100 });
    for (const path of ["redirect", "invalid", "large", "never"]) await expect(client.request("GET", `/api/${path}`)).rejects.toThrow("OpenCode 2 request failed.");
    expect(redirected).toBe(false);
  });

  it("acknowledges subscriptions before work and decodes split CRLF and Unicode events", async () => {
    let send!: () => void; let requests = 0;
    const url = await server((_request, response) => {
      requests++; response.setHeader("content-type", "text/event-stream"); response.flushHeaders();
      send = () => {
        const data = Buffer.from(': heartbeat\r\ndata: {"type":"session.text.delta",\r\ndata: "data":{"text":"a\u2028b🙂"}}\r\n\r\n');
        for (const byte of data) response.write(Buffer.from([byte]));
      };
    });
    const events: unknown[] = [];
    const client = new OpenCode2Client(url, password);
    const stream = await client.events((event) => events.push(event));
    expect(events).toEqual([]); send();
    await expect.poll(() => events.length).toBe(1);
    expect(events).toEqual([{ type: "session.text.delta", data: { text: "a\u2028b🙂" } }]);
    await stream.close(); expect(requests).toBe(1);
  });

  it("fails a disconnected, malformed, oversized or silent stream without reconnecting", async () => {
    for (const kind of ["ended", "invalid", "oversized", "silent"]) {
      let requests = 0;
      const url = await server((_request, response) => {
        requests++; response.setHeader("content-type", "text/event-stream"); response.flushHeaders();
        if (kind === "ended") response.end();
        if (kind === "invalid") response.write(Buffer.from([0xff, 10, 10]));
        if (kind === "oversized") response.write("data: " + "x".repeat(2 * 1024 * 1024 + 1));
      });
      const stream = await new OpenCode2Client(url, password, { eventSilenceMs: 100 }).events(() => {});
      await expect(stream.done).rejects.toThrow("OpenCode 2 event stream failed.");
      expect(requests).toBe(1);
    }
  });
});
