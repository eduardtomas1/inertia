import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const STATE_VALIDATOR = "A".repeat(43);
const CONVERSATION_VALIDATOR = "B".repeat(43);

let scopes: string[] = [];
let runId: string | null = null;
const sent: Array<Record<string, unknown>> = [];

function conversation() {
  return {
    id: CONVERSATION_ID,
    projectId: PROJECT_ID,
    title: "Conversation",
    providerLabel: "Codex",
    runId,
    status: "idle",
    pendingLocalApproval: false,
    pendingLocalAction: false,
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

const socket = {
  request: vi.fn(async (request: { type: string; requestId?: string }) => {
    sent.push(request as Record<string, unknown>);
    const requestId = request.requestId ?? "11111111-1111-4111-8111-111111111111";
    if (request.type === "state.get") {
      return {
        type: "response", requestId, ok: true,
        result: {
          kind: "state", validator: STATE_VALIDATOR,
          state: {
            generatedAt: "2030-01-01T00:00:00.000Z",
            projects: [{ id: PROJECT_ID, name: "Project" }],
            conversations: [conversation()],
            capabilities: { scopes, preset: scopes.length > 1 ? "collaborate" : "monitor", expiresAt: "2030-02-01T00:00:00.000Z" },
          },
        },
      };
    }
    if (request.type === "conversation.get") {
      return {
        type: "response", requestId, ok: true,
        result: {
          kind: "conversation", validator: CONVERSATION_VALIDATOR,
          detail: {
            generatedAt: "2030-01-01T00:00:00.000Z",
            conversation: conversation(),
            messages: [{ id: "m1", role: "assistant", content: "hello", createdAt: "2030-01-01T00:00:00.000Z", turnId: null }],
            questions: [],
            waitingForLocalAction: false,
          },
        },
      };
    }
    return { type: "response", requestId, ok: true, result: { kind: "prompt.accepted", deliveryId: "d", turnId: "t" } };
  }),
  onClose: vi.fn(() => () => undefined),
  close: vi.fn(),
};

vi.mock("../../src/renderer/private-connect/src/connection", () => ({
  apiRequest: vi.fn(async (request: { type: string }) => socket.request(request)),
  browserDeviceId: () => "55555555-5555-4555-8555-555555555555",
  connectPrivateConnectSocket: vi.fn(async () => socket),
  jsonRequest: vi.fn(),
  parsePairingFragment: () => null,
}));

import App from "../../src/renderer/private-connect/src/App";

afterEach(() => {
  sent.length = 0;
  scopes = [];
  runId = null;
  vi.clearAllMocks();
});

async function openConversation(): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
  render(<App initialPairingFragment={null} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /Conversation/u })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /Conversation/u }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Conversation" })).toBeInTheDocument());
}

describe("Private Connect packaged workspace", () => {
  it("hides every mutation control from a Monitor browser", async () => {
    scopes = ["private:read"];
    runId = "run-1";
    await openConversation();
    expect(screen.queryByRole("textbox", { name: "Send a prompt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop run" })).not.toBeInTheDocument();
    expect(sent.some((request) => request.type === "prompt.send")).toBe(false);
  });

  it("lets a Collaborate browser send a prompt and stop an active run", async () => {
    scopes = ["private:read", "private:prompt", "private:stop"];
    runId = "run-1";
    await openConversation();

    const composer = screen.getByRole("textbox", { name: "Send a prompt" });
    expect(composer).toHaveAttribute("maxlength", "8000");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.change(composer, { target: { value: "  please continue  " } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent.some((request) => request.type === "prompt.send")).toBe(true));
    const prompt = sent.find((request) => request.type === "prompt.send");
    expect(prompt).toMatchObject({ conversationId: CONVERSATION_ID, content: "please continue" });
    expect(prompt).toHaveProperty("deliveryId");

    fireEvent.click(screen.getByRole("button", { name: "Stop run" }));
    await waitFor(() => expect(sent.some((request) => request.type === "run.stop")).toBe(true));
    expect(sent.find((request) => request.type === "run.stop")).toMatchObject({
      conversationId: CONVERSATION_ID,
      runId: "run-1",
    });
  });

  it("does not send a prompt that exceeds the shared protocol limit", async () => {
    scopes = ["private:read", "private:prompt"];
    await openConversation();

    const composer = screen.getByRole("textbox", { name: "Send a prompt" });
    fireEvent.change(composer, { target: { value: "x".repeat(8_001) } });
    fireEvent.submit(composer.closest("form")!);

    await waitFor(() => expect(screen.getByText("Prompts are limited to 8,000 characters.")).toBeInTheDocument());
    expect(sent.some((request) => request.type === "prompt.send")).toBe(false);
  });

  it("offers no stop control when the granted conversation has no active run", async () => {
    scopes = ["private:read", "private:prompt", "private:stop"];
    runId = null;
    await openConversation();
    expect(screen.queryByRole("button", { name: "Stop run" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toBeInTheDocument();
  });
});
