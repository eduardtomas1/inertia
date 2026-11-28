// @inertia-test-suite portable
import { describe, expect, it } from "vitest";
import { createAgentHarnessEmitter, type AgentHarnessEvent } from "../../src/server/provider/agent-harness";
import { AcpSecretRedactor } from "../../src/server/provider/acp-redaction";
import { OpenCode2Events } from "../../src/server/provider/opencode2-events";
import { OpenCode2Interactions } from "../../src/server/provider/opencode2-interactions";
import { openCode2Models, openCode2Usage } from "../../src/server/provider/opencode2-support";
import { runtimeProviderCapabilityAttestation } from "../../src/server/provider/runtime-capability-attestation";
import { providerCapabilityManifest } from "../../src/server/provider/capability-manifest";
import { nativeProviderRunInput } from "./model-route-fixture";

function fixture() {
  const output: AgentHarnessEvent[] = [];
  const emit = createAgentHarnessEmitter("opencode", "chat", { onEvent: (event) => output.push(event) }, "run", "turn", "/workspace");
  const redact = new AcpSecretRedactor({ TEST_API_KEY: "fixture-secret-value" });
  return { output, emit, redact };
}
describe("OpenCode 2 bounded projection", () => {
  it("recovers missing text deltas from the final block and keeps reasoning and answer credentials separate", () => {
    const f = fixture(); const events = new OpenCode2Events(f.emit, { TEST_API_KEY: "fixture-secret-value" }, f.redact);
    events.receive({ type: "session.reasoning.delta", data: { assistantMessageID: "msg_1", ordinal: 0, delta: "fixture-secret-" } });
    events.receive({ type: "session.reasoning.ended", data: { assistantMessageID: "msg_1", ordinal: 0, text: "fixture-secret-value" } });
    events.receive({ type: "session.text.delta", data: { assistantMessageID: "msg_1", ordinal: 1, delta: "hello " } });
    events.receive({ type: "session.text.ended", data: { assistantMessageID: "msg_1", ordinal: 1, text: "hello 🌿" } });
    events.receive({ type: "session.text.ended", data: { assistantMessageID: "msg_2", ordinal: 0, text: "next" } });
    events.finish(); expect(events.text.toString()).toBe("hello 🌿\n\nnext");
    expect(JSON.stringify(f.output)).not.toContain("fixture-secret-value");
    expect(f.output.some((event) => event.type === "extension" && event.event.type === "reasoning-summary" && event.event.text === "[redacted]")).toBe(true);
  });
  it("rejects changed completed text, mismatched final values and overlong deltas", () => {
    for (const kind of ["changed", "mismatch", "limit"]) {
      const f = fixture(); const events = new OpenCode2Events(f.emit, {}, f.redact);
      events.receive({ type: "session.text.delta", data: { assistantMessageID: "msg_1", ordinal: 0, delta: "first" } });
      if (kind === "changed") events.receive({ type: "session.text.ended", data: { assistantMessageID: "msg_1", ordinal: 0, text: "first" } });
      expect(() => events.receive({ type: kind === "mismatch" ? "session.text.ended" : "session.text.delta", data: { assistantMessageID: "msg_1", ordinal: 0, text: "different", delta: "x".repeat(kind === "limit" ? 65_537 : 1) } })).toThrow();
    }
  });
  it("bounds final reasoning and text chunks without splitting Unicode characters", () => {
    const f = fixture(); const events = new OpenCode2Events(f.emit, {}, f.redact);
    const text = `${"a".repeat(32_767)}🌿${"b".repeat(32_768)}`;
    for (const kind of ["reasoning", "text"]) events.receive({ type: `session.${kind}.ended`, data: { assistantMessageID: "msg_one", ordinal: 0, text } });
    const answer = f.output.flatMap((event) => event.type === "text" ? [event.text] : []);
    const reasoning = f.output.flatMap((event) => event.type === "extension" && event.event.type === "reasoning-summary" ? [event.event.text] : []);
    expect(answer.join("")).toBe(text); expect(reasoning.join("")).toBe(text);
    for (const chunk of [...answer, ...reasoning]) {
      expect(chunk.length).toBeLessThanOrEqual(32_768);
      expect(Buffer.from(chunk, "utf8").toString("utf8")).toBe(chunk);
    }
  });
  it("scopes reused tool IDs to their assistant message and keeps arbitrary native IDs private", () => {
    const f = fixture(); const events = new OpenCode2Events(f.emit, {}, f.redact);
    for (const assistantMessageID of ["msg_first", "msg_second"]) {
      const data = { assistantMessageID, id: "fixture-secret-value" };
      events.receive({ type: "session.tool.input.started", data: { ...data, name: "edit" } });
      events.receive({ type: "session.tool.called", data: { ...data, input: { path: "fixture-secret-value" } } });
      events.receive({ type: "session.tool.success", data: { ...data, content: [{ type: "text", text: "done" }] } });
    }
    const activities = f.output.filter((event) => event.type === "activity");
    expect(activities).toHaveLength(6);
    expect(new Set(activities.map((event) => event.activityId)).size).toBe(2);
    expect(JSON.stringify(f.output)).not.toContain("fixture-secret-value");
    expect(() => events.receive({ type: "session.tool.success", data: { assistantMessageID: "msg_second", id: "fixture-secret-value" } })).toThrow("completed tool");
    expect(() => events.receive({ type: "session.tool.called", data: { assistantMessageID: "msg_foreign", id: "fixture-secret-value" } })).toThrow("unknown");
  });
  it("projects native failures before a tool call without claiming execution", () => {
    const f = fixture(); const events = new OpenCode2Events(f.emit, {}, f.redact);
    const data = { assistantMessageID: "msg_first", id: "call_malformed" };
    events.receive({ type: "session.tool.input.started", data: { ...data, name: "edit" } });
    events.receive({ type: "session.tool.failed", data: { ...data, error: { message: "bad fixture-secret-value" }, executed: false } });
    expect(JSON.stringify(f.output)).toContain("bad [redacted]");
    expect(JSON.stringify(f.output)).not.toContain("fileMutation");
  });
  it("preserves unknown token counters and validates native model/variant identities", () => {
    expect(openCode2Usage(undefined)).toMatchObject({ usedTokens: null, totalProcessedTokens: null, cachedInputTokens: null });
    expect(openCode2Usage({ input: 10, output: 3, reasoning: 1, cache: { read: 2, write: 4 } }, 32000)).toMatchObject({ usedTokens: 16, maxTokens: 32000, totalProcessedTokens: 20 });
    expect(() => openCode2Models({ data: [{ providerID: "invalid/provider", id: "model", variants: [], enabled: true }] })).toThrow();
  });
  it("cancels unsupported forms and retains supported decisions until the native reply settles", async () => {
    const f = fixture(); const requests: { method: string; path: string; body: unknown }[] = [];
    let resolve!: () => void; const gate = new Promise<void>((done) => { resolve = done; });
    const interactions = new OpenCode2Interactions({ request: async (method, path, body) => { requests.push({ method, path, body }); await gate; } }, f.emit, f.redact, () => { throw new Error("unexpected reply failure"); });
    interactions.receive("form.created", { form: { id: "frm_external", sessionID: "ses_test", fields: [{ key: "link", type: "external", url: "https://example.invalid" }] } }, "ses_test");
    expect(requests[0]).toMatchObject({ method: "DELETE", path: "/api/session/ses_test/form/frm_external" });
    interactions.receive("permission.asked", { id: "perm_one", sessionID: "ses_test", action: "shell", resources: ["fixture-secret-value"] }, "ses_test");
    expect(interactions.approval("opencode2-permission:perm_one", "approve")).toBe(true);
    expect(interactions.approval("opencode2-permission:perm_one", "deny")).toBe(false);
    expect(f.output.some((event) => event.type === "extension" && event.event.type === "approval-resolved")).toBe(false);
    resolve(); await interactions.drain();
    expect(f.output.some((event) => event.type === "extension" && event.event.type === "approval-resolved")).toBe(true);
    expect(JSON.stringify(f.output)).not.toContain("fixture-secret-value"); interactions.close();
  });
  it("does not advertise unsupported native plans, child environments or passive auth under a V2 installation", () => {
    const route = nativeProviderRunInput({ providerId: "opencode", conversationId: "chat", cwd: "/workspace", prompt: "hello", access: "full", interactionMode: "build" });
    const manifest = providerCapabilityManifest("opencode-sdk")!;
    const attestation = runtimeProviderCapabilityAttestation({ ...route, executable: "/tools/opencode", evidenceTrusted: true,
      compatibility: route.backendCompatibility, installation: { executable: "/tools/opencode", version: "2.0.28" }, installationFingerprint: "fixture-installation",
      protocolEvidence: { executable: "/tools/opencode", version: "2.0.28", harnessId: "opencode-sdk", manifestDigest: manifest.digest, installationFingerprint: "fixture-installation" } });
    expect(attestation).not.toBeNull();
    for (const id of ["plans", "subagent-create", "subagent-stop", "auth-state-discovery"]) expect(attestation!.capabilities.find((item) => item.id === id)?.currentlyAvailable).toBe(false);
    expect(attestation!.capabilities.find((item) => item.id === "text-streaming")?.currentlyAvailable).toBe(true);
  });
});
