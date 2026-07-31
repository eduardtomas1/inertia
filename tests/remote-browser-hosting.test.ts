import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  createServer as createViteServer,
  type ViteDevServer,
} from "vite";

let server: ViteDevServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe("Remote Companion reference browser hosting", () => {
  it("sends frame-ancestor protection in the HTTP response", async () => {
    server = await createViteServer({
      configFile: resolve("remote/browser/vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
      },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") {
      throw new Error("Reference browser server did not bind.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
