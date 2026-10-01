import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const STATE_VALIDATOR = "A".repeat(43);
const CONVERSATION_VALIDATOR = "B".repeat(43);

let scopes: string[] = [];
let runId: string | null = null;
let conversationAvailable = true;
let otherConversationAvailable = false;
let uncertainPromptResponses = 0;
let promptResponseGate: Promise<void> | null = null;
const sent: Array<Record<string, unknown>> = [];

function conversation(id = CONVERSATION_ID) {
  return {
    id,
    projectId: PROJECT_ID,
    title: id === CONVERSATION_ID ? "Conversation" : "Other chat",
    providerLabel: "Codex",
    runId,
    status: "idle",
    pendingLocalApproval: false,
    pendingLocalAction: false,
    updatedAt: "2030-01-01T00:00:00.000Z",
  };
}

const socket = {
  request: vi.fn(async (request: { type: string; requestId?: string; conversationId?: string }) => {
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
            conversations: [
              ...(conversationAvailable ? [conversation()] : []),
              ...(otherConversationAvailable ? [conversation(OTHER_CONVERSATION_ID)] : []),
            ],
            capabilities: { scopes, preset: scopes.length > 1 ? "collaborate" : "monitor", expiresAt: "2030-02-01T00:00:00.000Z" },
          },
        },
      };
    }
    if (request.type === "conversation.get") {
      if (request.conversationId === OTHER_CONVERSATION_ID ? !otherConversationAvailable : !conversationAvailable) {
        return {
          type: "response", requestId, ok: false,
          code: "not-found",
          message: "That conversation is unavailable to this device.",
        };
      }
      return {
        type: "response", requestId, ok: true,
        result: {
          kind: "conversation", validator: CONVERSATION_VALIDATOR,
          detail: {
            generatedAt: "2030-01-01T00:00:00.000Z",
            conversation: conversation(request.conversationId),
            messages: [{ id: "m1", role: "assistant", content: "hello", createdAt: "2030-01-01T00:00:00.000Z", turnId: null }],
            questions: [],
            waitingForLocalAction: false,
          },
        },
      };
    }
    if (request.type === "prompt.send" && promptResponseGate) await promptResponseGate;
    if (request.type === "prompt.send" && uncertainPromptResponses > 0) {
      uncertainPromptResponses -= 1;
      return {
        type: "response", requestId, ok: false,
        code: "uncertain",
        message: "The prompt result is uncertain.",
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
  cleanup();
  sent.length = 0;
  scopes = [];
  runId = null;
  conversationAvailable = true;
  otherConversationAvailable = false;
  uncertainPromptResponses = 0;
  promptResponseGate = null;
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openConversation(): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrf: "csrf-token" }), { status: 200 })));
  render(<App initialPairingFragment={null} />);
  await waitFor(() => expect(screen.getByRole("button", { name: /Conversation/u })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /Conversation/u }));
  await waitFor(() => expect(screen.getByRole("heading", { name: "Conversation" })).toBeInTheDocument());
}

async function selectConversation(name: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`, "u") }));
  await waitFor(() => expect(screen.getByRole("heading", { name })).toBeInTheDocument());
}

describe("Private Connect packaged workspace", () => {
  it.each(["sidebar", "notification"])("preserves separate drafts when a %s opens another chat", async (navigation) => {
    scopes = ["private:read", "private:prompt"];
    otherConversationAvailable = true;
    const serviceWorker = new EventTarget();
    vi.stubGlobal("navigator", Object.create(navigator, { serviceWorker: { value: serviceWorker } }));
    await openConversation();
    fireEvent.change(screen.getByRole("textbox", { name: "Send a prompt" }), { target: { value: "First chat draft" } });

    if (navigation === "sidebar") await selectConversation("Other chat");
    else {
      await act(async () => {
        serviceWorker.dispatchEvent(new MessageEvent("message", {
          data: { type: "private-connect.open-conversation", conversationId: OTHER_CONVERSATION_ID },
        }));
      });
      await waitFor(() => expect(screen.getByRole("heading", { name: "Other chat" })).toBeInTheDocument());
    }
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Send a prompt" }), { target: { value: "Other chat draft" } });

    await selectConversation("Conversation");
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue("First chat draft");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue(""));
    expect(sent.find((request) => request.type === "prompt.send")).toMatchObject({
      conversationId: CONVERSATION_ID, content: "First chat draft",
    });
    await selectConversation("Other chat");
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue("Other chat draft");
  });

  it("retains an uncertain delivery receipt while sending in another chat", async () => {
    scopes = ["private:read", "private:prompt"];
    otherConversationAvailable = true;
    uncertainPromptResponses = 1;
    await openConversation();
    fireEvent.change(screen.getByRole("textbox", { name: "Send a prompt" }), { target: { value: "Retry first chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText(/Sending again will safely check/iu)).toBeInTheDocument());
    const firstDeliveryId = sent.find((request) => request.type === "prompt.send")?.deliveryId;

    await selectConversation("Other chat");
    fireEvent.change(screen.getByRole("textbox", { name: "Send a prompt" }), { target: { value: "Send other chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue(""));
    await selectConversation("Conversation");
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue("Retry first chat");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent.filter((request) => request.type === "prompt.send")).toHaveLength(3));
    expect(sent.filter((request) => request.type === "prompt.send")[2]).toMatchObject({
      conversationId: CONVERSATION_ID, content: "Retry first chat", deliveryId: firstDeliveryId,
    });
  });

  it("settles a pending send without clearing the newly selected chat's draft", async () => {
    scopes = ["private:read", "private:prompt"];
    otherConversationAvailable = true;
    await openConversation();
    await selectConversation("Other chat");
    fireEvent.change(screen.getByRole("textbox", { name: "Send a prompt" }), { target: { value: "Keep other chat draft" } });
    await selectConversation("Conversation");
    fireEvent.change(screen.getByRole("textbox", { name: "Send a prompt" }), { target: { value: "Send first chat" } });
    let finish!: () => void;
    promptResponseGate = new Promise<void>((resolve) => { finish = resolve; });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent.some((request) => request.type === "prompt.send")).toBe(true));
    await selectConversation("Other chat");
    await act(async () => { finish(); await promptResponseGate; });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Send a prompt" })).not.toBeDisabled());
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue("Keep other chat draft");
    await selectConversation("Conversation");
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue("");
  });

  it("forgets a removed background chat's draft and receipt while preserving the selected draft", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    scopes = ["private:read", "private:prompt"];
    otherConversationAvailable = true;
    uncertainPromptResponses = 1;
    await openConversation();
    fireEvent.change(screen.getByRole("textbox", { name: "Send a prompt" }), { target: { value: "Retry first chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText(/Sending again will safely check/iu)).toBeInTheDocument());
    const firstDeliveryId = sent.find((request) => request.type === "prompt.send")?.deliveryId;
    await selectConversation("Other chat");
    fireEvent.change(screen.getByRole("textbox", { name: "Send a prompt" }), { target: { value: "Keep other chat draft" } });

    conversationAvailable = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.queryByRole("button", { name: /^Conversation/u })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue("Keep other chat draft");
    conversationAvailable = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await selectConversation("Conversation");
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue("");
    fireEvent.change(screen.getByRole("textbox", { name: "Send a prompt" }), { target: { value: "Retry first chat" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent.filter((request) => request.type === "prompt.send")).toHaveLength(2));
    expect(sent.filter((request) => request.type === "prompt.send")[1]?.deliveryId).not.toBe(firstDeliveryId);
    await selectConversation("Other chat");
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toHaveValue("Keep other chat draft");
  });

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

  it("keeps in-memory context visible offline but disables every mutation", async () => {
    scopes = ["private:read", "private:prompt", "private:input", "private:stop"];
    runId = "run-1";
    await openConversation();

    await act(() => window.dispatchEvent(new Event("offline")));

    expect(screen.getByRole("status")).toHaveTextContent(/not stored for offline use/iu);
    expect(screen.getByRole("textbox", { name: "Send a prompt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop run" })).toBeDisabled();
    expect(screen.getByRole("heading", { name: "Conversation" })).toBeInTheDocument();
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

  it("clears removed conversation state and stops requesting its detail", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let uuidSequence = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() =>
      `10000000-0000-4000-8000-${String(++uuidSequence).padStart(12, "0")}`);
    scopes = ["private:read", "private:prompt"];
    uncertainPromptResponses = 1;
    await openConversation();

    const composer = screen.getByRole("textbox", { name: "Send a prompt" });
    fireEvent.change(composer, { target: { value: "retry this prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByText(/Sending again will safely check/iu)).toBeInTheDocument());
    const firstDeliveryId = sent.find((request) =>
      request.type === "prompt.send")?.deliveryId;

    conversationAvailable = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    await waitFor(() => expect(screen.getByRole("heading", {
      name: "Choose a conversation",
    })).toBeInTheDocument());
    expect(screen.queryByText("hello", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Send a prompt" })).not.toBeInTheDocument();
    const detailRequestsAfterRemoval = sent.filter((request) =>
      request.type === "conversation.get").length;

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(sent.filter((request) => request.type === "conversation.get"))
      .toHaveLength(detailRequestsAfterRemoval);

    conversationAvailable = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await waitFor(() => expect(screen.getByRole("button", {
      name: /Conversation/u,
    })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Conversation/u }));
    const restoredComposer = await screen.findByRole("textbox", {
      name: "Send a prompt",
    });
    expect(restoredComposer).toHaveValue("");

    fireEvent.change(restoredComposer, { target: { value: "retry this prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sent.filter((request) =>
      request.type === "prompt.send")).toHaveLength(2));
    const secondDeliveryId = sent.filter((request) =>
      request.type === "prompt.send")[1]?.deliveryId;
    expect(secondDeliveryId).not.toBe(firstDeliveryId);
  });
});
