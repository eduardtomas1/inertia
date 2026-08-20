import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { handleProviderMcpBody } from "./host-tool-mcp-protocol";
import type { ProviderHostToolRuntime } from "./host-tool-runtime";

const MAX_MCP_BODY_BYTES = 128 * 1024;
const MCP_BODY_TIMEOUT_MS = 10_000;
const MAX_CONCURRENT_MCP_REQUESTS = 8;

export interface ProviderHostToolMcpConnection {
  url: string;
  bearerToken: string;
}

export interface ProviderHostToolMcpSession {
  start(): Promise<ProviderHostToolMcpConnection>;
  close(): Promise<void>;
}

export interface ProviderHostToolMcpSessionTestDependencies {
  /** Test-only close failure seam; production callers must omit it. */
  closeServer?(
    server: Server,
    settled: (error?: Error) => void,
  ): void;
}

type BodyResult =
  | { kind: "ok"; body: unknown }
  | { kind: "invalid" }
  | { kind: "too-large" }
  | { kind: "timeout" }
  | { kind: "cancelled" };

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  if (response.destroyed || response.headersSent) return;
  const encoded = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": encoded.byteLength,
  });
  response.end(encoded);
}

function empty(response: ServerResponse, status: number): void {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { "Cache-Control": "no-store" });
  response.end();
}

function closeUnreadRequest(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  response.setHeader("Connection", "close");
  request.resume();
}

function equalBearer(header: string | undefined, token: string): boolean {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix)) return false;
  const candidate = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(token, "utf8");
  return candidate.byteLength === expected.byteLength
    && timingSafeEqual(candidate, expected);
}

async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
): Promise<BodyResult> {
  const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
    return { kind: "too-large" };
  }
  if (signal.aborted) return { kind: "cancelled" };
  return await new Promise<BodyResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("aborted", onCancelled);
      signal.removeEventListener("abort", onCancelled);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.byteLength;
      if (size > MAX_MCP_BODY_BYTES) {
        finish({ kind: "too-large" });
        request.resume();
        return;
      }
      chunks.push(Buffer.from(chunk));
    };
    const onEnd = (): void => {
      try {
        finish({
          kind: "ok",
          body: JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown,
        });
      } catch {
        finish({ kind: "invalid" });
      }
    };
    const onCancelled = (): void => {
      finish({ kind: "cancelled" });
      request.resume();
    };
    const timer = setTimeout(() => {
      finish({ kind: "timeout" });
      request.resume();
    }, MCP_BODY_TIMEOUT_MS);
    timer.unref();
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("aborted", onCancelled);
    signal.addEventListener("abort", onCancelled, { once: true });
  });
}

/**
 * One loopback-only, bearer-authenticated MCP endpoint owned by one provider
 * run. The bearer is returned only to the provider config builder and is never
 * persisted or rendered.
 */
export function createProviderHostToolMcpSession(
  runtime: ProviderHostToolRuntime,
  testDependencies: ProviderHostToolMcpSessionTestDependencies = {},
): ProviderHostToolMcpSession {
  const token = randomBytes(32).toString("base64url");
  const requests = new Set<AbortController>();
  let port: number | undefined;
  let active = 0;
  let closed = false;
  let startPromise: Promise<ProviderHostToolMcpConnection> | undefined;
  let closePromise: Promise<void> | undefined;

  const server = createServer((request, response) => {
    const controller = new AbortController();
    requests.add(controller);
    void (async () => {
      if (
        closed
        || port === undefined
        || request.headers.host !== `127.0.0.1:${port}`
        || request.headers.origin !== undefined
        || !equalBearer(request.headers.authorization, token)
      ) {
        closeUnreadRequest(request, response);
        json(response, 401, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Provider MCP session is inactive or unauthorised." },
        });
        return;
      }
      if (request.method !== "POST") {
        closeUnreadRequest(request, response);
        response.setHeader("Allow", "POST");
        empty(response, 405);
        return;
      }
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        closeUnreadRequest(request, response);
        json(response, 415, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "MCP requests require application/json." },
        });
        return;
      }
      if (active >= MAX_CONCURRENT_MCP_REQUESTS) {
        closeUnreadRequest(request, response);
        json(response, 429, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Too many concurrent provider MCP requests." },
        });
        return;
      }
      active += 1;
      try {
        const body = await readBody(request, controller.signal);
        if (body.kind === "cancelled") return;
        if (body.kind === "too-large") {
          closeUnreadRequest(request, response);
          json(response, 413, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "MCP request body exceeds the 128 KiB limit." },
          });
          return;
        }
        if (body.kind === "timeout") {
          closeUnreadRequest(request, response);
          json(response, 408, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "MCP request body timed out." },
          });
          return;
        }
        if (body.kind === "invalid") {
          json(response, 400, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Invalid JSON body." },
          });
          return;
        }
        const result = await handleProviderMcpBody(
          body.body,
          runtime,
          controller.signal,
        );
        if (result.body === undefined) empty(response, result.status);
        else json(response, result.status, result.body);
      } finally {
        active -= 1;
      }
    })().catch(() => {
      json(response, 500, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Provider MCP request failed." },
      });
    }).finally(() => requests.delete(controller));
  });
  server.keepAliveTimeout = 1_000;
  server.headersTimeout = MCP_BODY_TIMEOUT_MS + 1_000;
  server.requestTimeout = MCP_BODY_TIMEOUT_MS + 1_000;
  server.on("error", () => {
    runtime.settle();
    for (const controller of requests) controller.abort();
  });

  return {
    start: () => {
      startPromise ??= new Promise<ProviderHostToolMcpConnection>((resolve, reject) => {
        if (closed) {
          reject(new Error("Provider MCP session is already closed."));
          return;
        }
        const fail = (): void => reject(new Error("Provider MCP session could not start."));
        server.once("error", fail);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", fail);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Provider MCP session did not receive a loopback port."));
            return;
          }
          port = address.port;
          resolve({
            url: `http://127.0.0.1:${port}/mcp`,
            bearerToken: token,
          });
        });
      });
      return startPromise;
    },
    close: () => {
      closePromise ??= (async () => {
        closed = true;
        runtime.settle();
        for (const controller of requests) controller.abort();
        requests.clear();
        await startPromise?.catch(() => undefined);
        await new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          const settled = (error?: Error): void => {
            if (error) reject(new Error("Provider MCP session could not be confirmed closed."));
            else resolve();
          };
          if (testDependencies.closeServer) {
            testDependencies.closeServer(server, settled);
          } else {
            server.close(settled);
          }
          server.closeAllConnections();
        });
      })();
      return closePromise;
    },
  };
}
