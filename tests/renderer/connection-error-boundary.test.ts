import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { defaultSettings } from "../../src/shared/contracts";

import {
  decodeServerEventMessage,
  deliverDecodedServerEvent,
  notifyConnectionListeners,
  runtimeCommandDelivery,
  settlePendingConnectionRequest,
  UNREADABLE_RUNTIME_RESPONSE,
  type PendingConnectionRequest,
} from "../../src/renderer/src/utils/connectionMessages";

const runtimeActionsSource = readFileSync(
  new URL(
    "../../src/renderer/src/hooks/useAppRuntimeActions.ts",
    import.meta.url,
  ),
  "utf8",
).replace(/\r\n?/gu, "\n");
const workspaceToolsSource = readFileSync(
  new URL("../../src/renderer/src/hooks/workspace-tools/useWorkspaceFiles.ts", import.meta.url),
  "utf8",
).replace(/\r\n?/gu, "\n");
const workspaceGitSource = readFileSync(
  new URL("../../src/renderer/src/hooks/workspace-tools/useWorkspaceGit.ts", import.meta.url),
  "utf8",
).replace(/\r\n?/gu, "\n");
const readyProvider = {
  id: "codex",
  label: "Codex",
  command: "codex",
  available: true,
  version: "1.0.0",
  executable: "/opt/bin/codex",
  installState: "installed",
  authState: "authenticated",
  canRun: true,
  statusMessage: "Connected",
  models: [],
  rateLimits: [],
  metadataState: {
    models: {
      freshness: "fresh",
      provenance: "provider",
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
    rateLimits: {
      freshness: "fresh",
      provenance: "provider",
      updatedAt: null,
      lastAttemptedAt: null,
      refreshing: false,
    },
  },
} as const;

describe("renderer error visibility boundary", () => {
  it("keeps a first-send request failure command-scoped while malformed transport data becomes global", async () => {
    const pending = new Map();
    let commandError: Error | null = null;
    let connectionError: string | null = null;
    let clearedTimeout: number | null = null;
    pending.set("first-send", {
      resolve: () => undefined,
      reject: (error: Error) => {
        commandError = error;
      },
      timeout: 42,
      timeoutDelivery: "rejected",
    });
    const receive = async (data: unknown): Promise<void> => {
      try {
        const event = await decodeServerEventMessage(data);
        settlePendingConnectionRequest(event, pending, (timeout) => {
          clearedTimeout = timeout;
        });
      } catch {
        connectionError = UNREADABLE_RUNTIME_RESPONSE;
      }
    };

    await receive(JSON.stringify({
      type: "request.error",
      requestId: "first-send",
      message: "The first message could not be sent.",
    }));

    expect(commandError).toMatchObject({
      message: "The first message could not be sent.",
    });
    expect(runtimeCommandDelivery(commandError)).toBe("rejected");
    expect(connectionError).toBeNull();
    expect(clearedTimeout).toBe(42);
    expect(pending.size).toBe(0);

    await receive("{malformed transport frame");
    expect(connectionError).toBe(UNREADABLE_RUNTIME_RESPONSE);
  });

  it("does not mislabel valid runtime data when a projection listener throws", async () => {
    const unreadable = vi.fn();
    const projectionError = new Error("projection failed");
    const deliver = () => deliverDecodedServerEvent(
      JSON.stringify({ type: "request.ok", requestId: "valid" }),
      (event) => {
        notifyConnectionListeners(event, [
          () => { throw projectionError; },
        ], (error) => { throw error; });
      },
      unreadable,
    );

    await expect(deliver).rejects.toBe(projectionError);
    expect(unreadable).not.toHaveBeenCalled();
  });

  it.each([
    { type: "snapshot.updated", snapshot: {} },
    { type: "runtime.cursor", sync: {} },
    { type: "runtime.cursor", sync: { runtimeGeneration: "", latestSequence: 0 } },
    { type: "request.error", requestId: "known" },
    { type: "request.result", requestId: "known", result: { kind: "message.accepted" } },
    {
      type: "request.result",
      requestId: "known",
      result: {
        kind: "agent.workflow",
        workflow: { conversationId: "conversation", skills: [{}] },
      },
    },
    {
      type: "snapshot.updated",
      snapshot: {
        projects: [],
        conversations: [],
        runs: [],
        providers: [{ id: "codex" }],
        settings: {},
        activeProjectId: null,
        activeConversationId: null,
      },
    },
    {
      type: "snapshot.updated",
      snapshot: {
        projects: [],
        conversations: [],
        runs: [],
        providers: [{
          ...readyProvider,
          models: [{ id: "malformed-model" }],
        }],
        settings: defaultSettings,
        activeProjectId: null,
        activeConversationId: null,
      },
    },
    {
      type: "terminal.created",
      requestId: "known",
      terminalId: "terminal",
      providerResume: {},
    },
    {
      type: "terminal.created",
      requestId: "known",
      terminalId: "terminal",
      providerResume: {
        providerId: "codex",
        sessionId: "session-1",
      },
    },
    { type: "terminal.output", terminalId: "terminal" },
    { type: "agent.text", conversationId: "conversation", runId: "run", turnId: "turn", text: 7 },
    { type: "agent.usage", usage: {} },
    { type: "agent.activity", activity: null },
    { type: "agent.subagent.updated", trace: {} },
    { type: "agent.approval.requested", request: null },
    { type: "agent.input.requested", request: { questions: [] } },
    {
      type: "agent.plan.updated",
      plan: {
        conversationId: "conversation",
        runId: "run",
        turnId: null,
        explanation: null,
        steps: [{ step: "Broken", status: "unknown" }],
      },
    },
    { type: "unknown.event" },
  ])("rejects malformed known and unknown runtime events", async (event) => {
    await expect(decodeServerEventMessage(JSON.stringify(event)))
      .rejects.toThrow("Malformed server event");
  });

  it("accepts legacy plans with a null turn identity", async () => {
    await expect(decodeServerEventMessage(JSON.stringify({
      type: "agent.plan.updated",
      plan: {
        conversationId: "conversation",
        runId: "run",
        turnId: null,
        explanation: null,
        steps: [],
      },
    }))).resolves.toMatchObject({ type: "agent.plan.updated" });
  });

  it("accepts a complete bounded provider terminal resume identity", async () => {
    await expect(decodeServerEventMessage(JSON.stringify({
      type: "terminal.created",
      requestId: "known",
      terminalId: "terminal",
      providerResume: {
        providerId: "codex",
        providerLabel: "Codex",
        sessionId: "session-1",
      },
      providerResumeConversationId: "11111111-1111-4111-8111-111111111111",
    }))).resolves.toMatchObject({ type: "terminal.created" });
  });

  it("accepts complete provider and workflow projections", async () => {
    await expect(decodeServerEventMessage(JSON.stringify({
      type: "snapshot.updated",
      snapshot: {
        projects: [],
        conversations: [],
        runs: [],
        providers: [readyProvider],
        settings: defaultSettings,
        activeProjectId: null,
        activeConversationId: null,
      },
    }))).resolves.toMatchObject({ type: "snapshot.updated" });
    await expect(decodeServerEventMessage(JSON.stringify({
      type: "request.result",
      requestId: "known",
      result: {
        kind: "agent.workflow",
        workflow: {
          conversationId: "conversation",
          goals: [],
          goalCapability: {
            kind: "codex-native",
            available: true,
            label: "Codex native goal",
          },
          skills: [],
          skillsCapability: {
            kind: "codex-native",
            available: true,
            label: "Codex skills",
          },
          goalRefreshWarning: null,
          skillDiscovery: {
            truncated: false,
            warningCount: 0,
            synchronizedAt: null,
          },
          refreshedAt: "2030-01-01T00:00:00.000Z",
        },
      },
    }))).resolves.toMatchObject({ type: "request.result" });
  });

  it("distinguishes late Git results awaiting or preceded by durable publication", () => {
    const settle = (authoritativePublicationReceived: boolean) => {
      const pending = new Map<string, PendingConnectionRequest>([["late", {
        resolve: () => undefined,
        reject: () => undefined,
        timeout: 42,
        timedOut: true,
        authoritativePublicationReceived,
        awaitsWorkspaceGitPublication: true,
        timeoutDelivery: "ambiguous",
      }]]);
      return settlePendingConnectionRequest({
        type: "request.ok",
        requestId: "late",
      }, pending, () => undefined);
    };

    expect(settle(false)).toBe("late-awaiting-publication");
    expect(settle(true)).toBe("late-published");
  });

  it("keeps file hydration local while surfacing an initial Git refresh failure", () => {
    const hydrationMarker = workspaceToolsSource.indexOf(
      "void loadActions();",
    );
    const hydrationStart = workspaceToolsSource.lastIndexOf(
      "useEffect(() => {",
      hydrationMarker,
    );
    const hydrationEnd = workspaceToolsSource.indexOf(
      "\n\n  const selectWorkspaceFile",
      hydrationStart,
    );
    const hydration = workspaceToolsSource.slice(hydrationStart, hydrationEnd);

    expect(hydrationStart).toBeGreaterThan(-1);
    expect(hydration).not.toContain("setActionError(");
    expect(hydration).toContain("void loadFiles().catch(() => {");
    expect(hydration).toContain(
      "automaticallyLoadedAuthorityRef.current = null;",
    );
    expect(workspaceGitSource).toMatch(
      /void loadGit\(\{[\s\S]*?scope: loadWorkspaceOnMount[\s\S]*?\}\)\.catch\(\(error\) => \{[\s\S]*?if \(!cancelled\) \{[\s\S]*?setActionError\(/,
    );
    expect(workspaceGitSource).toContain(
      'error instanceof Error && error.message.trim()',
    );
    expect(workspaceGitSource).toContain(
      '"Git changes could not be loaded."',
    );
    expect(workspaceToolsSource).toContain(
      "setFilesError(",
    );
    expect(workspaceToolsSource).toContain('"Files could not be loaded."');
  });

  it("still promotes explicitly invoked action failures to the user-facing toast", () => {
    const runStart = runtimeActionsSource.indexOf("const run = useCallback");
    const runEnd = runtimeActionsSource.indexOf(
      "const openProjectPath = useCallback",
      runStart,
    );
    const run = runtimeActionsSource.slice(runStart, runEnd);

    expect(run).toContain("setActionError(null)");
    expect(run).toMatch(
      /setActionError\(\s*error instanceof Error\s*\?\s*error\.message\s*:\s*"That action could not be completed\.",?\s*\)/u,
    );
  });
});
