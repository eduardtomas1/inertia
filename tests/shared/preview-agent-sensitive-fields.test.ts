import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import {
  createPreviewAgentPrivacyRuntime,
  PREVIEW_AGENT_NAME_WORD_SOURCE,
  PREVIEW_AGENT_SENSITIVE_NAME_SOURCE,
} from "../../src/shared/preview-agent-sensitive-fields";

const runtime = () => createPreviewAgentPrivacyRuntime(
  PREVIEW_AGENT_SENSITIVE_NAME_SOURCE,
  PREVIEW_AGENT_NAME_WORD_SOURCE,
);

const state = () => ({ passwordNodes: new WeakSet<object>(), passwordValues: new Set<string>(),
  evidenceWithheld: undefined as string | undefined });

function field(value = "", type = "password") {
  return { tagName: "INPUT", type, value, defaultValue: "", getAttribute: () => null } as unknown as HTMLInputElement & { value: string };
}

function typeInto(privacy: ReturnType<typeof runtime>, current: ReturnType<typeof state>, input: { value: string }, text: string, from = 1) {
  for (let length = from; length <= text.length; length += 1) {
    input.value = text.slice(0, length);
    privacy.inspect(current, input as unknown as HTMLInputElement, "type");
  }
}

describe("Browser sensitive field redaction", () => {
  it("recognizes labels, autocomplete and textareas but not selects", async () => {
    const window = new Window();
    window.document.body.innerHTML = `<label>Password<input type="password" value="password-sentinel"></label>
      <label>API key<textarea>textarea-sentinel</textarea></label>
      <input autocomplete="one-time-code" value="943821">
      <span id="label">Access token</span><select aria-labelledby="label"><option selected>selected-sentinel</option></select>
      <label>Username<input value="admin"></label>`;
    const privacy = runtime();
    const current = state();
    const inputs = [...window.document.querySelectorAll("input,textarea,select")];
    for (const input of inputs) privacy.inspect(current, input as unknown as HTMLInputElement);
    expect(current.passwordValues).toEqual(new Set(["password-sentinel", "textarea-sentinel", "943821"]));
    expect(privacy.redact(current, "Password API key Authentication code Username admin selected-sentinel", 300))
      .toBe("Password API key Authentication code Username admin selected-sentinel");
    expect(current.passwordNodes.has(inputs[3]!)).toBe(false);
    expect(current.passwordNodes.has(inputs[4]!)).toBe(false);
    await window.happyDOM.abort();
  });

  it.each([
    ["show-password checkbox", `<label><input type="checkbox" value="on"> Show password</label>`, false],
    ["MFA delivery radio", `<input type="radio" name="verification_code_delivery" value="sms">`, false],
    ["password submit button", `<input type="submit" id="password-submit" value="Sign in">`, false],
    ["token type select", `<select name="token_type"><option selected>bearer</option></select>`, false],
    ["credential type select", `<select aria-label="Credential type"><option selected>bearer</option></select>`, false],
    ["token budget number", `<input type="number" name="max_tokens" value="4096">`, false],
    ["design token search", `<input type="search" placeholder="Search design tokens">`, false],
    ["remaining tokens", `<input placeholder="tokens remaining">`, false],
    ["token type text", `<input name="token_type">`, false],
    ["secretary", `<input name="secretary">`, false],
    ["spinner", `<input name="spinner">`, false],
    ["passwordless email", `<input type="email" name="passwordless_email">`, false],
    ["hidden token", `<input type="hidden" name="_token" value="csrf">`, true],
    ["api key", `<input name="api_key">`, true],
    ["auth token", `<input name="authToken">`, true],
    ["numbered password", `<input name="password2">`, true],
    ["api key header", `<input name="x-api-key">`, true],
    ["private key textarea", `<label>Private key<textarea></textarea></label>`, true],
    ["password type with a budget name", `<input type="password" name="max_tokens">`, true],
    ["client secret", `<input id="clientSecret">`, true],
    ["otp", `<input name="otp">`, true],
    ["totp", `<input name="totp_code">`, true],
    ["recovery code", `<input aria-label="Recovery code">`, true],
    ["backup code", `<input name="backupCode">`, true],
    ["cvv", `<input name="cvv">`, true],
    ["cvc", `<input placeholder="CVC">`, true],
    ["card number label", `<label>Card number <input></label>`, true],
    ["newpassword", `<input name="newpassword">`, true],
    ["confirmpassword", `<input name="confirmpassword">`, true],
    ["clientsecret", `<input name="clientsecret">`, true],
    ["secretkey", `<input name="secretkey">`, true],
    ["otpcode", `<input name="otpcode">`, true],
    ["accesskey", `<input name="accesskey">`, true],
    ["account number", `<input name="acc_number">`, false],
    ["cardnumber", `<input name="cardnumber">`, true],
    ["pin", `<input type="tel" aria-label="PIN">`, true],
    ["cc-number", `<input autocomplete="cc-number">`, true],
    ["cc-csc", `<input autocomplete="cc-csc">`, true],
    ["one-time-code", `<input autocomplete="one-time-code">`, true],
    ["current-password", `<input autocomplete="current-password">`, true],
    ["2FA code", `<input aria-label="2FA code">`, true],
    ["acronym before a word", `<input name="MFACode">`, true],
    ["access token label", `<input aria-labelledby="l"><span id="l">Personal access token</span>`, true],
    ["whole token", `<input placeholder="Token">`, true],
  ])("classifies a %s by control type and bounded name words", async (_name, markup, expected) => {
    const window = new Window();
    window.document.body.innerHTML = markup;
    const element = window.document.querySelector("input,textarea,select")!;
    expect(runtime().isSensitiveField(element as unknown as Element)).toBe(expected);
    await window.happyDOM.abort();
  });

  it("does not mark an ordinary field from a short remembered value", () => {
    const privacy = runtime();
    const current = state();
    for (const value of ["s", "ad", "adm", "s3cret"]) privacy.remember(current, value);
    const search = field("s", "search");
    privacy.inspect(current, search);
    expect(current.passwordNodes.has(search)).toBe(false);
    search.value = "adm";
    privacy.inspect(current, search);
    expect(current.passwordNodes.has(search)).toBe(false);
    search.value = "s3cret";
    privacy.inspect(current, search);
    expect(current.passwordNodes.has(search)).toBe(true);
  });

  it("collapses typed prefixes at the next settle point only while the field still extends them", () => {
    const privacy = runtime();
    const typed = state();
    const password = field();
    typeInto(privacy, typed, password, "admin123");
    expect(typed.passwordValues.size).toBe(8);
    privacy.settle(typed);
    expect([...typed.passwordValues]).toEqual(["admin123"]);
    expect(privacy.redact(typed, "Create a new account. Signed in as admin, admin123", 300))
      .toBe("Create a new account. Signed in as admin, [redacted]");
    password.value = "admin12";
    privacy.inspect(typed, password, "type");
    privacy.settle(typed);
    expect(typed.passwordValues).toEqual(new Set(["admin123", "admin12"]));

    const settled = state();
    const otherPassword = field();
    typeInto(privacy, settled, otherPassword, "hun");
    privacy.settle(settled);
    privacy.inspect(settled, otherPassword, "settle");
    typeInto(privacy, settled, otherPassword, "hunter2", 4);
    privacy.settle(settled);
    expect(settled.passwordValues).toEqual(new Set(["hun", "hunter2"]));

    const observed = state();
    const synthetic = field("abcd");
    privacy.inspect(observed, synthetic);
    synthetic.value = "abcdef";
    privacy.inspect(observed, synthetic);
    privacy.settle(observed);
    expect(observed.passwordValues).toEqual(new Set(["abcd", "abcdef"]));

    for (const leave of [(input: { value: string }) => { input.value = ""; },
      (input: { value: string; isConnected?: boolean }) => { input.isConnected = false; }]) {
      const scripted = state();
      const scriptedField = field();
      typeInto(privacy, scripted, scriptedField, "hunter2x");
      expect(scripted.passwordValues.has("hunter2")).toBe(true);
      leave(scriptedField);
      privacy.settle(scripted);
      expect(scripted.passwordValues.size).toBe(8);
    }

    const extended = state();
    const extendedField = field();
    typeInto(privacy, extended, extendedField, "hunter2x");
    privacy.settle(extended);
    expect([...extended.passwordValues]).toEqual(["hunter2x"]);
    privacy.remember(extended, "hunter2");
    expect(extended.passwordValues).toEqual(new Set(["hunter2x", "hunter2"]));
  });

  it("forgets a mirror mark whose typed prefix was collapsed, but not a settled one", () => {
    const privacy = runtime();
    const typed = state();
    const password = field();
    const username = field("admin", "text");
    typeInto(privacy, typed, password, "admin");
    privacy.inspect(typed, username);
    expect(typed.passwordNodes.has(username)).toBe(true);
    typeInto(privacy, typed, password, "admin123", 6);
    privacy.settle(typed);
    privacy.inspect(typed, username, "settle");
    expect(typed.passwordNodes.has(username)).toBe(false);
    expect([...typed.passwordValues]).toEqual(["admin123"]);

    const settled = state();
    const other = field();
    const replacement = field("hunter2", "text");
    typeInto(privacy, settled, other, "hunter2");
    privacy.settle(settled);
    privacy.inspect(settled, other, "settle");
    privacy.inspect(settled, replacement);
    replacement.value = "hunter3";
    privacy.inspect(settled, replacement);
    expect(settled.passwordNodes.has(replacement)).toBe(true);
    expect(settled.passwordValues).toEqual(new Set(["hunter2", "hunter3"]));
  });

  it("remembers values after clearing and removing a field and redacts literal and URL copies", () => {
    const privacy = runtime();
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

  it.each([
    ["markup split", "Summer 2026!", "Before Sum mer 2026! after"],
    ["upper case", "Summer 2026!", "Before SUMMER 2026! after"],
    ["zero-width space", "Summer 2026!", "Before Summer​ 2026! after"],
    ["soft hyphen", "Summer 2026!", "Before Sum­mer 2026! after"],
    ["compatibility forms", "Summer 2026!", "Before ＳＵＭＭＥＲ　２０２６！ after"],
    ["component encoding", "p@ss w0rd/1", "Before p%40ss%20w0rd%2F1 after"],
    ["URI encoding", "p@ss w0rd/1", "Before p@ss%20w0rd/1 after"],
    ["form encoding", "it's (ok)! *", "Before it%27s+%28ok%29%21+* after"],
    ["form encoding with an encoded asterisk", "it's (ok)! *", "Before it%27s+%28ok%29%21+%2A after"],
    ["hexadecimal", "Summer 2026!", `Before ${Buffer.from("Summer 2026!").toString("hex").toUpperCase()} after`],
    ["JSON escaping", "say \"hi\"\n\tnow", "Before say \\\"hi\\\"\\n\\tnow after"],
    ["left-to-right mark", "Summer 2026!", "Before Summer\u200e 2026! after"],
    ["combining grapheme joiner", "Summer 2026!", "Before Sum\u034fmer 2026! after"],
    ["invisible function application", "Summer 2026!", "Before Summer\u2061\u2064 2026! after"],
    ["variation selector", "Summer 2026!", "Before Sum\ufe0fmer 2026! after"],
  ])("redacts a %s copy of a remembered value", (_name, secret, text) => {
    const privacy = runtime();
    const current = state();
    privacy.remember(current, secret);
    expect(privacy.redact(current, text, 300)).toBe("Before [redacted] after");
  });

  it("merges overlapping copies and masks short values by whether they settled", () => {
    const privacy = runtime();
    const overlapping = state();
    privacy.remember(overlapping, "abcd");
    privacy.remember(overlapping, "cdef");
    expect(privacy.redact(overlapping, "xx abcdef yy", 300)).toBe("xx [redacted] yy");

    const short = state();
    privacy.remember(short, "943");
    expect(privacy.redact(short, "CVC943 and CVC 943", 300)).toBe("CVC943 and CVC [redacted]");
    privacy.remember(short, "943", "settle");
    expect(privacy.redact(short, "CVC943 and CVC 943", 300)).toBe("CVC[redacted] and CVC [redacted]");

    const tiny = state();
    privacy.remember(tiny, "1", "settle");
    privacy.remember(tiny, "12", "settle");
    expect(privacy.redact(tiny, "Order 1 of 123, 12 left, 312", 300)).toBe("Order [redacted] of 123, [redacted] left, 312");
  });

  it("never leaks the prefix of a value cut by a source window", () => {
    const privacy = runtime();
    const current = state();
    privacy.remember(current, "hunter2");
    const spaced = privacy.redact(current, `${" ".repeat(1_195)}hunter2`, 300);
    expect(spaced).not.toContain("hunt");
    const cut = privacy.redact(current, `Account${" ".repeat(1_191)}hunt`, 300, true);
    expect(cut).not.toContain("hunt");
    expect(privacy.clip(current, `Account ${" ".repeat(1_183)}hunt`)).not.toContain("hunt");
    expect(privacy.clip(current, `Account hunter2 ${"y".repeat(100)}`)).toBe(`Account hunter2 ${"y".repeat(100)}`);
    expect(privacy.clip(current, `Account ${"y".repeat(100)} hunt`)).toBe(`Account ${"y".repeat(100)} `);
    const long = state();
    const token = `tok-${"q".repeat(896)}`;
    privacy.remember(long, token);
    const label = `Deploy ${"y".repeat(1_180)}`;
    expect(privacy.clip(long, label)).toBe(label);
    expect(privacy.clip(long, `${label} tok-qq`)).toBe(`${label} `);
  });

  it("refuses redaction overflow without forgetting any previous secret", () => {
    const privacy = runtime();
    const current = state();
    for (let index = 0; index < 256; index++) privacy.remember(current, `sentinel-${index}`);
    expect(current.evidenceWithheld).toBeUndefined();
    privacy.remember(current, "overflow");
    expect(current.evidenceWithheld).toBe("redaction-limit");
    expect(current.passwordValues.has("sentinel-0")).toBe(true);
    const oversized = state();
    privacy.remember(oversized, "x".repeat(4097));
    expect(oversized.evidenceWithheld).toBe("redaction-limit");
 
    const expanding = state();
    for (let index = 0; index < 256; index++) privacy.remember(expanding, `${index}${"\ud55c".repeat(3_990)}`);
    expect(expanding.evidenceWithheld).toBeUndefined();
    privacy.redact(expanding, "Order shipped", 300);
    expect(expanding.evidenceWithheld).toBe("redaction-limit");
  });
});
