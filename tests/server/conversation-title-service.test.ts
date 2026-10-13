import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentTurn } from "../../src/shared/contracts";
import {
  conversationTitleSources,
  createConversationTitleService,
  type ConversationTitleServiceDependencies,
} from "../../src/server/runtime/conversation-title-service";

const generateCodexThreadTitle = vi.hoisted(() => vi.fn());
vi.mock("../../src/server/codex/thread-title", () => ({ generateCodexThreadTitle }));

const conversationId = "11111111-1111-4111-8111-111111111111";
const firstMessageId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const firstPrompt = "Fix the login redirect loop\nIt happens after sign in.";

function turn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    conversationId,
    providerId: "codex",
    userMessageId: firstMessageId,
    model: "gpt-test",
    providerSessionAfter: null,
    modelSelection: {},
    ...overrides,
  } as AgentTurn;
}

async function settled(): Promise<void> {
  for (let step = 0; step < 12; step += 1) await Promise.resolve();
}

function fixture(overrides: Partial<ConversationTitleServiceDependencies> = {}) {
  const state = {
    title: "Fix the login redirect loop",
    archivedAt: null as string | null,
    providerSessionId: null as string | null,
  };
  const operations: Array<Promise<void>> = [];
  const abort = new AbortController();
  const dependencies: ConversationTitleServiceDependencies = {
    conversation: vi.fn(() => ({ ...state })),
    firstUserMessage: vi.fn(() => ({ id: firstMessageId, content: firstPrompt })),
    updateTitle: vi.fn((_id: string, title: string) => {
      state.title = title;
    }),
    sources: {
      claude: vi.fn(async () => undefined),
      codex: vi.fn(async () => "\"Login redirect loop.\""),
    },
    isExternalTurn: vi.fn(() => false),
    track: vi.fn((operation: () => Promise<void>) => {
      const tracked = operation();
      operations.push(tracked);
      return tracked;
    }),
    signal: abort.signal,
    ...overrides,
  };
  return {
    state,
    abort,
    operations,
    dependencies,
    service: createConversationTitleService(dependencies),
  };
}

describe("conversation title service", () => {
  it("generates a Codex title once from the first turn and normalizes it", async () => {
    const subject = fixture();
    subject.service.onTurnSettled(turn(), { providerSessionTitle: null });
    await settled();
    expect(subject.dependencies.sources.codex).toHaveBeenCalledWith({
      conversationId,
      model: "gpt-test",
      prompt: firstPrompt,
      signal: subject.abort.signal,
    });
    expect(subject.dependencies.updateTitle).toHaveBeenCalledWith(conversationId, "Login redirect loop");
    expect(subject.dependencies.track).toHaveBeenCalledOnce();

    subject.state.title = "Fix the login redirect loop";
    subject.service.onTurnSettled(turn(), { providerSessionTitle: null });
    await settled();
    expect(subject.dependencies.sources.codex).toHaveBeenCalledOnce();
  });

  it("caps the Codex prompt and replaces an untitled placeholder", async () => {
    const content = "```\ncode only\n```" + "x".repeat(5_000);
    const subject = fixture({
      firstUserMessage: vi.fn(() => ({ id: firstMessageId, content })),
    });
    subject.state.title = "New chat";
    subject.service.onTurnSettled(turn(), { providerSessionTitle: null });
    await settled();
    expect(subject.dependencies.sources.codex).toHaveBeenCalledWith(expect.objectContaining({
      prompt: content.slice(0, 4_000),
    }));
    expect(subject.state.title).toBe("Login redirect loop");
  });

  it("lets a rename made during generation win", async () => {
    let finish!: (title: string) => void;
    const subject = fixture();
    vi.mocked(subject.dependencies.sources.codex).mockImplementation(() =>
      new Promise((resolve) => { finish = resolve; }));
    subject.service.onTurnSettled(turn(), { providerSessionTitle: null });
    await settled();
    subject.state.title = "My own name";
    finish("Login redirect loop");
    await settled();
    expect(subject.dependencies.updateTitle).not.toHaveBeenCalled();
  });

  it.each([
    ["an archived chat", (subject: ReturnType<typeof fixture>) => { subject.state.archivedAt = "2030-01-01T00:00:00.000Z"; }],
    ["a renamed chat", (subject: ReturnType<typeof fixture>) => { subject.state.title = "Renamed"; }],
    ["a chat without user text", (subject: ReturnType<typeof fixture>) => {
      vi.mocked(subject.dependencies.firstUserMessage).mockReturnValue(null);
    }],
  ])("never generates for %s", async (_label, prepare) => {
    const subject = fixture();
    prepare(subject);
    subject.service.onTurnSettled(turn(), { providerSessionTitle: "OpenCode title" });
    await settled();
    expect(subject.dependencies.sources.codex).not.toHaveBeenCalled();
    expect(subject.dependencies.updateTitle).not.toHaveBeenCalled();
  });

  it.each([
    ["a later turn", turn({ userMessageId: "44444444-4444-4444-8444-444444444444" })],
    ["a provider without generated titles", turn({ providerId: "cursor" })],
  ])("does not generate a Codex title for %s", async (_label, settledTurn) => {
    const subject = fixture();
    subject.service.onTurnSettled(settledTurn, { providerSessionTitle: null });
    await settled();
    expect(subject.dependencies.sources.codex).not.toHaveBeenCalled();
    expect(subject.dependencies.track).not.toHaveBeenCalled();
  });

  it("generates a Codex title without a model when the chat uses the provider default", async () => {
    const subject = fixture();
    subject.service.onTurnSettled(turn({ model: "provider-default" }), { providerSessionTitle: null });
    await settled();
    expect(subject.dependencies.sources.codex).toHaveBeenCalledOnce();
    expect(vi.mocked(subject.dependencies.sources.codex).mock.calls[0]![0]).not.toHaveProperty("model");
    expect(subject.state.title).toBe("Login redirect loop");
  });

  it("does not generate a Codex title for an external backend turn", async () => {
    const subject = fixture({ isExternalTurn: vi.fn(() => true) });
    subject.service.onTurnSettled(turn(), { providerSessionTitle: null });
    await settled();
    expect(subject.dependencies.sources.codex).not.toHaveBeenCalled();
  });

  it("starts no second generation while one is pending", async () => {
    let finish!: (title: string) => void;
    const subject = fixture();
    vi.mocked(subject.dependencies.sources.codex).mockImplementation(() =>
      new Promise((resolve) => { finish = resolve; }));
    subject.service.onTurnSettled(turn(), { providerSessionTitle: null });
    subject.service.onTurnSettled(turn({ providerId: "opencode" }), { providerSessionTitle: "OpenCode title" });
    await settled();
    expect(subject.dependencies.track).toHaveBeenCalledOnce();
    finish("Login redirect loop");
    await settled();
    expect(subject.state.title).toBe("Login redirect loop");
  });

  it("re-reads Claude's session title at later settles until one is applied", async () => {
    const subject = fixture();
    const claude = vi.mocked(subject.dependencies.sources.claude);
    claude.mockResolvedValueOnce(undefined).mockResolvedValueOnce("Login redirect investigation");
    subject.service.onTurnSettled(turn({ providerId: "claude", providerSessionAfter: sessionId }), { providerSessionTitle: null });
    await settled();
    expect(subject.dependencies.updateTitle).not.toHaveBeenCalled();
    subject.service.onTurnSettled(turn({
      providerId: "claude",
      providerSessionAfter: sessionId,
      userMessageId: "44444444-4444-4444-8444-444444444444",
    }), { providerSessionTitle: null });
    await settled();
    expect(claude).toHaveBeenNthCalledWith(2, { conversationId, sessionId });
    expect(subject.state.title).toBe("Login redirect investigation");
    subject.state.title = "Fix the login redirect loop";
    subject.service.onTurnSettled(turn({ providerId: "claude", providerSessionAfter: sessionId }), { providerSessionTitle: null });
    await settled();
    expect(claude).toHaveBeenCalledTimes(2);
    expect(subject.dependencies.sources.codex).not.toHaveBeenCalled();
  });

  it("falls back to the chat's stored Claude session", async () => {
    const subject = fixture();
    subject.state.providerSessionId = sessionId;
    subject.service.onTurnSettled(turn({ providerId: "claude" }), { providerSessionTitle: null });
    await settled();
    expect(subject.dependencies.sources.claude).toHaveBeenCalledWith({ conversationId, sessionId });
  });

  it("applies a provider session title from any settle while the guard holds", async () => {
    const subject = fixture();
    subject.service.onTurnSettled(turn({ providerId: "opencode" }), { providerSessionTitle: null });
    await settled();
    expect(subject.dependencies.track).not.toHaveBeenCalled();
    subject.service.onTurnSettled(turn({
      providerId: "opencode",
      userMessageId: "44444444-4444-4444-8444-444444444444",
    }), { providerSessionTitle: "  Login redirect loop  " });
    await settled();
    expect(subject.state.title).toBe("Login redirect loop");
  });

  it("rejects a generic generated title", async () => {
    const subject = fixture();
    vi.mocked(subject.dependencies.sources.codex).mockResolvedValue("New chat");
    subject.service.onTurnSettled(turn(), { providerSessionTitle: null });
    await settled();
    expect(subject.dependencies.updateTitle).not.toHaveBeenCalled();
  });

  it("contains provider, store and shutdown failures", async () => {
    const failing = fixture();
    vi.mocked(failing.dependencies.sources.codex).mockRejectedValue(new Error("provider down"));
    failing.service.onTurnSettled(turn(), { providerSessionTitle: null });
    await settled();
    expect(failing.dependencies.updateTitle).not.toHaveBeenCalled();

    const deleted = fixture();
    vi.mocked(deleted.dependencies.conversation).mockImplementation(() => {
      throw new Error("Conversation not found.");
    });
    expect(() => deleted.service.onTurnSettled(turn(), { providerSessionTitle: null })).not.toThrow();

    const closed = fixture({
      track: vi.fn(() => Promise.reject(new Error("The runtime is shutting down."))),
    });
    expect(() => closed.service.onTurnSettled(turn(), { providerSessionTitle: null })).not.toThrow();
    await settled();
    expect(closed.dependencies.sources.codex).not.toHaveBeenCalled();

    let finish!: (title: string) => void;
    const aborted = fixture();
    vi.mocked(aborted.dependencies.sources.codex).mockImplementation(() =>
      new Promise((resolve) => { finish = resolve; }));
    aborted.service.onTurnSettled(turn(), { providerSessionTitle: null });
    await settled();
    aborted.abort.abort();
    finish("Login redirect loop");
    await settled();
    expect(aborted.dependencies.updateTitle).not.toHaveBeenCalled();
  });
});

describe("conversation title sources", () => {
  const roots: string[] = [];
  const configDirectory = process.env.CLAUDE_CONFIG_DIR;

  afterEach(() => {
    if (configDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = configDirectory;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    generateCodexThreadTitle.mockReset();
  });

  function claudeFixture(lines: readonly Record<string, unknown>[]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "inertia-title-source-")));
    roots.push(root);
    const workspace = join(root, "workspace");
    const projects = join(root, "config", "projects", workspace.replace(/[^a-zA-Z0-9]/gu, "-"));
    mkdirSync(workspace);
    mkdirSync(projects, { recursive: true });
    writeFileSync(
      join(projects, `${sessionId}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    process.env.CLAUDE_CONFIG_DIR = join(root, "config");
    return conversationTitleSources({
      store: {
        assertConversationProvider: vi.fn(),
        conversationPath: vi.fn(() => workspace),
        cliConversationImport: vi.fn(() => null),
      },
      providers: { codexControlContext: vi.fn(), claudeSkills: vi.fn() },
    });
  }

  const userLine = {
    type: "user",
    uuid: "55555555-5555-4555-8555-555555555555",
    parentUuid: null,
    sessionId,
    timestamp: "2030-01-01T00:00:00.000Z",
    message: { role: "user", content: "Fix the login redirect loop" },
  };

  it("reads Claude's generated session title from the chat's working directory", async () => {
    const sources = claudeFixture([
      userLine,
      { type: "ai-title", aiTitle: "Login redirect investigation", sessionId },
    ]);
    await expect(sources.claude({ conversationId, sessionId }))
      .resolves.toBe("Login redirect investigation");
  });

  it("returns nothing before Claude has written a title", async () => {
    const sources = claudeFixture([userLine]);
    await expect(sources.claude({ conversationId, sessionId })).resolves.toBeUndefined();
  });

  it("generates a Codex title through the chat's control context", async () => {
    const abandonBeforeSpawn = vi.fn(() => true);
    const installationUse = { accept: vi.fn(), abandonBeforeSpawn };
    const codexControlContext = vi.fn(async (cwd: string) => ({
      executable: "/bin/codex",
      environment: { PATH: "/bin" },
      cwd,
      installationUse,
    }));
    generateCodexThreadTitle.mockResolvedValue("Login redirect loop");
    const signal = new AbortController().signal;
    const assertConversationProvider = vi.fn();
    const sources = conversationTitleSources({
      store: {
        assertConversationProvider,
        conversationPath: vi.fn(() => "/workspace/chat"),
        cliConversationImport: vi.fn(() => null),
      },
      providers: { codexControlContext, claudeSkills: vi.fn() },
    });
    await expect(sources.codex({ conversationId, model: "gpt-test", prompt: firstPrompt, signal }))
      .resolves.toBe("Login redirect loop");
    expect(assertConversationProvider).toHaveBeenCalledWith(conversationId, "codex");
    expect(codexControlContext).toHaveBeenCalledWith("/workspace/chat");
    expect(generateCodexThreadTitle).toHaveBeenCalledWith({
      executable: "/bin/codex",
      environment: { PATH: "/bin" },
      cwd: "/workspace/chat",
      installationUse,
      model: "gpt-test",
      prompt: firstPrompt,
      signal,
    });
    expect(abandonBeforeSpawn).toHaveBeenCalledOnce();

    assertConversationProvider.mockImplementation(() => {
      throw new Error("This chat now uses another provider.");
    });
    await expect(sources.codex({ conversationId, model: "gpt-test", prompt: firstPrompt, signal }))
      .rejects.toThrow("another provider");
    expect(generateCodexThreadTitle).toHaveBeenCalledOnce();
  });
});
