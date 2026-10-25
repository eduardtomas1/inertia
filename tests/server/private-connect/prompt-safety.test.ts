import { describe, expect, it } from "vitest";

import {
  PRIVATE_CONNECT_PROMPT_SAFETY_HARNESS_IDS,
  READ_ONLY_WATCHER_PROMPT_SAFETY_HEADLINE,
  UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY,
  privateConnectPromptSafetyForHarness,
  privateConnectPromptSafetyIsUsable,
  privateConnectPromptSafetyLabel,
} from "../../../src/shared/private-connect/prompt-safety";

describe("Private Connect prompt safety", () => {
  it("advertises only known harness contracts", () => {
    expect(PRIVATE_CONNECT_PROMPT_SAFETY_HARNESS_IDS).toContain("codex-app-server");
    expect(privateConnectPromptSafetyForHarness("codex-app-server").supported).toBe(true);
    expect(PRIVATE_CONNECT_PROMPT_SAFETY_HARNESS_IDS).toContain("antigravity-cli");
    expect(privateConnectPromptSafetyForHarness("antigravity-cli")).toMatchObject({
      supported: false,
      permissionModel: "provider-controlled",
    });
    expect(privateConnectPromptSafetyIsUsable(
      privateConnectPromptSafetyForHarness("antigravity-cli"),
    )).toBe(false);
    expect(privateConnectPromptSafetyForHarness("unknown-harness" as never)).toBe(UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY);
    expect(privateConnectPromptSafetyForHarness(null)).toBe(UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY);
  });

  it("requires local action routing and rejects provider-controlled contracts", () => {
    const supported = privateConnectPromptSafetyForHarness("codex-app-server");
    expect(privateConnectPromptSafetyIsUsable(supported)).toBe(true);
    expect(privateConnectPromptSafetyIsUsable(UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY)).toBe(false);
    expect(privateConnectPromptSafetyIsUsable({
      ...supported,
      permissionModel: "provider-controlled",
    })).toBe(false);
    expect(privateConnectPromptSafetyIsUsable({
      ...supported,
      networkPolicy: "unrestricted",
    })).toBe(false);
    expect(privateConnectPromptSafetyIsUsable({
      ...supported,
      filesystemPolicy: "unrestricted",
    })).toBe(false);
  });

  it("labels prompt capability without exposing provider output", () => {
    const safety = privateConnectPromptSafetyForHarness("opencode-sdk");
    expect(privateConnectPromptSafetyLabel("OpenCode", safety)).toContain("OpenCode Private Connect prompt");
    expect(privateConnectPromptSafetyLabel("OpenCode", safety)).toContain(safety.headline);
  });
});

describe("Private Connect prompt safety for watchers", () => {
  it("labels a read-only watcher and keeps unsupported harnesses unsupported", () => {
    const base = privateConnectPromptSafetyForHarness("claude-agent-sdk");
    const watcher = privateConnectPromptSafetyForHarness("claude-agent-sdk", { watcher: true });
    expect(watcher).toMatchObject({ ...base, headline: READ_ONLY_WATCHER_PROMPT_SAFETY_HEADLINE, explanation: expect.stringContaining("read-only watcher") });
    expect(watcher.headline).toBe("Read-only watcher · approvals are declined automatically");
    expect(watcher.explanation).not.toBe(base.explanation);
    expect(privateConnectPromptSafetyIsUsable(watcher)).toBe(true);
    expect(privateConnectPromptSafetyForHarness("codex-app-server", { watcher: false }))
      .toBe(privateConnectPromptSafetyForHarness("codex-app-server"));
    expect(privateConnectPromptSafetyForHarness("antigravity-cli", { watcher: true }).supported).toBe(false);
    expect(privateConnectPromptSafetyForHarness(null, { watcher: true })).toBe(UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY);
  });

  it("describes a read-only watcher without claiming a mode, and a chat-access watcher by its mode and access", () => {
    const base = privateConnectPromptSafetyForHarness("codex-app-server");
    const readOnly = privateConnectPromptSafetyForHarness("codex-app-server", {
      watcher: { readOnly: true, interactionMode: "plan", accessMode: "supervised" },
    });
    expect(readOnly.headline).toBe(READ_ONLY_WATCHER_PROMPT_SAFETY_HEADLINE);
    expect(readOnly.explanation).toContain("This chat is a read-only watcher.");
    expect(readOnly.explanation).not.toContain("Plan mode");
    const chatAccess = privateConnectPromptSafetyForHarness("codex-app-server", {
      watcher: { readOnly: false, interactionMode: "build", accessMode: "full" },
    });
    expect({ ...chatAccess, headline: base.headline, explanation: base.explanation }).toEqual(base);
    expect(chatAccess.headline).toBe("Watcher · Build · Full access");
    expect(chatAccess.explanation).toContain("This chat is a watcher with chat access: it runs in Build · Full access");
    expect(chatAccess.explanation).toContain(base.explanation);
    expect(privateConnectPromptSafetyForHarness("codex-app-server", { watcher: null })).toBe(base);
    expect(privateConnectPromptSafetyForHarness("antigravity-cli", {
      watcher: { readOnly: false, interactionMode: "build", accessMode: "full" },
    }).supported).toBe(false);
  });
});
