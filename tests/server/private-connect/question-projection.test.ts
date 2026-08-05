import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseRuntimeWorkerEvent } from "../../../src/node/runtime-process-protocol";
import { RuntimeStore } from "../../../src/server/database";
import { PrivateConnectRuntimeGateway } from "../../../src/server/private-connect/runtime-gateway";
import type { AgentInputQuestion, AgentInputRequest } from "../../../src/shared/contracts";
import { privateConnectRequestSchema } from "../../../src/shared/private-connect/protocol";
import { PRIVATE_CONNECT_QUESTION_LIMITS } from "../../../src/shared/private-connect/questions";
import {
  privateConnectRuntimeRequestSchema,
  privateConnectRuntimeResponseSchema,
  type PrivateConnectRuntimeAuthorization,
} from "../../../src/shared/private-connect/runtime-contract";
import { privateConnectRuntimeGrantsFromProjectIds } from "../../../src/shared/private-connect/runtime-grants";

const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const INPUT_REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const PROVIDER_QUESTION_ID = "toolu_01AbCdEfGhIjKlMnOpQrStUv:question:1";

const directories: string[] = [];
const stores: RuntimeStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function question(overrides: Partial<AgentInputQuestion> = {}): AgentInputQuestion {
  return {
    id: PROVIDER_QUESTION_ID,
    header: "Question",
    question: "Which branch should the change target?",
    isOther: false,
    isSecret: false,
    allowMultiple: false,
    options: [
      { id: "main", label: "main", description: "" },
      { id: "develop", label: "develop", description: "" },
    ],
    ...overrides,
  };
}

function fixture(questions: AgentInputQuestion[]) {
  const directory = mkdtempSync(join(tmpdir(), "inertia-private-connect-questions-"));
  directories.push(directory);
  const store = new RuntimeStore(join(directory, "inertia.sqlite"), directory);
  stores.push(store);
  const project = store.createProject("Granted", directory);
  const conversation = store.createConversation(project.id, "Granted chat");
  const pending: AgentInputRequest = {
    id: INPUT_REQUEST_ID,
    providerId: "codex",
    conversationId: conversation.id,
    runId: "run-1",
    turnId: "turn-1",
    questions,
    autoResolutionMs: null,
  };
  const gateway = new PrivateConnectRuntimeGateway({
    shell: () => store.shellSnapshot(),
    detail: (conversationId) => store.conversationDetail(conversationId),
    isConversationActive: () => false,
    preparePrompt: async () => undefined,
    queuePrompt: () => ({ turnId: "turn-1" }),
    inputs: () => [pending],
  });
  const subject: PrivateConnectRuntimeAuthorization = {
    deviceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    scopes: ["view", "prompt"],
    projectIds: [project.id],
    grants: privateConnectRuntimeGrantsFromProjectIds([project.id]),
    grantVersion: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  return { gateway, subject, conversation };
}

async function detailFor(questions: AgentInputQuestion[]) {
  const { gateway, subject, conversation } = fixture(questions);
  const response = await gateway.request(subject, {
    type: "conversation.get",
    requestId: REQUEST_ID,
    conversationId: conversation.id,
  });
  return response;
}

describe("Private Connect question projection", () => {
  it("keeps provider-shaped question identities parseable at the runtime boundary", async () => {
    const response = await detailFor([question()]);
    expect(response.ok).toBe(true);
    if (!response.ok || response.result.kind !== "conversation") throw new Error("unexpected projection");
    expect(response.result.detail.questions?.[0]?.id).toBe(PROVIDER_QUESTION_ID);
    expect(privateConnectRuntimeResponseSchema.safeParse(response).success).toBe(true);
    expect(parseRuntimeWorkerEvent({
      type: "runtime.private-connect-response",
      requestId: REQUEST_ID,
      response,
    })).not.toBeNull();
  });

  it("reports a custom answer capability for free-form provider questions", async () => {
    const withOther = await detailFor([question({ isOther: true })]);
    const fixedOptions = await detailFor([question()]);
    const noOptions = await detailFor([question({ options: [] })]);
    if (!withOther.ok || withOther.result.kind !== "conversation") throw new Error("unexpected projection");
    if (!fixedOptions.ok || fixedOptions.result.kind !== "conversation") throw new Error("unexpected projection");
    if (!noOptions.ok || noOptions.result.kind !== "conversation") throw new Error("unexpected projection");
    expect(withOther.result.detail.questions?.[0]?.allowCustomAnswer).toBe(true);
    expect(fixedOptions.result.detail.questions?.[0]?.allowCustomAnswer).toBe(false);
    expect(noOptions.result.detail.questions?.[0]?.allowCustomAnswer).toBe(true);
  });

  it("never projects a secret question", async () => {
    const response = await detailFor([question({ isSecret: true })]);
    if (!response.ok || response.result.kind !== "conversation") throw new Error("unexpected projection");
    expect(response.result.detail.questions).toEqual([]);
    expect(response.result.detail.inputRequestId).toBeNull();
    expect(JSON.stringify(response)).not.toContain("Which branch");
  });

  it("withholds an input request that cannot be answered within projected bounds", async () => {
    const tooMany = Array.from(
      { length: PRIVATE_CONNECT_QUESTION_LIMITS.questions + 1 },
      (_value, index) => question({ id: `${PROVIDER_QUESTION_ID}:${index}` }),
    );
    const response = await detailFor(tooMany);
    if (!response.ok || response.result.kind !== "conversation") throw new Error("unexpected projection");
    expect(response.result.detail.questions).toEqual([]);
    expect(response.result.detail.inputRequestId).toBeNull();
    expect(response.result.detail.waitingForLocalAction).toBe(true);
  });

  it("withholds an input request whose identifiers exceed the projected bounds", async () => {
    const response = await detailFor([
      question({ id: "q".repeat(PRIVATE_CONNECT_QUESTION_LIMITS.identifierCharacters + 1) }),
    ]);
    if (!response.ok || response.result.kind !== "conversation") throw new Error("unexpected projection");
    expect(response.result.detail.questions).toEqual([]);
    expect(response.result.detail.inputRequestId).toBeNull();
  });
});

describe("Private Connect answer contracts", () => {
  const freeFormAnswer = "b".repeat(600);

  it("accepts a bounded free-form answer keyed by a provider question identity", () => {
    const browserRequest = {
      protocolVersion: 1 as const,
      type: "input.respond" as const,
      requestId: REQUEST_ID,
      conversationId: "33333333-3333-4333-8333-333333333333",
      inputRequestId: INPUT_REQUEST_ID,
      answers: { [PROVIDER_QUESTION_ID]: [freeFormAnswer] },
    };
    expect(privateConnectRequestSchema.safeParse(browserRequest).success).toBe(true);
    const { protocolVersion: _protocolVersion, ...runtimeRequest } = browserRequest;
    expect(privateConnectRuntimeRequestSchema.safeParse(runtimeRequest).success).toBe(true);
  });

  it("rejects answers past the per-value and aggregate bounds", () => {
    const base = {
      protocolVersion: 1 as const,
      type: "input.respond" as const,
      requestId: REQUEST_ID,
      conversationId: "33333333-3333-4333-8333-333333333333",
      inputRequestId: INPUT_REQUEST_ID,
    };
    expect(privateConnectRequestSchema.safeParse({
      ...base,
      answers: {
        [PROVIDER_QUESTION_ID]: [
          "c".repeat(PRIVATE_CONNECT_QUESTION_LIMITS.answerCharacters + 1),
        ],
      },
    }).success).toBe(false);
    expect(privateConnectRequestSchema.safeParse({
      ...base,
      answers: Object.fromEntries(
        Array.from({ length: 8 }, (_value, index) => [
          `${PROVIDER_QUESTION_ID}:${index}`,
          ["d".repeat(PRIVATE_CONNECT_QUESTION_LIMITS.answerCharacters)],
        ]),
      ),
    }).success).toBe(false);
  });
});
