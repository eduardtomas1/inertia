import { describe, expect, it } from "vitest";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { AgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { ClaudeSubagentTraceTracker } from "../../src/server/provider/claude-subagent-trace";
import { scrubCommandSecrets } from "../../src/server/provider/command-secrets";
import {
  subagentActivityLabel,
  subagentStepKeyInput,
  subagentStepLabel,
} from "../../src/server/provider/subagent-steps";

const SECRET_CALLS: Array<[string, Record<string, unknown>, string, string]> = [
  ["Bash", { command: "deploy --client-secret s3cr3tvalue99 --region eu" }, "s3cr3tvalue99", "--region eu"],
  ["Bash", { command: "MY_SERVICE_KEY=hunter2hunter2 node app.js" }, "hunter2hunter2", "node app.js"],
  [
    "WebFetch",
    { url: "https://maps.example.com/geocode/json?address=x&key=AIzaSyA1234567890abcdefghijklmnopqrstu" },
    "AIzaSyA1234567890",
    "address=x",
  ],
  ["WebFetch", { url: "https://api.example.com/v1/items?page=2&access_token=abcdef1234567890XYZ" }, "abcdef1234567890XYZ", "page=2"],
  ["WebFetch", { url: "https://bucket.example.com/a.png?X-Amz-Signature=deadbeefcafe&size=1" }, "deadbeefcafe", "size=1"],
  ["WebFetch", { url: "https://example.com/callback#id_token=eyJhbGciOi&state=s" }, "eyJhbGciOi", "state=s"],
];

describe("delegated task step labels", () => {
  it.each(SECRET_CALLS)("scrubs a %s step's key input like a command", (tool, input, secret, kept) => {
    const label = subagentStepLabel(tool, subagentStepKeyInput(input));
    expect(label).toContain("[redacted]");
    expect(label).not.toContain(secret);
    expect(label).toContain(kept);
  });

  it("scrubs a raw key input given straight to the label as well", () => {
    const label = subagentStepLabel("Command", "curl 'https://x.example/api?password=pa55word&q=1'");
    expect(label).toBe("Command · curl 'https://x.example/api?password=[redacted]&q=1'");
  });

  it("scrubs before the key input is cut so no fragment of a secret survives the cut", () => {
    const command = `${"x".repeat(150)} sk_live1234567890abcdef`;
    expect(subagentStepKeyInput({ command })).not.toContain("live12");
    expect(subagentStepLabel("Bash", command)).not.toContain("live12");
    expect(subagentActivityLabel(`${"y".repeat(190)} sk_live1234567890abcdef`)).not.toContain("live1");
  });

  it("redacts only the value of a credential-named URL parameter", () => {
    expect(scrubCommandSecrets("curl 'https://x.example/a?q=cats&sig=0a1b2c&design=blue&page=3'"))
      .toBe("curl 'https://x.example/a?q=cats&sig=[redacted]&design=blue&page=3'");
    expect(scrubCommandSecrets("open https://x.example/?design=blue&signal=on")).toBe("open https://x.example/?design=blue&signal=on");
  });

  it("scrubs the activity and steps a Claude subagent reports before they leave the adapter", () => {
    const updates: Parameters<AgentHarnessEmitter["subagent"]>[0][] = [];
    const tracker = new ClaudeSubagentTraceTracker((event) => updates.push(event));
    const observe = (value: unknown) => tracker.observe(value as SDKMessage);
    observe({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "tool_use", id: "tool-a", name: "Agent", input: { description: "Deploy" } }] } });
    observe({ type: "system", subtype: "task_started", task_id: "task-a", tool_use_id: "tool-a", task_type: "local_agent" });
    observe({ type: "system", subtype: "task_progress", task_id: "task-a", summary: "deploy --auth-token t0k3nvalue now" });
    expect(updates.at(-1)?.activity).toBe("deploy --auth-token [redacted] now");
    observe({
      type: "assistant",
      parent_tool_use_id: "tool-a",
      message: { content: [{ type: "tool_use", id: "step-1", name: "WebFetch", input: { url: "https://x.example/?q=1&key=AIzaSyA123456" } }] },
    });
    expect(JSON.stringify(updates.at(-1))).not.toContain("AIzaSyA123456");
    expect(updates.at(-1)?.steps).toEqual([{ label: "WebFetch · https://x.example/?q=1&key=[redacted]", status: "running" }]);
  });

  it("reduces an activity to one scrubbed line", () => {
    expect(subagentActivityLabel("Running deploy --api-key abc123\nsecond line")).toBe("Running deploy --api-key [redacted]");
    expect(subagentActivityLabel(42)).toBeNull();
    expect(subagentActivityLabel("  \n ")).toBeNull();
  });
});
