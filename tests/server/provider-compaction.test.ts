import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  AgentHarnessRegistry,
  ProviderManager,
} from "../../src/server/providers";
import {
  createCodexAppServerHarness,
  type CodexAppServerHarnessDependencies,
} from "../../src/server/provider/codex-app-server-harness";
import {
  type CodexControlClientOptions,
  withCodexControlClient,
} from "../../src/server/codex/control-client";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  portableFixtureRoot,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";
import {
  CLAUDE_PROTOCOL_SESSION_ID,
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import {
  continuationIdentityForSelection,
  withModelSelectionFastMode,
} from "../../src/shared/model-routing";
import { nativeProviderRunInput } from "./model-route-fixture";

const COMPACTION_PHASE_TRACE_LIMIT = 32;
const COMPACTION_PHASE_DEADLINE_MS = 20_000;

function emitCodexCompactionLifecycle(
  notify: NonNullable<CodexControlClientOptions["onNotification"]>,
  input: {
    includeTurnCompletion?: boolean;
    itemId: string;
    status?: "completed" | "failed" | "interrupted";
    threadId: string;
    turnId: string;
  },
): void {
  notify("turn/started", {
    threadId: input.threadId,
    turn: {
      id: input.turnId,
      status: "inProgress",
      items: [],
      error: null,
    },
  });
  notify("item/started", {
    threadId: input.threadId,
    turnId: input.turnId,
    startedAtMs: 1,
    item: { id: input.itemId, type: "contextCompaction" },
  });
  notify("item/completed", {
    threadId: input.threadId,
    turnId: input.turnId,
    completedAtMs: 2,
    item: { id: input.itemId, type: "contextCompaction" },
  });
  if (input.includeTurnCompletion === false) return;
  notify("turn/completed", {
    threadId: input.threadId,
    turn: {
      id: input.turnId,
      status: input.status ?? "completed",
      items: [],
      error: null,
    },
  });
}

function capturedRequestMethods(capturePath: string): string[] {
  try {
    return readFileSync(capturePath, "utf8").trim().split("\n")
      .slice(0, COMPACTION_PHASE_TRACE_LIMIT)
      .map((line) => {
        const message = JSON.parse(line) as { method?: unknown };
        return typeof message.method === "string" ? message.method : "unknown";
      });
  } catch {
    return [];
  }
}

function createCodexCompactionPhaseTrace(): {
  describe: () => string;
  withControlClient: NonNullable<
    CodexAppServerHarnessDependencies["withControlClient"]
  >;
} {
  const startedAt = Date.now();
  const phases: string[] = [];
  const record = (phase: string, details?: Record<string, unknown>): void => {
    if (phases.length >= COMPACTION_PHASE_TRACE_LIMIT) return;
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    phases.push(`${Date.now() - startedAt}ms ${phase}${suffix}`);
  };
  const withControlClient: NonNullable<
    CodexAppServerHarnessDependencies["withControlClient"]
  > = async (options, runWithClient) => {
    record("control:spawn");
    try {
      return await withCodexControlClient({
        ...options,
        onNotification: (method, params) => {
          const item = params.item && typeof params.item === "object"
            ? params.item as { id?: unknown; type?: unknown }
            : undefined;
          const turn = params.turn && typeof params.turn === "object"
            ? params.turn as { id?: unknown; status?: unknown }
            : undefined;
          record(`notification:${method}`, {
            completedAtMs: params.completedAtMs,
            itemId: item?.id,
            itemType: item?.type,
            startedAtMs: params.startedAtMs,
            threadId: params.threadId,
            turnId: params.turnId ?? turn?.id,
            turnStatus: turn?.status,
          });
          options.onNotification?.(method, params);
        },
      }, async (client) => {
        // withCodexControlClient invokes this callback only after initialize
        // has been admitted by the child.
        record("initialize:admitted");
        try {
          return await runWithClient({
            request: async (method, params = {}) => {
              record(`request:${method}:write`);
              try {
                const response = await client.request(method, params);
                record(`request:${method}:admitted`);
                return response;
              } catch (error) {
                record(`request:${method}:rejected`, {
                  message: error instanceof Error
                    ? error.message.slice(0, 160)
                    : "unknown",
                });
                throw error;
              }
            },
          });
        } finally {
          record("operation:settled");
        }
      });
    } finally {
      record("cleanup:closed");
    }
  };
  return {
    describe: () => phases.join(" | "),
    withControlClient,
  };
}

async function withCompactionPhaseDeadline<T>(
  operation: Promise<T>,
  trace: ReturnType<typeof createCodexCompactionPhaseTrace>,
  capturePath: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          `Codex compaction phase deadline exceeded. phases=[${trace.describe()}] inbound=[${capturedRequestMethods(capturePath).join(",")}]`,
        )), COMPACTION_PHASE_DEADLINE_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function codexCompactionTierAgent(
  root: string,
  capturePath: string,
  attestedTier: "echo" | "priority" | "default" | null,
): string {
  const command = process.execPath;
  writeNodeSubcommand(root, "app-server", `
const fs = require("node:fs");
const readline = require("node:readline");
const capture = (value) => fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(value) + "\\n");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  capture(message);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId }, serviceTier: ${attestedTier === "echo" ? "message.params.serviceTier" : JSON.stringify(attestedTier)}, initialTurnsPage: { data: [{ id: "previous-turn" }] } } });
  if (message.method === "thread/compact/start") {
    const lifecycleAtMs = Date.now() - 1000;
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "compact-tier-turn", status: "inProgress", items: [], error: null } } });
    send({ method: "item/started", params: { threadId: message.params.threadId, turnId: "compact-tier-turn", startedAtMs: lifecycleAtMs, item: { id: "compact-tier-item", type: "contextCompaction" } } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: "compact-tier-turn", completedAtMs: lifecycleAtMs, item: { id: "compact-tier-item", type: "contextCompaction" } } });
    return send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "compact-tier-turn", status: "completed", items: [], error: null } } });
  }
  if (message.method === "thread/turns/list") return send({ id: message.id, result: { data: [{ id: "later-turn" }, { id: "compact-tier-turn" }, { id: "previous-turn" }] } });
});
`);
  return command;
}

describe.sequential("provider compaction adapters", () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];
  const trackManager = (manager: ProviderManager): ProviderManager => {
    managers.push(manager);
    return manager;
  };
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  it("accepts pre-response Codex lifecycle from a trailing provider clock", async () => {
    // The control client's process and JSON-lines transport have their own
    // focused coverage. Keep this adapter proof in-process so Windows endpoint
    // inspection cannot stall a second short-lived Node launch in the same job.
    const requests: string[] = [];
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        requests.push(method);
        if (method === "thread/resume") {
          return {
            thread: { id: params.threadId },
            initialTurnsPage: { data: [{ id: "previous-turn" }] },
          };
        }
        if (method === "thread/turns/list") {
          return {
            data: [{ id: "compact-turn-1" }, { id: "previous-turn" }],
          };
        }
        if (method !== "thread/compact/start") {
          throw new Error(`Unexpected control request: ${method}`);
        }
        const lifecycleAtMs = Date.now() - 1_000;
        options.onNotification?.("turn/started", {
          threadId: params.threadId,
          turn: {
            id: "compact-turn-1",
            status: "inProgress",
            items: [],
            error: null,
          },
        });
        options.onNotification?.("item/started", {
          threadId: params.threadId,
          turnId: "compact-turn-1",
          startedAtMs: lifecycleAtMs,
          item: { id: "compact-1", type: "contextCompaction" },
        });
        options.onNotification?.("item/completed", {
          threadId: params.threadId,
          turnId: "compact-turn-1",
          completedAtMs: lifecycleAtMs,
          item: { id: "compact-1", type: "contextCompaction" },
        });
        options.onNotification?.("turn/completed", {
          threadId: params.threadId,
          turn: {
            id: "compact-turn-1",
            status: "completed",
            items: [],
            error: null,
          },
        });
        return {};
      },
    });
    const manager = trackManager(
      new ProviderManager(
        { commands: { codex: process.execPath } },
        new AgentHarnessRegistry([
          createCodexAppServerHarness({ withControlClient }),
        ]),
      ),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }), "remember retrieval exactly")).resolves.toMatchObject({
      status: "completed",
      instructionForwarded: false,
      message: expect.stringContaining("was not forwarded"),
    });
    expect(requests).toEqual([
      "thread/resume",
      "thread/compact/start",
      "thread/turns/list",
    ]);
  });

  it("does not let queued pre-response lifecycle override RPC rejection", async () => {
    const requests: string[] = [];
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        requests.push(method);
        if (method === "thread/resume") {
          return {
            thread: { id: params.threadId },
            initialTurnsPage: { data: [{ id: "previous-turn" }] },
          };
        }
        if (method === "thread/compact/start") {
          if (!options.onNotification) throw new Error("Missing notifications.");
          emitCodexCompactionLifecycle(options.onNotification, {
            itemId: "compact-before-rejection",
            threadId: "thread-existing",
            turnId: "compact-turn-before-rejection",
          });
          throw new Error("Fixture rejected thread/compact/start.");
        }
        throw new Error(`Unexpected control request: ${method}`);
      },
    });
    const manager = trackManager(new ProviderManager(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([
        createCodexAppServerHarness({ withControlClient }),
      ]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-rpc-rejection",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: "Fixture rejected thread/compact/start.",
    });
    expect(requests).toEqual(["thread/resume", "thread/compact/start"]);
  });

  it("fails closed when Codex omits the bounded initial turn page", async () => {
    const requests: string[] = [];
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (_options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        requests.push(method);
        if (method === "thread/resume") {
          return { thread: { id: params.threadId } };
        }
        throw new Error(`Unexpected control request: ${method}`);
      },
    });
    const manager = trackManager(
      new ProviderManager(
        { commands: { codex: process.execPath } },
        new AgentHarnessRegistry([
          createCodexAppServerHarness({ withControlClient }),
        ]),
      ),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-missing-initial-turns",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("invalid initial turn page"),
    });
    expect(requests).toEqual(["thread/resume"]);
  });

  it("accepts an empty baseline only when the candidate is durably present", async () => {
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        if (method === "thread/resume") {
          return {
            thread: { id: params.threadId },
            initialTurnsPage: { data: [] },
          };
        }
        if (method === "thread/compact/start") {
          if (!options.onNotification) throw new Error("Missing notifications.");
          emitCodexCompactionLifecycle(options.onNotification, {
            itemId: "compact-empty-baseline",
            threadId: "thread-existing",
            turnId: "compact-turn-empty-baseline",
          });
          return {};
        }
        if (method === "thread/turns/list") {
          return {
            data: [
              { id: "later-turn" },
              { id: "compact-turn-empty-baseline" },
            ],
          };
        }
        throw new Error(`Unexpected control request: ${method}`);
      },
    });
    const manager = trackManager(new ProviderManager(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([
        createCodexAppServerHarness({ withControlClient }),
      ]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-empty-baseline-success",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({ status: "completed" });
  });

  it("fails closed when an empty baseline candidate is not durable", async () => {
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        if (method === "thread/resume") {
          return {
            thread: { id: params.threadId },
            initialTurnsPage: { data: [] },
          };
        }
        if (method === "thread/compact/start") {
          if (!options.onNotification) throw new Error("Missing notifications.");
          emitCodexCompactionLifecycle(options.onNotification, {
            itemId: "compact-empty-baseline-absent",
            threadId: "thread-existing",
            turnId: "compact-turn-empty-baseline-absent",
          });
          return {};
        }
        if (method === "thread/turns/list") {
          return { data: [{ id: "unrelated-turn" }] };
        }
        throw new Error(`Unexpected control request: ${method}`);
      },
    });
    const manager = trackManager(new ProviderManager(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([
        createCodexAppServerHarness({
          compactionTimeoutMs: 25,
          withControlClient,
        }),
      ]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-empty-baseline-absent",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: "Codex context compaction timed out.",
    });
  });

  it.each([
    [
      "duplicate identities",
      [
        { id: "compact-turn-malformed" },
        { id: "compact-turn-malformed" },
        { id: "previous-turn" },
      ],
      "invalid latest turn identities",
    ],
    [
      "an oversized page",
      Array.from({ length: 34 }, (_, index) => ({
        id: index === 0 ? "compact-turn-malformed" : `turn-${index}`,
      })),
      "invalid latest turn page",
    ],
  ] as const)("fails closed on %s in the latest Codex turn page", async (
    _label,
    data,
    expectedMessage,
  ) => {
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        if (method === "thread/resume") {
          return {
            thread: { id: params.threadId },
            initialTurnsPage: { data: [{ id: "previous-turn" }] },
          };
        }
        if (method === "thread/compact/start") {
          if (!options.onNotification) throw new Error("Missing notifications.");
          emitCodexCompactionLifecycle(options.onNotification, {
            itemId: "compact-malformed-page",
            threadId: "thread-existing",
            turnId: "compact-turn-malformed",
          });
          return {};
        }
        if (method === "thread/turns/list") return { data: [...data] };
        throw new Error(`Unexpected control request: ${method}`);
      },
    });
    const manager = trackManager(new ProviderManager(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([
        createCodexAppServerHarness({ withControlClient }),
      ]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: `codex-compact-malformed-${_label.replaceAll(" ", "-")}`,
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining(expectedMessage),
    });
  });

  it("does not authorize compaction from item completion alone", async () => {
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        if (method === "thread/resume") {
          return {
            thread: { id: params.threadId },
            initialTurnsPage: { data: [{ id: "previous-turn" }] },
          };
        }
        if (method === "thread/compact/start") {
          if (!options.onNotification) throw new Error("Missing notifications.");
          emitCodexCompactionLifecycle(options.onNotification, {
            includeTurnCompletion: false,
            itemId: "compact-item-only",
            threadId: "thread-existing",
            turnId: "compact-turn-item-only",
          });
          return {};
        }
        if (method === "thread/turns/list") {
          return {
            data: [
              { id: "compact-turn-item-only" },
              { id: "previous-turn" },
            ],
          };
        }
        throw new Error(`Unexpected control request: ${method}`);
      },
    });
    const manager = trackManager(new ProviderManager(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([
        createCodexAppServerHarness({
          compactionTimeoutMs: 25,
          withControlClient,
        }),
      ]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-item-only",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: "Codex context compaction timed out.",
    });
  });

  it.each(["failed", "interrupted"] as const)(
    "rejects a durably new Codex compaction turn with %s status",
    async (status) => {
      const withControlClient: NonNullable<
        CodexAppServerHarnessDependencies["withControlClient"]
      > = async (options, runWithClient) => await runWithClient({
        request: async (method, params = {}) => {
          if (method === "thread/resume") {
            return {
              thread: { id: params.threadId },
              initialTurnsPage: { data: [{ id: "previous-turn" }] },
            };
          }
          if (method === "thread/compact/start") {
            if (!options.onNotification) {
              throw new Error("Missing notifications.");
            }
            emitCodexCompactionLifecycle(options.onNotification, {
              itemId: "compact-unsuccessful",
              status,
              threadId: "thread-existing",
              turnId: "compact-turn-unsuccessful",
            });
            return {};
          }
          if (method === "thread/turns/list") {
            return {
              data: [
                { id: "compact-turn-unsuccessful" },
                { id: "previous-turn" },
              ],
            };
          }
          throw new Error(`Unexpected control request: ${method}`);
        },
      });
      const manager = trackManager(new ProviderManager(
        { commands: { codex: process.execPath } },
        new AgentHarnessRegistry([
          createCodexAppServerHarness({ withControlClient }),
        ]),
      ));

      await expect(manager.compact(nativeProviderRunInput({
        providerId: "codex",
        conversationId: `codex-compact-${status}`,
        cwd: process.cwd(),
        prompt: "/compact",
        interactionMode: "build",
        access: "supervised",
        sessionId: "thread-existing",
      }))).resolves.toMatchObject({
        status: "failed",
        message: expect.stringContaining("did not complete successfully"),
      });
    },
  );

  it("fails closed when the captured baseline falls outside the bounded turn suffix", async () => {
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        if (method === "thread/resume") {
          return {
            thread: { id: params.threadId },
            initialTurnsPage: { data: [{ id: "previous-turn" }] },
          };
        }
        if (method === "thread/compact/start") {
          if (!options.onNotification) throw new Error("Missing notifications.");
          emitCodexCompactionLifecycle(options.onNotification, {
            itemId: "compact-bounded",
            threadId: "thread-existing",
            turnId: "compact-turn-bounded",
          });
          return {};
        }
        if (method === "thread/turns/list") {
          return {
            data: [
              { id: "later-turn" },
              { id: "compact-turn-bounded" },
              ...Array.from({ length: 31 }, (_, index) => ({
                id: `other-turn-${index}`,
              })),
            ],
          };
        }
        throw new Error(`Unexpected control request: ${method}`);
      },
    });
    const manager = trackManager(new ProviderManager(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([
        createCodexAppServerHarness({ withControlClient }),
      ]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-baseline-outside-bound",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("captured compaction turn baseline"),
    });
  });

  it.each([
    ["Fast", "priority", "echo"],
    ["Standard", null, "default"],
  ] as const)("accepts response-before lifecycle and attests %s mode", async (
    _label,
    requestedTier,
    attestedTier,
  ) => {
    const root = portableFixtureRoot(`Codex compact ${_label} tier`);
    roots.push(root);
    const capturePath = join(root, "capture.jsonl");
    const command = codexCompactionTierAgent(
      root,
      capturePath,
      attestedTier,
    );
    const phaseTrace = createCodexCompactionPhaseTrace();
    const manager = trackManager(
      new ProviderManager(
        { commands: { codex: command } },
        new AgentHarnessRegistry([
          createCodexAppServerHarness({
            withControlClient: phaseTrace.withControlClient,
          }),
        ]),
      ),
    );
    const base = nativeProviderRunInput({
      providerId: "codex",
      conversationId: `codex-compact-${_label.toLowerCase()}-tier`,
      cwd: root,
      prompt: "/compact",
      model: "model-a",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    });
    const selection = requestedTier === "priority"
      ? withModelSelectionFastMode(base.modelSelection, requestedTier)
      : base.modelSelection;

    await expect(withCompactionPhaseDeadline(manager.compact({
      ...base,
      supportedFastMode: "priority",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        null,
        false,
      ),
    }), phaseTrace, capturePath)).resolves.toMatchObject({ status: "completed" });

    const messages = readFileSync(capturePath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as {
        method: string;
        params?: {
          excludeTurns?: boolean;
          initialTurnsPage?: {
            itemsView: string;
            limit: number;
            sortDirection: string;
          };
          itemsView?: string;
          limit?: number;
          serviceTier?: "priority" | null;
          sortDirection?: string;
        };
      });
    expect(messages.find(({ method }) => method === "thread/resume"))
      .toMatchObject({
        params: {
          excludeTurns: true,
          initialTurnsPage: {
            itemsView: "summary",
            limit: 1,
            sortDirection: "desc",
          },
          serviceTier: requestedTier,
        },
      });
    expect(messages.find(({ method }) => method === "thread/turns/list"))
      .toMatchObject({
        params: {
          itemsView: "summary",
          limit: 33,
          sortDirection: "desc",
        },
      });
  });

  it("rejects Codex compaction when resume attests a different service tier", async () => {
    const root = portableFixtureRoot("Codex compact tier mismatch");
    roots.push(root);
    const command = codexCompactionTierAgent(
      root,
      join(root, "capture.jsonl"),
      null,
    );
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );
    const base = nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-tier-mismatch",
      cwd: root,
      prompt: "/compact",
      model: "model-a",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    });
    const selection = withModelSelectionFastMode(
      base.modelSelection,
      "priority",
    );

    await expect(manager.compact({
      ...base,
      supportedFastMode: "priority",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        null,
        false,
      ),
    })).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("service tier for compaction"),
    });
  });

  it("does not accept a stale Codex lifecycle buffered before requesting compaction", async () => {
    const root = portableFixtureRoot("Codex compact stale lifecycle");
    roots.push(root);
    const command = process.execPath;
    writeNodeSubcommand(root, "app-server", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") {
    const stale = [
      { method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "stale-turn", status: "inProgress", items: [], error: null } } },
      { method: "item/started", params: { threadId: message.params.threadId, turnId: "stale-turn", startedAtMs: 1, item: { id: "compact-stale", type: "contextCompaction" } } },
      { method: "item/completed", params: { threadId: message.params.threadId, turnId: "stale-turn", completedAtMs: 2, item: { id: "compact-stale", type: "contextCompaction" } } },
      { method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "stale-turn", status: "completed", items: [], error: null } } },
      { id: message.id, result: { thread: { id: message.params.threadId }, initialTurnsPage: { data: [{ id: "previous-turn" }] } } },
    ];
    return process.stdout.write(stale.map(JSON.stringify).join("\\n") + "\\n");
  }
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    return setImmediate(() => send({ id: 9999, method: "fixture/reject-invalid-compaction" }));
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-stale-lifecycle",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("unexpected server request"),
    });
  });

  it.each([
    ["latest baseline", "previous-turn"],
    ["older history", "older-turn"],
  ])("discards a delayed %s lifecycle and accepts the real compact turn", async (
    _label,
    staleTurnId,
  ) => {
    const root = portableFixtureRoot(`Codex compact delayed ${_label} lifecycle`);
    roots.push(root);
    const command = process.execPath;
    writeNodeSubcommand(root, "app-server", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let durableTurnIds = ${JSON.stringify(
    staleTurnId === "previous-turn"
      ? ["previous-turn"]
      : ["previous-turn", staleTurnId],
  )};
let turnListRequests = 0;
const lifecycle = (turnId, itemId) => [
  { method: "turn/started", params: { threadId: "thread-existing", turn: { id: turnId, status: "inProgress", items: [], error: null } } },
  { method: "item/started", params: { threadId: "thread-existing", turnId, startedAtMs: 1, item: { id: itemId, type: "contextCompaction" } } },
  { method: "item/completed", params: { threadId: "thread-existing", turnId, completedAtMs: 2, item: { id: itemId, type: "contextCompaction" } } },
  { method: "turn/completed", params: { threadId: "thread-existing", turn: { id: turnId, status: "completed", items: [], error: null } } },
];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId }, initialTurnsPage: { data: [{ id: "previous-turn" }] } } });
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    return setImmediate(() => process.stdout.write(
      lifecycle(${JSON.stringify(staleTurnId)}, "compact-stale")
        .map(JSON.stringify).join("\\n") + "\\n",
    ));
  }
  if (message.method === "thread/turns/list") {
    turnListRequests += 1;
    send({ id: message.id, result: { data: durableTurnIds.map((id) => ({ id })) } });
    if (turnListRequests === 1) {
      return setImmediate(() => {
        durableTurnIds = ["compact-turn-real", ...durableTurnIds];
        process.stdout.write(
          lifecycle("compact-turn-real", "compact-real")
            .map(JSON.stringify).join("\\n") + "\\n",
        );
      });
    }
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-delayed-stale-lifecycle",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({ status: "completed" });
  });

  it("fails closed when Codex exceeds the bounded lifecycle candidate queue", async () => {
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        if (method === "thread/resume") {
          return {
            thread: { id: params.threadId },
            initialTurnsPage: { data: [{ id: "previous-turn" }] },
          };
        }
        if (method === "thread/compact/start") {
          for (let index = 0; index < 33; index += 1) {
            const turnId = `candidate-${index}`;
            const itemId = `compact-${index}`;
            options.onNotification?.("turn/started", {
              threadId: params.threadId,
              turn: {
                id: turnId,
                status: "inProgress",
                items: [],
                error: null,
              },
            });
            options.onNotification?.("item/started", {
              threadId: params.threadId,
              turnId,
              startedAtMs: index,
              item: { id: itemId, type: "contextCompaction" },
            });
            options.onNotification?.("item/completed", {
              threadId: params.threadId,
              turnId,
              completedAtMs: index,
              item: { id: itemId, type: "contextCompaction" },
            });
            options.onNotification?.("turn/completed", {
              threadId: params.threadId,
              turn: {
                id: turnId,
                status: "completed",
                items: [],
                error: null,
              },
            });
          }
          return {};
        }
        throw new Error(`Unexpected control request: ${method}`);
      },
    });
    const manager = trackManager(new ProviderManager(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([
        createCodexAppServerHarness({ withControlClient }),
      ]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-candidate-overflow",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("too many lifecycle candidates"),
    });
  });

  it("applies the lifecycle candidate cap across paced durable checks", async () => {
    let emittedCandidates = 0;
    let turnListRequests = 0;
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => {
      const notify = options.onNotification;
      if (!notify) throw new Error("Missing notifications.");
      const emitNextCandidate = (): void => {
        const index = emittedCandidates;
        emittedCandidates += 1;
        emitCodexCompactionLifecycle(notify, {
          itemId: `compact-drip-${index}`,
          threadId: "thread-existing",
          turnId: `candidate-drip-${index}`,
        });
      };
      return await runWithClient({
        request: async (method, params = {}) => {
          if (method === "thread/resume") {
            return {
              thread: { id: params.threadId },
              initialTurnsPage: { data: [{ id: "previous-turn" }] },
            };
          }
          if (method === "thread/compact/start") {
            emitNextCandidate();
            return {};
          }
          if (method === "thread/turns/list") {
            const candidateTurnId = `candidate-drip-${turnListRequests}`;
            turnListRequests += 1;
            setImmediate(emitNextCandidate);
            return {
              data: [
                { id: "previous-turn" },
                { id: candidateTurnId },
              ],
            };
          }
          throw new Error(`Unexpected control request: ${method}`);
        },
      });
    };
    const manager = trackManager(new ProviderManager(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([
        createCodexAppServerHarness({
          compactionTimeoutMs: 2_000,
          withControlClient,
        }),
      ]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-candidate-drip",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("too many lifecycle candidates"),
    });
    expect(emittedCandidates).toBe(33);
    expect(turnListRequests).toBe(32);
  });

  it("fails closed when stale candidates never produce a new durable turn", async () => {
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => await runWithClient({
      request: async (method, params = {}) => {
        if (method === "thread/resume") {
          return {
            thread: { id: params.threadId },
            initialTurnsPage: { data: [{ id: "previous-turn" }] },
          };
        }
        if (method === "thread/compact/start") {
          options.onNotification?.("turn/started", {
            threadId: params.threadId,
            turn: {
              id: "previous-turn",
              status: "inProgress",
              items: [],
              error: null,
            },
          });
          options.onNotification?.("item/started", {
            threadId: params.threadId,
            turnId: "previous-turn",
            startedAtMs: 1,
            item: { id: "compact-stale", type: "contextCompaction" },
          });
          options.onNotification?.("item/completed", {
            threadId: params.threadId,
            turnId: "previous-turn",
            completedAtMs: 2,
            item: { id: "compact-stale", type: "contextCompaction" },
          });
          options.onNotification?.("turn/completed", {
            threadId: params.threadId,
            turn: {
              id: "previous-turn",
              status: "completed",
              items: [],
              error: null,
            },
          });
          return {};
        }
        if (method === "thread/turns/list") {
          return { data: [{ id: "previous-turn" }] };
        }
        throw new Error(`Unexpected control request: ${method}`);
      },
    });
    const manager = trackManager(new ProviderManager(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([
        createCodexAppServerHarness({
          compactionTimeoutMs: 25,
          withControlClient,
        }),
      ]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-never-durable",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: "Codex context compaction timed out.",
    });
  });

  it("cancels while waiting for a verified Codex lifecycle candidate", async () => {
    let manager!: ProviderManager;
    let cancellationRequested = false;
    const withControlClient: NonNullable<
      CodexAppServerHarnessDependencies["withControlClient"]
    > = async (options, runWithClient) => {
      const operation = runWithClient({
        request: async (method, params = {}) => {
          if (method === "thread/resume") {
            return {
              thread: { id: params.threadId },
              initialTurnsPage: { data: [{ id: "previous-turn" }] },
            };
          }
          if (method !== "thread/compact/start") {
            throw new Error(`Unexpected control request: ${method}`);
          }
          setImmediate(() => {
            cancellationRequested = manager.cancel(
              "codex-compact-cancel-candidates",
            );
          });
          return {};
        },
      });
      const cancelled = new Promise<never>((_resolve, reject) => {
        const rejectCancellation = (): void => {
          reject(new Error("Codex control request was cancelled."));
        };
        if (options.signal?.aborted) rejectCancellation();
        else options.signal?.addEventListener(
          "abort",
          rejectCancellation,
          { once: true },
        );
      });
      return await Promise.race([operation, cancelled]);
    };
    manager = trackManager(new ProviderManager(
      { commands: { codex: process.execPath } },
      new AgentHarnessRegistry([
        createCodexAppServerHarness({ withControlClient }),
      ]),
    ));

    const result = manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-cancel-candidates",
      cwd: process.cwd(),
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }));

    await expect(result).resolves.toMatchObject({ status: "cancelled" });
    expect(cancellationRequested).toBe(true);
  });

  it.each([
    ["item whitespace", "compact-proof ", "compact-proof", "compact-turn", "compact-turn"],
    ["turn whitespace", "compact-proof", "compact-proof", "compact-turn ", "compact-turn"],
    ["overlength item", "a".repeat(513), "a".repeat(513), "compact-turn", "compact-turn"],
    ["overlength turn", "compact-proof", "compact-proof", "b".repeat(513), "b".repeat(513)],
  ])("does not correlate normalized Codex lifecycle IDs (%s)", async (
    _label,
    startedItemId,
    completedItemId,
    startedTurnId,
    completedTurnId,
  ) => {
    const root = portableFixtureRoot(`Codex compact invalid lifecycle ${_label}`);
    roots.push(root);
    const command = process.execPath;
    writeNodeSubcommand(root, "app-server", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId }, initialTurnsPage: { data: [{ id: "previous-turn" }] } } });
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: ${JSON.stringify(startedTurnId)}, status: "inProgress", items: [], error: null } } });
    send({ method: "item/started", params: { threadId: message.params.threadId, turnId: ${JSON.stringify(startedTurnId)}, startedAtMs: Date.now(), item: { id: ${JSON.stringify(startedItemId)}, type: "contextCompaction" } } });
    send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: ${JSON.stringify(completedTurnId)}, completedAtMs: Date.now(), item: { id: ${JSON.stringify(completedItemId)}, type: "contextCompaction" } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: ${JSON.stringify(completedTurnId)}, status: "completed", items: [], error: null } } });
    return setImmediate(() => send({ id: 9999, method: "fixture/reject-invalid-compaction" }));
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: `codex-compact-invalid-lifecycle-${_label}`,
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("unexpected server request"),
    });
  });

  it("does not accept a same-thread Codex completion without its post-request start", async () => {
    const root = portableFixtureRoot("Codex compact unstarted item");
    roots.push(root);
    const command = process.execPath;
    writeNodeSubcommand(root, "app-server", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId }, initialTurnsPage: { data: [{ id: "previous-turn" }] } } });
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "item/completed", params: { threadId: message.params.threadId, item: { id: "compact-stale", type: "contextCompaction" } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "compact-turn", status: "completed", items: [], error: null } } });
    return setImmediate(() => send({ id: 9999, method: "fixture/reject-invalid-compaction" }));
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-unstarted-item",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("unexpected server request"),
    });
  });

  it.each([
    ["another thread", "different-thread", "contextCompaction"],
    ["an unrelated item type", "thread-existing", "commandExecution"],
  ])("does not accept a Codex lifecycle from %s", async (
    _label,
    eventThreadId,
    itemType,
  ) => {
    const root = portableFixtureRoot(`Codex compact ${_label}`);
    roots.push(root);
    const command = process.execPath;
    writeNodeSubcommand(root, "app-server", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: message.params.threadId }, initialTurnsPage: { data: [{ id: "previous-turn" }] } } });
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    send({ method: "turn/started", params: { threadId: ${JSON.stringify(eventThreadId)}, turn: { id: "wrong-turn", status: "inProgress", items: [], error: null } } });
    send({ method: "item/started", params: { threadId: ${JSON.stringify(eventThreadId)}, turnId: "wrong-turn", startedAtMs: 1, item: { id: "compact-wrong", type: ${JSON.stringify(itemType)} } } });
    send({ method: "item/completed", params: { threadId: ${JSON.stringify(eventThreadId)}, turnId: "wrong-turn", completedAtMs: 2, item: { id: "compact-wrong", type: ${JSON.stringify(itemType)} } } });
    send({ method: "turn/completed", params: { threadId: ${JSON.stringify(eventThreadId)}, turn: { id: "wrong-turn", status: "completed", items: [], error: null } } });
    return setTimeout(() => send({ id: 9999, method: "fixture/reject-invalid-compaction" }), 25);
  }
  if (message.method === "thread/turns/list") return send({ id: message.id, result: { data: [{ id: "wrong-turn" }] } });
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: `codex-compact-${_label.replaceAll(" ", "-")}`,
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("unexpected server request"),
    });
  });

  it("does not accept a stale same-thread Codex item before requesting compaction", async () => {
    const root = portableFixtureRoot("Codex compact stale item");
    roots.push(root);
    const command = process.execPath;
    writeNodeSubcommand(root, "app-server", `
const readline = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fixture" } });
  if (message.method === "initialized") return;
  if (message.method === "thread/resume") {
    send({ method: "item/completed", params: { threadId: message.params.threadId, item: { id: "compact-stale", type: "contextCompaction" } } });
    return send({ id: message.id, result: { thread: { id: message.params.threadId }, initialTurnsPage: { data: [{ id: "previous-turn" }] } } });
  }
  if (message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
    return setImmediate(() => send({ id: 9999, method: "fixture/reject-invalid-compaction" }));
  }
});
`);
    const manager = trackManager(
      new ProviderManager({ commands: { codex: command } }),
    );

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "codex",
      conversationId: "codex-compact-stale-item",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "thread-existing",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("unexpected server request"),
    });
  });

  it("forwards Claude focus text and requires native completion proof", async () => {
    const root = portableFixtureRoot("Claude compact");
    roots.push(root);
    let capturedPrompt: SDKUserMessage | undefined;
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ prompt }) => fixtureClaudeQuery(
        (async function* (): AsyncGenerator<SDKMessage> {
          const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
          capturedPrompt = (await iterator.next()).value;
          yield claudeSystem("status", { status: null, compact_result: "success" });
          yield claudeSuccessResult("Compacted");
        })(),
      ),
    });
    const manager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([harness]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    }), "remember retrieval exactly")).resolves.toMatchObject({
      status: "completed",
      instructionForwarded: true,
    });
    expect(JSON.stringify(capturedPrompt)).toContain(
      "/compact remember retrieval exactly",
    );

    const unprovenManager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSuccessResult("Ordinary result");
          })(),
        ),
      })]),
    ));
    await expect(unprovenManager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-unproven",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("did not confirm"),
    });

    const contradictoryManager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("status", {
              status: null,
              compact_result: "failed",
              compact_error: "Compaction rejected",
            });
            yield claudeSystem("compact_boundary", {
              compact_metadata: {
                trigger: "manual",
                pre_tokens: 1_000,
              },
            });
            yield claudeSuccessResult("Ordinary result");
          })(),
        ),
      })]),
    ));
    await expect(contradictoryManager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-contradictory",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("Compaction rejected"),
    });
  });

  it("rejects a successful provider result for a different session", async () => {
    const root = portableFixtureRoot("Claude compact wrong session");
    roots.push(root);
    const manager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield claudeSystem("status", {
              status: null,
              compact_result: "success",
            });
            yield claudeSuccessResult("Compacted");
          })(),
        ),
      })]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-wrong-session",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: "different-claude-session",
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("exact selected session"),
      cleanupConfirmed: true,
    });
  });

  it("does not accept a foreign Claude proof followed by a selected-session result", async () => {
    const root = portableFixtureRoot("Claude compact foreign proof");
    roots.push(root);
    const manager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield {
              ...claudeSystem("status", {
                status: null,
                compact_result: "success",
              }),
              session_id: "foreign-claude-session",
            } as SDKMessage;
            yield claudeSuccessResult("Ordinary selected-session result");
          })(),
        ),
      })]),
    ));

    await expect(manager.compact(nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-foreign-proof",
      cwd: root,
      prompt: "/compact",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    }))).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("did not confirm"),
      cleanupConfirmed: true,
    });
  });

  it("does not accept Fast attestation from a foreign Claude session", async () => {
    const root = portableFixtureRoot("Claude compact foreign Fast init");
    roots.push(root);
    const manager = trackManager(new ProviderManager(
      { commands: { claude: "/fake/claude" } },
      new AgentHarnessRegistry([createClaudeAgentSdkHarness({
        createQuery: () => fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            yield {
              ...claudeSystem("init", { fast_mode_state: "on" }),
              session_id: "foreign-claude-session",
            } as SDKMessage;
            yield claudeSystem("status", {
              status: null,
              compact_result: "success",
            });
            yield claudeSuccessResult("Selected-session result");
          })(),
        ),
      })]),
    ));
    const base = nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-compact-foreign-fast-init",
      cwd: root,
      prompt: "/compact",
      model: "claude-opus",
      interactionMode: "build",
      access: "supervised",
      sessionId: CLAUDE_PROTOCOL_SESSION_ID,
    });
    const selection = withModelSelectionFastMode(base.modelSelection, "fast");

    await expect(manager.compact({
      ...base,
      supportedFastMode: "fast",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(
        selection,
        null,
        false,
      ),
    })).resolves.toMatchObject({
      status: "failed",
      message: expect.stringContaining("did not confirm Fast mode"),
      cleanupConfirmed: true,
    });
  });
});
