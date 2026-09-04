import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  COMPOSER_ACTION_STALE_FALLBACK_MS,
  composerFollowUpState,
  composerPrimaryActionState,
  supportsActiveParentFollowUp,
} from "../../src/renderer/src/utils/composerPrimaryAction";

const composerSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/Composer.tsx", import.meta.url),
  "utf8",
);
const inputSource = readFileSync(
  new URL("../../src/renderer/src/components/composer/ComposerInputZone.tsx", import.meta.url),
  "utf8",
);
const sendActionsSource = readFileSync(
  new URL(
    "../../src/renderer/src/components/composer/ComposerSendActions.tsx",
    import.meta.url,
  ),
  "utf8",
);
const queuedActionsSource = readFileSync(
  new URL(
    "../../src/renderer/src/components/composer/ComposerQueuedActions.tsx",
    import.meta.url,
  ),
  "utf8",
);
const morphIconSource = readFileSync(
  new URL(
    "../../src/renderer/src/components/motion/InertiaMorphIcon.tsx",
    import.meta.url,
  ),
  "utf8",
);
const sendActionsCss = readFileSync(
  new URL(
    "../../src/renderer/src/components/composer/ComposerSendActions.css",
    import.meta.url,
  ),
  "utf8",
);
const chatWorkspaceSource = readFileSync(
  new URL("../../src/renderer/src/components/ChatWorkspace.tsx", import.meta.url),
  "utf8",
);
const workspaceSceneModelSource = readFileSync(
  new URL(
    "../../src/renderer/src/components/workspace-scene/createWorkspaceSceneModel.ts",
    import.meta.url,
  ),
  "utf8",
);
const css = readFileSync(
  new URL("../../src/renderer/src/styles.css", import.meta.url),
  "utf8",
);

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

  it("bridges a delayed runtime start without an enabled Send gap", () => {
    expect(COMPOSER_ACTION_STALE_FALLBACK_MS).toBeGreaterThanOrEqual(3_000);

    const acceptedAtTwoSeconds = composerPrimaryActionState({
      sendEligible: true,
      submitting: 2_000 < COMPOSER_ACTION_STALE_FALLBACK_MS,
      sending: false,
      running: false,
      stopping: false,
    });
    const runtimeStarted = composerPrimaryActionState({
      sendEligible: true,
      submitting: true,
      sending: false,
      running: true,
      stopping: false,
    });

    expect(acceptedAtTwoSeconds).toBe("submitting");
    expect(runtimeStarted).toBe("stop-ready");
  });

  it("preserves keyboard and focus semantics with explicit action labels", () => {
    expect(inputSource).toContain(
      "if (shouldSubmitComposerKey(event))",
    );
    expect(inputSource).toContain("void onSubmit()");
    expect(inputSource).toContain(
      "readOnly={submissionPending || followUpPending}",
    );
    expect(sendActionsSource).toContain('label: "Send message"');
    expect(sendActionsSource).toContain('label: "Sending message"');
    expect(sendActionsSource).toContain('"Stopping agent"');
    expect(sendActionsSource).toContain('"Stop agent"');
    expect(sendActionsSource).toContain("onFocus={() => setIntent(true)}");
    expect(composerSource).toContain("aria-busy={");
    expect(composerSource).toContain("|| conversationUpdatePending");
    expect(composerSource).toContain("if (stoppingRef.current || !running) return;");
    expect(composerSource).toContain("textareaRef.current?.focus()");
    expect(chatWorkspaceSource).toContain("onStop: () => Promise<void>;");
    expect(chatWorkspaceSource).toContain(
      "const stopTimeline = useCallback(() => {",
    );
    expect(chatWorkspaceSource).toContain("onStop={stopTimeline}");
    expect(chatWorkspaceSource).not.toContain(
      "onStop={() => { void onStop().catch(() => undefined); }}",
    );
  });

  it("keeps Stop primary while exposing only truthful parent follow-ups", () => {
    expect(supportsActiveParentFollowUp("codex-app-server")).toBe(true);
    expect(supportsActiveParentFollowUp("claude-agent-sdk")).toBe(true);
    expect(supportsActiveParentFollowUp("opencode-sdk")).toBe(true);
    expect(supportsActiveParentFollowUp("codex-cli")).toBe(false);
    expect(supportsActiveParentFollowUp("claude-cli")).toBe(false);
    expect(composerFollowUpState({
      running: true,
      harnessId: "codex-app-server",
      hasDraft: true,
      textOnly: true,
      submitting: false,
      sending: false,
    })).toBe("ready");
    expect(composerFollowUpState({
      running: true,
      harnessId: "claude-agent-sdk",
      hasDraft: true,
      textOnly: true,
      submitting: true,
      sending: false,
    })).toBe("pending");
    expect(composerFollowUpState({
      running: true,
      harnessId: "codex-cli",
      hasDraft: true,
      textOnly: true,
      submitting: false,
      sending: false,
    })).toBe("unavailable");
    expect(composerFollowUpState({
      running: true,
      harnessId: "codex-app-server",
      hasDraft: true,
      textOnly: false,
      submitting: false,
      sending: false,
    })).toBe("unavailable");
    expect(queuedActionsSource).toContain('aria-label="Queued messages"');
    expect(sendActionsSource).not.toContain("Follow-up unavailable");
    const textarea = inputSource.slice(
      inputSource.indexOf("<textarea"),
      inputSource.indexOf("/>", inputSource.indexOf("<textarea")),
    );
    expect(textarea).toContain("disabled={disabled}");
    expect(textarea).not.toContain("disabled={disabled || running}");
  });

  it("keeps sending and acceptance feedback on the action controls", () => {
    expect(workspaceSceneModelSource).toContain(
      'sending: busyAction === "message.send"',
    );
    expect(workspaceSceneModelSource).not.toContain(
      'sending: busyAction === "message.send" || busyAction === "review.summary.generate"',
    );
    expect(sendActionsSource).toContain("loaderCircleMorphIcon");
    expect(sendActionsSource).toContain('iconState: "sending"');
    expect(sendActionsSource).not.toContain('label: "Message accepted"');
    expect(sendActionsSource).not.toContain("AcceptanceStatus");
    expect(sendActionsSource).not.toContain("composer-send-acceptance");
    expect(morphIconSource).toContain('reducedMotion: "user"');
    expect(sendActionsCss).toContain("prefers-reduced-motion: reduce");
    expect(sendActionsCss).toContain("animation: none");
  });

  it("keeps equal circular geometry with calm theme-token states and no glow", () => {
    const sendRule = css.match(/\.send-button\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    const disabledRule = css.match(/\.send-button:disabled\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    const loadingRule = css.match(/\.send-button-loading:disabled\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? "";
    const stopRule = css.match(/\.stop-button,\s*\.stop-button:disabled\s*\{(?<body>[^}]*)\}/u)?.groups?.body ?? "";

    expect(sendRule).toContain("width: var(--composer-control-height)");
    expect(sendRule).toContain("height: var(--composer-control-height)");
    expect(sendRule).toContain("flex: 0 0 var(--composer-control-height)");
    expect(sendRule).toContain("border-radius: 50%");
    expect(sendRule).toContain("background: var(--accent)");
    expect(sendRule).toContain("box-shadow: none");
    expect(disabledRule).toContain("background: var(--surface-muted)");
    expect(disabledRule).toContain("box-shadow: none");
    expect(loadingRule).toContain("var(--accent-soft)");
    expect(stopRule).toContain("var(--danger)");
    expect(stopRule).toContain("var(--danger-soft)");
    expect(stopRule).toContain("box-shadow: none");
    expect(css).toContain('--ui-control-height: 32px;');
    expect(css).toMatch(
      /:root\[data-interface-scale="compact"\]\s*\{[^}]*--ui-control-height:\s*30px/su,
    );
    expect(css).toMatch(
      /:root\[data-interface-scale="large"\]\s*\{[^}]*--ui-control-height:\s*38px/su,
    );
  });
});
