import type { IncomingMessage, ServerResponse } from "node:http";

import { expect, type Locator } from "@playwright/test";

const BACKEND_ACCOUNTS_FIXTURE_MODELS = [
  { id: "claude-opus-5-5", display_name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", display_name: "Claude Haiku 5.5" },
] as const;

export function serveBackendAccountsFixture(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (path === "/backend-probe/v1/models" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      data: [{ type: "model", id: "visual-primary-model-with-a-deliberately-long-identifier", display_name: "Visual primary model" }],
      has_more: false,
    }));
    return true;
  }
  if (path === "/backend-accounts/v1/models" && request.method === "GET") {
    if (!request.headers["x-api-key"]) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }));
      return true;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      data: BACKEND_ACCOUNTS_FIXTURE_MODELS.map((model) => ({
        type: "model",
        ...model,
        created_at: "2026-10-01T00:00:00Z",
      })),
      has_more: false,
      first_id: BACKEND_ACCOUNTS_FIXTURE_MODELS[0].id,
      last_id: BACKEND_ACCOUNTS_FIXTURE_MODELS.at(-1)!.id,
    }));
    return true;
  }
  if (path !== "/backend-accounts/v1/messages" || request.method !== "POST") return false;
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    let model = "";
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
      model = typeof body.model === "string" ? body.model : "";
    } catch {
      model = "";
    }
    if (!request.headers["x-api-key"]) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "invalid x-api-key" },
      }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({
        type: "message_start",
        message: { type: "message", model, usage: { input_tokens: 1, output_tokens: 0 } },
      })}`,
      "",
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 1 } })}`,
      "",
      `data: ${JSON.stringify({ type: "message_stop" })}`,
      "",
    ].join("\n"));
  });
  return true;
}

export async function expectBackendSetupFinished(form: Locator, timeout: number): Promise<void> {
  try {
    await expect(form).toHaveCount(0, { timeout });
  } catch (error) {
    const alert = await form.getByRole("alert").allInnerTexts().catch(() => []);
    throw new Error(`Backend setup did not finish: ${alert.join(" ") || "no error shown"}`, { cause: error });
  }
}
