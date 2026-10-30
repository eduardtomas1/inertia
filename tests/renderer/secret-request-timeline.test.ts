import { describe, expect, it } from "vitest";

import { AGENT_SECRET_SAVE_ERRORS } from "../../src/shared/agent-secret-save-errors";
import { AGENT_SECRET_REVOKE_ERRORS } from "../../src/shared/agent-secret-revoke-errors";
import type { SecretRequestReference } from "../../src/shared/agent-secrets";
import type { AgentTurn, ChatMessage } from "../../src/shared/contracts";
import {
  buildResponseTimeline,
  estimateTimelineRowSize,
  shouldConsolidateSettledWorkIntoRunDetails,
  stabilizeResponseTimeline,
  type ResponseTimelineItem,
  type ResponseTurn,
} from "../../src/renderer/src/utils/responseTimeline";
import { withSecretRequests, type TurnWorkStreamEntry } from "../../src/renderer/src/utils/response-timeline/execution";
import {
  estimateSecretRequestHeight,
  isSecretRequestMessage,
  pendingSecretRequest,
  secretRequestAnnouncement,
  secretRequestExpiry,
  secretRequestSavedAgo,
  secretRequestStatusText,
  secretRevokeFailure,
  type SecretRequestMessage,
} from "../../src/renderer/src/utils/response-timeline/secretRequests";
import { secretRequestFootnote, secretSaveFailureMessage } from "../../src/renderer/src/utils/response-timeline/secretRequestForm";

const conversationId = "15151515-1515-4151-8151-151515151515";
const turnId = "turn-secret-model";
const requestId = "0c9c8d7e-6f5a-4b3c-9d2e-1f0a9b8c7d6e";

function at(seconds: number): string {
  return `2030-04-01T10:00:${String(seconds).padStart(2, "0")}.000Z`;
}

function settledTurn(status: AgentTurn["status"] = "completed"): AgentTurn {
  const completed = status === "completed";
  return {
    id: turnId,
    conversationId,
    runId: "run-secret-model",
    userMessageId: "request",
    terminalAssistantMessageId: completed ? "answer" : null,
    providerId: "codex",
    modelSelection: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendProfileDisplayName: "Codex App Server",
      backendConfigurationRevision: 1,
      modelId: "gpt-5.6",
      alias: null,
      reasoningEffort: "high",
      contextWindowOverride: null,
      providerOptions: {},
      capabilities: [],
    },
    continuationIdentity: {
      harnessId: "codex-app-server",
      backendProfileId: "native:codex:app-server",
      backendConfigurationRevision: 1,
      endpointIdentity: null,
      modelIdentity: "gpt-5.6",
    },
    harnessId: "codex-app-server",
    backendProfileId: "native:codex:app-server",
    model: "gpt-5.6",
    modelAlias: null,
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
    providerSessionBefore: null,
    providerSessionAfter: null,
    requestedAt: at(0),
    startedAt: at(1),
    completedAt: completed ? at(9) : null,
    status,
    terminalReason: null,
    checkpointId: null,
    usageAtStart: null,
    usageAtCompletion: null,
    configurationRevision: 1,
    association: "authoritative",
    createdAt: at(0),
    updatedAt: at(9),
  };
}

function message(id: string, role: ChatMessage["role"], content: string, seconds: number, update: Partial<ChatMessage> = {}): ChatMessage {
  return { id, conversationId, turnId, role, content, attachments: [], createdAt: at(seconds), ...update };
}

function reference(update: Partial<SecretRequestReference> = {}): SecretRequestReference {
  return {
    requestId,
    title: "Tailscale auth key",
    description: "Create a reusable key in the admin console.",
    ttlHours: 24,
    status: "pending",
    answeredAt: null,
    expiresAt: null,
    storage: null,
    ...update,
  };
}

const saved = reference({ status: "saved", answeredAt: at(5), expiresAt: "2030-04-02T10:00:05.000Z", storage: "keychain" });

function secret(seconds: number, secretRequest: SecretRequestReference = reference()): ChatMessage {
  return message(`secret-${seconds}`, "system", `Asked for a secret: ${secretRequest.title}`, seconds, { secretRequest });
}

const request = message("request", "user", "Join the CI VMs to the tailnet.", 0);
const answer = message("answer", "assistant", "The VMs are on the tailnet.", 8);

const turns = { completed: settledTurn("completed"), running: settledTurn("running") };

function timeline(messages: ChatMessage[], status: "completed" | "running" = "completed"): ResponseTimelineItem[] {
  return buildResponseTimeline({
    turns: [turns[status]],
    messages: status === "completed" ? [request, ...messages, answer] : [request, ...messages],
    activities: [],
    reasonings: [],
    checkpoints: [],
  });
}

function onlyTurn(items: ResponseTimelineItem[]): ResponseTurn {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item?.kind !== "turn") throw new Error("Expected one authoritative turn.");
  return item.turn;
}

describe("secret requests in the response timeline model", () => {
  it("partitions secret request rows away from system notices so clean work still consolidates", () => {
    const card = secret(5, saved);
    const notice = message("notice", "system", "Provider reconnected.", 6);
    const turn = onlyTurn(timeline([card]));
    expect(turn.secretRequests).toEqual([card]);
    expect(turn.systemMessages).toEqual([]);
    expect(shouldConsolidateSettledWorkIntoRunDetails(turn)).toBe(true);

    const mixed = onlyTurn(timeline([card, notice]));
    expect(mixed.secretRequests).toEqual([card]);
    expect(mixed.systemMessages).toEqual([notice]);
  });

  it("claims the row for its turn instead of the compatibility bucket", () => {
    const items = timeline([secret(5)]);
    expect(items.some((item) => item.kind === "compatibility")).toBe(false);
  });

  it("recognises only turn-scoped system messages with a reference", () => {
    expect(isSecretRequestMessage(secret(5))).toBe(true);
    expect(isSecretRequestMessage(message("user", "user", "x", 5, { secretRequest: reference() }))).toBe(false);
    expect(isSecretRequestMessage(message("loose", "system", "x", 5, { turnId: null, secretRequest: reference() }))).toBe(false);
    expect(isSecretRequestMessage(message("plain", "system", "x", 5))).toBe(false);
  });

  it("keeps the turn identity when nothing changed and replaces it when the status changes", () => {
    const pending = secret(5);
    const first = stabilizeResponseTimeline(timeline([pending], "running"), []);
    expect(stabilizeResponseTimeline(timeline([pending], "running"), first)).toBe(first);
    const changed = stabilizeResponseTimeline(timeline([secret(5, saved)], "running"), first);
    expect(onlyTurn(changed)).not.toBe(onlyTurn(first));
    expect(onlyTurn(changed).secretRequests[0]!.secretRequest.status).toBe("saved");
  });

  it("places the card at its chronological position in the work stream", () => {
    const lead: TurnWorkStreamEntry = { kind: "commentary", id: "lead", createdAt: at(4), message: null, content: "Next I need the key.", streaming: false };
    const after: TurnWorkStreamEntry = { kind: "activity-group", id: "build", createdAt: at(7), activities: [] };
    const card = secret(5) as SecretRequestMessage;
    const stream = withSecretRequests([lead, after], [card]);
    expect(stream.map(({ id }) => id)).toEqual(["lead", `secret-request:${requestId}`, "build"]);
    const empty = [lead];
    expect(withSecretRequests(empty, [])).toBe(empty);
  });

  it("reserves a pending card's height and a single 36 px row once settled", () => {
    const options = { availableWidth: 900 };
    const [plain] = timeline([], "running");
    const [pending] = timeline([secret(5)], "running");
    const [settled] = timeline([secret(5, saved)], "running");
    const base = estimateTimelineRowSize(plain!, options);
    const pendingSize = estimateTimelineRowSize(pending!, options);
    const settledSize = estimateTimelineRowSize(settled!, options);
    expect(settledSize).toBeGreaterThan(base);
    expect(settledSize - base).toBeLessThanOrEqual(44);
    expect(pendingSize - settledSize).toBeGreaterThanOrEqual(120);
    expect(estimateSecretRequestHeight(reference({ description: "x".repeat(400) }), 80))
      .toBeGreaterThan(estimateSecretRequestHeight(reference(), 80));
  });

  it("finds the latest pending request for the composer notice", () => {
    const pending = secret(6) as SecretRequestMessage;
    expect(pendingSecretRequest([secret(5, saved), pending])).toBe(pending);
    expect(pendingSecretRequest([secret(5, saved)])).toBeNull();
  });
});

describe("secret request copy", () => {
  const now = Date.parse("2030-04-01T10:00:05.000Z");

  it("formats the footnote, expiry and saved age", () => {
    expect(secretRequestFootnote(24)).toBe("Kept out of chat, in a private file this agent's commands can read for 24 hours");
    expect(secretRequestFootnote(1)).toBe("Kept out of chat, in a private file this agent's commands can read for 1 hour");
    expect(secretRequestExpiry("2030-04-02T10:00:05.000Z", now)).toBe("expires in 24h");
    expect(secretRequestExpiry("2030-04-02T10:00:04.000Z", now)).toBe("expires in 23h");
    expect(secretRequestExpiry("2030-04-01T10:42:05.000Z", now)).toBe("expires in 42m");
    expect(secretRequestExpiry("2030-04-01T10:00:00.000Z", now)).toBe("expiring now");
    expect(secretRequestSavedAgo("2030-04-01T08:00:05.000Z", now)).toBe("Saved 2h ago");
    expect(secretRequestSavedAgo("2030-04-01T09:59:05.000Z", now)).toBe("Saved 1m ago");
    expect(secretRequestSavedAgo("2030-04-01T10:00:00.000Z", now)).toBe("Saved just now");
  });

  it("uses the settled copy for every terminal status", () => {
    expect(secretRequestStatusText(reference({ status: "declined", answeredAt: at(5) }), now)).toBe("Declined");
    expect(secretRequestStatusText(reference({ status: "ended" }), now)).toBe("Request ended");
    expect(secretRequestStatusText({ ...saved, status: "expired" }, now)).toBe("Expired");
    expect(secretRequestStatusText({ ...saved, status: "revoked" }, now)).toBe("Revoked");
    expect(secretRequestStatusText({ ...saved, storage: "memory" }, now)).toBe("Saved · expires in 24h · kept until Inertia quits");
  });

  it("passes only known fixed failure messages through", () => {
    expect(secretSaveFailureMessage(new Error("Error invoking remote method: Error: The secret must be on a single line."))).toBe("The secret must be on a single line.");
    expect(secretSaveFailureMessage(new Error("boom fixture-123"))).toBe("The secret could not be saved. Try again.");
    expect(secretSaveFailureMessage("fixture-123")).toBe("The secret could not be saved. Try again.");
  });

  it("shows every fixed main-process save error on the card", () => {
    expect(Object.values(AGENT_SECRET_SAVE_ERRORS)).toHaveLength(7);
    for (const message of Object.values(AGENT_SECRET_SAVE_ERRORS)) {
      expect(secretSaveFailureMessage(new Error(`Error invoking remote method 'inertia:save-agent-secret': Error: ${message}`))).toBe(message);
    }
    expect(secretSaveFailureMessage(new Error(AGENT_SECRET_SAVE_ERRORS.limit))).toBe("Too many agent secrets are active. Revoke one in Settings, then try again.");
    expect(secretSaveFailureMessage(new Error(AGENT_SECRET_SAVE_ERRORS.fileFailed))).toBe("Inertia couldn't write the private file. Try again.");
  });

  it("shows only the vetted runtime revoke failures and falls back otherwise", () => {
    expect(secretRevokeFailure(new Error(AGENT_SECRET_REVOKE_ERRORS.inUse)))
      .toBe("A program is still using this secret's file, so Inertia couldn't delete it. Close it and try again.");
    expect(secretRevokeFailure(new Error(AGENT_SECRET_REVOKE_ERRORS.notActive))).toBe("That secret is no longer active.");
    expect(secretRevokeFailure(new Error("EBUSY: resource busy or locked, unlink '/home/me/.inertia/agent-secrets/x/key'")))
      .toBe("Couldn't revoke. Try again.");
    expect(secretRevokeFailure("fixture-123", "The secret could not be revoked.")).toBe("The secret could not be revoked.");
  });

  it("announces each settled transition", () => {
    expect(["pending", "saved", "declined", "ended", "expired", "revoked"].map((status) =>
      secretRequestAnnouncement(status as SecretRequestReference["status"])))
      .toEqual(["", "Secret saved", "Declined", "Request ended", "Secret expired", "Secret revoked"]);
  });
});
