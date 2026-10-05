import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { createPreviewAgentPrivacyRuntime } from "../../src/shared/preview-agent-sensitive-fields";

const state = () => ({ passwordNodes: new WeakSet<object>(), passwordValues: new Set<string>(),
  evidenceWithheld: undefined as string | undefined });

describe("Browser sensitive field redaction", () => {
  it("recognizes labels, autocomplete, textareas and selected sensitive values", async () => {
    const window = new Window();
    window.document.body.innerHTML = `<label>Password<input type="password" value="password-sentinel"></label>
      <label>API key<textarea>textarea-sentinel</textarea></label>
      <input autocomplete="one-time-code" value="943821">
      <span id="label">Access token</span><select aria-labelledby="label"><option selected>selected-sentinel</option></select>
      <label>Username<input value="admin"></label>`;
    const privacy = createPreviewAgentPrivacyRuntime();
    const current = state();
    const inputs = [...window.document.querySelectorAll("input,textarea,select")];
    for (const input of inputs) privacy.inspect(current, input as unknown as HTMLInputElement);
    expect(current.passwordValues).toEqual(new Set(["password-sentinel", "textarea-sentinel", "943821", "selected-sentinel"]));
    expect(privacy.redact(current, "Password API key Authentication code Username admin", 300))
      .toBe("Password API key Authentication code Username admin");
    expect(current.passwordNodes.has(inputs[4]!)).toBe(false);
    await window.happyDOM.abort();
  });

  it("remembers values after clearing and removing a field and redacts literal and URL copies", () => {
    const privacy = createPreviewAgentPrivacyRuntime();
    const current = state();
    const input = { tagName: "INPUT", type: "password", value: "a+[b]?(c)/secret", defaultValue: "old-password" } as HTMLInputElement;
    privacy.inspect(current, input);
    input.value = "";
    input.type = "text";
    privacy.inspect(current, input);
    expect(privacy.redact(current, "a+[b]?(c)/secret a%2B%5Bb%5D%3F(c)%2Fsecret old-password", 300))
      .toBe("[redacted] [redacted] [redacted]");
    privacy.remember(current, "new-password");
    expect(privacy.redact(current, "old-password new-password", 300)).toBe("[redacted] [redacted]");
    privacy.remember(current, "\ud800secret");
    expect(privacy.redact(current, "\ud800secret", 300)).toBe("[redacted]");
    privacy.remember(current, " spaced  secret ");
    expect(privacy.redact(current, "spaced secret %20spaced%20%20secret%20", 300)).toBe("[redacted] [redacted]");
  });

  it("refuses redaction overflow without forgetting any previous secret", () => {
    const privacy = createPreviewAgentPrivacyRuntime();
    const current = state();
    for (let index = 0; index < 256; index++) privacy.remember(current, `sentinel-${index}`);
    expect(current.evidenceWithheld).toBeUndefined();
    privacy.remember(current, "overflow");
    expect(current.evidenceWithheld).toBe("redaction-limit");
    expect(current.passwordValues.has("sentinel-0")).toBe(true);
    const oversized = state();
    privacy.remember(oversized, "x".repeat(4097));
    expect(oversized.evidenceWithheld).toBe("redaction-limit");
  });
});
