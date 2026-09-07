// @inertia-test-suite portable
import { describe, expect, it } from "vitest";
import { selectKimiAcpAuthMethod } from "../../src/server/provider/acp-terminal-auth";

const terminal = { id: "login", name: "Kimi login", type: "terminal", args: ["--login"] };

describe("bounded Kimi terminal-auth policy", () => {
  it("selects a detached login-only descriptor and never imports a legacy command", () => {
    const source = { ...terminal, args: [...terminal.args], env: {}, _meta: { "terminal-auth": { command: "untrusted", args: ["anything"] } } };
    const selected = selectKimiAcpAuthMethod([source], {});
    expect(selected).toEqual({ ...terminal, env: {} });
    source.args.push("changed");
    expect(selected).toEqual({ ...terminal, args: ["--login"], env: {} });
  });

  it("preserves the existing Kimi profile without permitting relocation", () => {
    const env = { KIMI_CODE_HOME: "/fixture/profile with spaces" };
    expect(selectKimiAcpAuthMethod([{ ...terminal, env }], env, "linux"))
      .toEqual({ ...terminal, env });
    expect(() => selectKimiAcpAuthMethod([{ ...terminal, env }], {}, "linux")).toThrow(/invalid terminal/);
    expect(() => selectKimiAcpAuthMethod([{ ...terminal, env }], { KIMI_CODE_HOME: "/different" }, "linux"))
      .toThrow(/invalid terminal/);
  });

  it("deduplicates Windows case-insensitive identities using the existing base casing", () => {
    const env = { KIMI_CODE_HOME: "C:\\fixture\\profile" };
    expect(selectKimiAcpAuthMethod([{ ...terminal, env }], { kimi_code_home: env.KIMI_CODE_HOME }, "win32"))
      .toEqual({ ...terminal, env: { kimi_code_home: env.KIMI_CODE_HOME } });
    expect(() => selectKimiAcpAuthMethod([{ ...terminal, env }], {
      KIMI_CODE_HOME: env.KIMI_CODE_HOME, kimi_code_home: env.KIMI_CODE_HOME,
    }, "win32")).toThrow(/invalid terminal/);
    expect(() => selectKimiAcpAuthMethod([{ ...terminal, env }], { kimi_code_home: env.KIMI_CODE_HOME }, "linux"))
      .toThrow(/invalid terminal/);
  });

  it.each(["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH", "ComSpec", "HOME", "USERPROFILE", "INERTIA_RUNTIME_GENERATION", "KIMI_API_KEY", "__proto__", "kimi_code_home"])(
    "rejects descriptor-controlled %s without revealing its value", (key) => {
      const env = { [key]: "private-do-not-print" };
      expect(() => selectKimiAcpAuthMethod([{ ...terminal, env }], env)).toThrow(
        "Kimi ACP returned an unsupported or invalid terminal authentication descriptor.");
    },
  );

  it.each([
    { args: [] }, { args: ["login"] }, { args: ["--login", "--eval", "untrusted"] },
    { args: ["--login\0"] }, { args: "--login" }, { args: undefined },
    { type: "agent" }, { type: "other" }, { type: undefined }, { id: "other" },
    { command: "untrusted" }, { env: null }, { env: [] }, { env: { KIMI_CODE_HOME: "a".repeat(4_097) } },
    { name: "x".repeat(513) }, { name: "control\n" }, { id: "x".repeat(257) },
    { description: "x".repeat(2_049) },
  ])("rejects unsupported or oversized terminal descriptors (%j)", (change) => {
    expect(() => selectKimiAcpAuthMethod([{ ...terminal, ...change }], {})).toThrow(/invalid terminal/);
  });

  it("rejects ambiguous, malformed and oversized method lists", () => {
    for (const methods of [false, {}, [null], [terminal, terminal],
      Array.from({ length: 17 }, (_, index) => ({ id: `method-${index}`, name: "Login" }))]) {
      expect(() => selectKimiAcpAuthMethod(methods, {})).toThrow(/invalid terminal/);
    }
  });

  it("retains only explicitly advertised legacy agent-owned login and never assumes it", () => {
    const agent = { id: "login", name: "Agent login", description: "Existing flow" };
    expect(selectKimiAcpAuthMethod([agent], {})).toEqual(agent);
    for (const methods of [undefined, null, [], [{ id: "other", name: "Other" }]]) {
      expect(selectKimiAcpAuthMethod(methods, {})).toBeUndefined();
    }
  });
});
