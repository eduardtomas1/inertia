import { describe, expect, it } from "vitest";

import {
  composerFollowUpState,
  composerPrimaryActionState,
  supportsActiveParentFollowUp,
} from "../../src/renderer/src/utils/composerPrimaryAction";

describe("composer Send and Stop", () => {
  it("uses one deterministic primary-action state matrix", () => {
    const state = (
      update: Partial<Parameters<typeof composerPrimaryActionState>[0]>,
    ) => composerPrimaryActionState({
      sendEligible: false,
      submitting: false,
      sending: false,
      running: false,
      stopping: false,
      ...update,
    });

    expect(state({})).toBe("send-disabled");
    expect(state({ sendEligible: true })).toBe("send-ready");
    expect(state({ sendEligible: true, submitting: true })).toBe("submitting");
    expect(state({ sendEligible: true, sending: true })).toBe("submitting");
    expect(state({ running: true, sending: true })).toBe("stop-ready");
    expect(state({ running: true, stopping: true })).toBe("stop-pending");
    expect(state({ stopping: true })).toBe("send-disabled");
  });

  it("keeps Stop primary while exposing only truthful parent follow-ups", () => {
    expect(supportsActiveParentFollowUp("codex-app-server")).toBe(true);
    expect(supportsActiveParentFollowUp("claude-agent-sdk")).toBe(true);
    expect(supportsActiveParentFollowUp("opencode-sdk")).toBe(true);
    expect(supportsActiveParentFollowUp("codex-cli")).toBe(false);
    expect(supportsActiveParentFollowUp("claude-cli")).toBe(false);
    expect(composerFollowUpState({
      running: true,
      stopping: false,
      harnessId: "codex-app-server",
      hasDraft: true,
      textOnly: true,
      submitting: false,
      sending: false,
    })).toBe("ready");
    expect(composerFollowUpState({
      running: true,
      stopping: false,
      harnessId: "claude-agent-sdk",
      hasDraft: true,
      textOnly: true,
      submitting: true,
      sending: false,
    })).toBe("pending");
    expect(composerFollowUpState({
      running: true,
      stopping: false,
      harnessId: "codex-cli",
      hasDraft: true,
      textOnly: true,
      submitting: false,
      sending: false,
    })).toBe("unavailable");
    expect(composerFollowUpState({
      running: true,
      stopping: false,
      harnessId: "codex-app-server",
      hasDraft: true,
      textOnly: false,
      submitting: false,
      sending: false,
    })).toBe("unavailable");
    expect(composerFollowUpState({
      running: true,
      stopping: true,
      harnessId: "codex-app-server",
      hasDraft: true,
      textOnly: true,
      submitting: false,
      sending: false,
    })).toBe("unavailable");
  });
});
