import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createSurfaceRuntime, SURFACE_SECRET_VALUE } from "../helpers/agent-tool-surface";

describe("active-secret host tool arguments", () => {
  it("rejects transcript-writing inputs before they enter messages, HTML, cards or the database", async () => {
    const runtime = await createSurfaceRuntime();
    try {
      const child = await runtime.createManagedChat("Target");
      runtime.secrets.output.setValues([SURFACE_SECRET_VALUE]);
      const calls = [
        { tool: "inertia_create_conversation", arguments: { title: "Child", prompt: SURFACE_SECRET_VALUE } },
        { tool: "inertia_create_conversation", arguments: { title: SURFACE_SECRET_VALUE, prompt: "Work" } },
        { tool: "inertia_send_message", arguments: { conversationId: child, content: SURFACE_SECRET_VALUE } },
        { tool: "inertia_render_html", arguments: { html: `<p>${SURFACE_SECRET_VALUE}</p>`, title: "Page" } },
        { tool: "inertia_request_secret", arguments: { title: "New key", description: SURFACE_SECRET_VALUE } },
      ];
      for (const call of calls) {
        const result = await runtime.bridge.invoke({
          ...call,
          providerThreadId: "thread",
          providerTurnId: "turn",
          toolCallId: randomUUID(),
          signal: new AbortController().signal,
          requestApproval: async () => "approve",
        });
        expect(result.success, call.tool).toBe(false);
        expect(JSON.parse(result.text), call.tool).toMatchObject({ error: { code: "secret_value_not_allowed" } });
        expect(result.text).not.toContain(SURFACE_SECRET_VALUE);
      }
      expect(runtime.store.transcriptRepository.secretRequests.pendingAll()).toEqual([]);
      for (const name of readdirSync(runtime.root).filter((entry) => entry.startsWith("inertia.sqlite"))) {
        expect(readFileSync(join(runtime.root, name)).includes(SURFACE_SECRET_VALUE), name).toBe(false);
      }
    } finally {
      await runtime.close();
    }
  });

  it("allows typing an active secret into a browser field", async () => {
    const perform = vi.fn(async () => ({ status: "unavailable", message: "Test browser" }));
    const runtime = await createSurfaceRuntime({ browser: { perform } as never });
    try {
      runtime.secrets.output.setValues([SURFACE_SECRET_VALUE]);
      const result = await runtime.bridge.invoke({
        tool: "inertia_browser_type",
        arguments: { ref: "e1", text: SURFACE_SECRET_VALUE },
        providerThreadId: "thread",
        providerTurnId: "turn",
        toolCallId: randomUUID(),
        signal: new AbortController().signal,
        requestApproval: async () => "approve",
      });
      expect(result.text).not.toContain("secret_value_not_allowed");
      expect(perform).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  });
});
