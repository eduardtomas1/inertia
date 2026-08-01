import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { AgentHarnessRegistry } from "../../src/server/provider/agent-harness-registry";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import { createCodexAppServerHarness } from "../../src/server/provider/codex-app-server-harness";
import { createCursorAcpHarness } from "../../src/server/provider/cursor-acp-harness";
import { createOpenCodeSdkHarness } from "../../src/server/provider/opencode-sdk-harness";
import { RemoteRuntimeGateway } from "../../src/server/remote-gateway";
import { KNOWN_HARNESS_IDS } from "../../src/shared/model-routing";
import { remoteConversationGrantsFromProjectIds } from "../../src/shared/remote-grants";
import { sanitizeRemoteContent } from "../../src/shared/remote-sanitizer";
import {
  remotePromptSafetyForHarness,
  remotePromptSafetyIsUsable,
  remotePromptSafetyLabel,
  UNSUPPORTED_REMOTE_PROMPT_SAFETY,
  type RemotePromptSafety,
} from "../../src/shared/remote-prompt-safety";
import type {
  RemoteAuthorizationSubject,
  RemoteResponse,
} from "../../src/shared/remote-protocol";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

const APPROVAL_ROUTING_HARNESSES = [
  "codex-app-server",
  "claude-agent-sdk",
  "cursor-acp",
  "opencode-sdk",
] as const;

const CLI_HARNESSES = [
  "codex-cli",
  "claude-cli",
  "cursor-cli",
  "opencode-cli",
] as const;

const temporaryDirectories: string[] = [];
const stores: RuntimeStore[] = [];
const PROMPT_REQUEST_ID = "4d1b6f8c-59a1-4c62-9a17-2f1c8b3d5e01";
const DELIVERY_ID = "2f7c0a9e-1b3d-4e5f-8a6b-7c8d9e0f1a2b";
const STATE_REQUEST_ID = "6bbd21ad-3f1a-4e6f-8a86-2e3f0c3f5c11";

function fixture(safety: () => RemotePromptSafety) {
  const directory = mkdtempSync(join(tmpdir(), "inertia-remote-safety-"));
  temporaryDirectories.push(directory);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  stores.push(store);
  const project = store.createProject("Project", directory);
  const conversation = store.createConversation(project.id, "Conversation");
  store.updateConversation(conversation.id, { accessMode: "supervised" });
  let queued = 0;
  const gateway = new RemoteRuntimeGateway({
    shell: () => store.shellSnapshot(),
    detail: (conversationId) => store.conversationDetail(conversationId),
    isConversationActive: () => false,
    preparePrompt: async () => undefined,
    queuePrompt: () => ({ turnId: `turn-${++queued}` }),
    remotePromptSafety: safety,
    now: () => new Date("2030-01-01T00:00:00.000Z"),
  });
  const subject: RemoteAuthorizationSubject = {
    deviceId: "09400fa3-32c0-4d8d-8d17-e8ea0a4f6937",
    sessionId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e",
    scopes: ["view", "prompt"],
    projectIds: [project.id],
    grants: remoteConversationGrantsFromProjectIds([project.id]),
    grantVersion: 1,
    expiresAt: "2030-02-01T00:00:00.000Z",
  };
  return { store, gateway, subject, project, conversation, queued: () => queued };
}

async function attemptPrompt(
  gateway: RemoteRuntimeGateway,
  subject: RemoteAuthorizationSubject,
  conversationId: string,
): Promise<RemoteResponse> {
  const request = {
    type: "prompt.send" as const,
    requestId: PROMPT_REQUEST_ID,
    deliveryId: DELIVERY_ID,
    conversationId,
    content: "remote prompt",
  };
  const prepared = await gateway.preparePrompt(subject, request);
  if (!("preparationId" in prepared)) return prepared;
  return gateway.commitPrompt(subject, request, prepared.preparationId);
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await removeTemporaryDirectory(directory);
  }
});

describe("provider remote-prompt safety contract", () => {
  it("declares a contract for every known harness", () => {
    for (const harnessId of KNOWN_HARNESS_IDS) {
      const safety = remotePromptSafetyForHarness(harnessId);
      expect(typeof safety.supported).toBe("boolean");
      expect(safety.headline.length).toBeGreaterThan(0);
      expect(safety.explanation.length).toBeGreaterThan(0);
    }
  });

  it("advertises approval-routed harnesses as usable", () => {
    for (const harnessId of APPROVAL_ROUTING_HARNESSES) {
      const safety = remotePromptSafetyForHarness(harnessId);
      expect(safety.supported).toBe(true);
      expect(safety.writesRequireLocalApproval).toBe(true);
      expect(safety.commandsRequireLocalApproval).toBe(true);
      expect(safety.filesystemPolicy).toBe("provider-controlled");
      expect(safety.networkPolicy).not.toBe("unrestricted");
      expect(safety.permissionModel).not.toBe("provider-controlled");
      expect(remotePromptSafetyIsUsable(safety)).toBe(true);
    }
  });

  it("refuses CLI harnesses that cannot route approvals", () => {
    for (const harnessId of CLI_HARNESSES) {
      const safety = remotePromptSafetyForHarness(harnessId);
      expect(safety.supported).toBe(false);
      expect(remotePromptSafetyIsUsable(safety)).toBe(false);
      expect(safety.explanation).toContain("cannot deliver approvals");
    }
  });

  it("keeps each approval-routed harness honest about its own model", () => {
    expect(remotePromptSafetyForHarness("opencode-sdk").permissionModel)
      .toBe("inertia-enforced");
    for (const harnessId of ["codex-app-server", "claude-agent-sdk", "cursor-acp"] as const) {
      expect(remotePromptSafetyForHarness(harnessId).permissionModel)
        .toBe("provider-reported");
    }
    expect(remotePromptSafetyForHarness("codex-app-server").headline)
      .not.toBe(remotePromptSafetyForHarness("opencode-sdk").headline);
  });

  it("never claims an operating-system sandbox", () => {
    for (const harnessId of APPROVAL_ROUTING_HARNESSES) {
      const safety = remotePromptSafetyForHarness(harnessId);
      expect(safety.filesystemPolicy).not.toBe("read-only-sandbox");
      expect(safety.networkPolicy).not.toBe("disabled");
    }
  });

  it("discloses that semantic source-derived prose survives sanitization", () => {
    const paraphrase = "The private configuration describes the launch phrase as violet otter.";
    expect(sanitizeRemoteContent(paraphrase)).toBe(paraphrase);
    for (const harnessId of APPROVAL_ROUTING_HARNESSES) {
      const safety = remotePromptSafetyForHarness(harnessId);
      expect(safety.filesystemPolicy).toBe("provider-controlled");
      expect(safety.explanation).toContain("project-derived text");
    }
  });

  it("fails closed for unknown and malformed capability states", () => {
    expect(remotePromptSafetyForHarness("future-harness"))
      .toEqual(UNSUPPORTED_REMOTE_PROMPT_SAFETY);
    expect(remotePromptSafetyForHarness(null))
      .toEqual(UNSUPPORTED_REMOTE_PROMPT_SAFETY);
    expect(remotePromptSafetyForHarness(undefined))
      .toEqual(UNSUPPORTED_REMOTE_PROMPT_SAFETY);
    expect(remotePromptSafetyIsUsable(null)).toBe(false);
    expect(remotePromptSafetyIsUsable(undefined)).toBe(false);
    expect(remotePromptSafetyIsUsable({
      ...remotePromptSafetyForHarness("codex-app-server"),
      permissionModel: "provider-controlled",
    })).toBe(false);
    expect(remotePromptSafetyIsUsable({
      ...remotePromptSafetyForHarness("codex-app-server"),
      filesystemPolicy: "unrestricted",
    })).toBe(false);
    expect(remotePromptSafetyIsUsable({
      ...remotePromptSafetyForHarness("codex-app-server"),
      networkPolicy: "unrestricted",
    })).toBe(false);
    expect(remotePromptSafetyIsUsable({
      ...remotePromptSafetyForHarness("codex-app-server"),
      writesRequireLocalApproval: false,
    })).toBe(false);
    expect(remotePromptSafetyIsUsable({
      ...remotePromptSafetyForHarness("codex-app-server"),
      commandsRequireLocalApproval: false,
    })).toBe(false);
  });

  it("covers every registered approval-routing harness", () => {
    const harnesses = [
      createCodexAppServerHarness(),
      createClaudeAgentSdkHarness(),
      createCursorAcpHarness(),
      createOpenCodeSdkHarness(),
    ];
    new AgentHarnessRegistry(harnesses);
    for (const harness of harnesses) {
      const safety = remotePromptSafetyForHarness(harness.id);
      expect(safety).not.toEqual(UNSUPPORTED_REMOTE_PROMPT_SAFETY);
      expect(remotePromptSafetyIsUsable(safety)).toBe(true);
      expect(harness.capabilities.extension.approvals).toBe("native");
    }
  });

  it("derives the desktop label from the contract", () => {
    const safety = remotePromptSafetyForHarness("codex-app-server");
    expect(remotePromptSafetyLabel("Codex", safety)).toBe(
      `Codex remote prompt\n${safety.headline}`,
    );
  });
});

describe("gateway enforcement of provider remote-prompt safety", () => {
  it("accepts a prompt for a supported harness", async () => {
    const f = fixture(() => remotePromptSafetyForHarness("codex-app-server"));
    const response = await attemptPrompt(f.gateway, f.subject, f.conversation.id);
    expect(response.ok).toBe(true);
    expect(f.queued()).toBe(1);
  });

  it("refuses a prompt for an unsupported harness", async () => {
    const f = fixture(() => remotePromptSafetyForHarness("codex-cli"));
    const response = await attemptPrompt(f.gateway, f.subject, f.conversation.id);
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.code).toBe("forbidden");
    expect(f.queued()).toBe(0);
  });

  it("refuses a prompt when the capability resolver is absent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-remote-nosafety-"));
    temporaryDirectories.push(directory);
    const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
    stores.push(store);
    const project = store.createProject("Project", directory);
    const conversation = store.createConversation(project.id, "Conversation");
    store.updateConversation(conversation.id, { accessMode: "supervised" });
    let queued = 0;
    const gateway = new RemoteRuntimeGateway({
      shell: () => store.shellSnapshot(),
      detail: (conversationId) => store.conversationDetail(conversationId),
      isConversationActive: () => false,
      preparePrompt: async () => undefined,
      queuePrompt: () => ({ turnId: `turn-${++queued}` }),
      now: () => new Date("2030-01-01T00:00:00.000Z"),
    });
    const response = await attemptPrompt(gateway, {
      deviceId: "09400fa3-32c0-4d8d-8d17-e8ea0a4f6937",
      sessionId: "7f0c11aa-9ee8-4e3c-8f8f-0907e31b389e",
      scopes: ["view", "prompt"],
      projectIds: [project.id],
      grants: remoteConversationGrantsFromProjectIds([project.id]),
      grantVersion: 1,
      expiresAt: "2030-02-01T00:00:00.000Z",
    }, conversation.id);
    expect(response.ok).toBe(false);
    expect(queued).toBe(0);
  });

  it("fails closed when the capability query throws", async () => {
    const f = fixture(() => {
      throw new Error("provider startup failed");
    });
    const response = await attemptPrompt(f.gateway, f.subject, f.conversation.id);
    expect(response.ok).toBe(false);
    expect(f.queued()).toBe(0);
  });

  it("recalculates eligibility when the provider harness changes", async () => {
    let harnessId = "codex-app-server";
    const f = fixture(() => remotePromptSafetyForHarness(harnessId));
    const accepted = await attemptPrompt(
      f.gateway,
      f.subject,
      f.conversation.id,
    );
    expect(accepted.ok).toBe(true);

    harnessId = "codex-cli";
    const refused = await f.gateway.preparePrompt(f.subject, {
      type: "prompt.send",
      requestId: "8e1c2a44-9f3b-4c51-8d62-1a2b3c4d5e6f",
      deliveryId: "9f2d3b55-1c4e-4a62-9b73-2c3d4e5f6a7b",
      conversationId: f.conversation.id,
      content: "after switching",
    });
    expect("preparationId" in refused).toBe(false);
    if (!("preparationId" in refused)) expect(refused.ok).toBe(false);
  });

  it("keeps view-only access working when prompting is unsupported", async () => {
    const f = fixture(() => remotePromptSafetyForHarness("claude-cli"));
    const viewOnly: RemoteAuthorizationSubject = {
      ...f.subject,
      scopes: ["view"],
    };
    const state = await f.gateway.request(viewOnly, {
      type: "state.get",
      requestId: STATE_REQUEST_ID,
    });
    expect(state.ok).toBe(true);
    if (state.ok && state.result.kind === "state") {
      expect(state.result.state.conversations).toHaveLength(1);
      expect(state.result.state.conversations[0]?.promptSafety.supported)
        .toBe(false);
    }
    const detail = await f.gateway.request(viewOnly, {
      type: "conversation.get",
      requestId: STATE_REQUEST_ID,
      conversationId: f.conversation.id,
    });
    expect(detail.ok).toBe(true);
  });

  it("reports truthful per-provider text in the projection", async () => {
    const f = fixture(() => remotePromptSafetyForHarness("opencode-sdk"));
    const state = await f.gateway.request(f.subject, {
      type: "state.get",
      requestId: STATE_REQUEST_ID,
    });
    expect(state.ok).toBe(true);
    if (!state.ok || state.result.kind !== "state") return;
    const projected = state.result.state.conversations[0];
    expect(projected?.promptSafety.supported).toBe(true);
    expect(projected?.promptSafety.headline).toBe(
      remotePromptSafetyForHarness("opencode-sdk").headline,
    );
  });

  it("marks prompting unsupported when access is not supervised", async () => {
    const f = fixture(() => remotePromptSafetyForHarness("codex-app-server"));
    f.store.updateConversation(f.conversation.id, { accessMode: "full" });
    const state = await f.gateway.request(f.subject, {
      type: "state.get",
      requestId: STATE_REQUEST_ID,
    });
    expect(state.ok).toBe(true);
    if (!state.ok || state.result.kind !== "state") return;
    expect(state.result.state.conversations[0]?.promptSafety.supported)
      .toBe(false);
    const response = await attemptPrompt(f.gateway, f.subject, f.conversation.id);
    expect(response.ok).toBe(false);
  });
});
