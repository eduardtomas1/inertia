import { describe, expect, it, vi } from "vitest";

const { electronState, pageTools } = await vi.hoisted(async () => {
  const support = await import("../main/support/preview-broker-harness");
  return {
    electronState: support.createPreviewBrokerElectronState(),
    pageTools: support.createPreviewBrokerPageTools(),
  };
});

vi.mock("electron", async () => (
  (await import("../main/support/preview-broker-harness")).createPreviewBrokerElectronMock(electronState)
));
vi.mock("../../src/main/preview-agent-page", () => pageTools);

import { PreviewBroker } from "../../src/main/preview-broker";
import {
  createSurfaceRuntime,
  mcpReply,
  openToolTransport,
  type SurfaceRuntime,
  type ToolTransport,
  type TransportReply,
  type TransportSession,
} from "../helpers/agent-tool-surface";
import { createPreviewBrokerHarness } from "../main/support/preview-broker-harness";
import {
  MISUSE_CASES,
  type MisuseCall,
  type MisuseCase,
  type MisuseExpectation,
  type MisuseSetup,
} from "./host-tool-misuse-cases";

const ALL_TRANSPORTS: readonly ToolTransport[] = ["codex", "mcp", "claude"];
const MAX_ECHOED_REGEX_CHARS = 40;
const INTERNAL_FAILURE = /Cannot read properties|is not a function|is not defined|Maximum call stack|\n\s+at [\w.<>]+ \(/u;
const defaultLocate = pageTools.locateAgentPageRef.getMockImplementation()!;

type Placeholders = Record<string, string>;

function substitute(value: unknown, placeholders: Placeholders): unknown {
  if (typeof value === "string") return placeholders[value] ?? value;
  if (Array.isArray(value)) return value.map((item) => substitute(item, placeholders));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, substitute(child, placeholders)]));
  }
  return value;
}

async function arrange(setup: readonly MisuseSetup[], runtime: SurfaceRuntime): Promise<Placeholders> {
  const placeholders: Placeholders = { $self: runtime.source.id, $selfTurn: runtime.sourceTurn.id };
  for (const step of setup) {
    if (step === "managed-child" || step === "idle-managed-child") {
      placeholders.$child = await runtime.createManagedChat("Child");
      if (step === "idle-managed-child") runtime.turns.cancel(placeholders.$child);
    } else if (step === "foreign-chat") {
      placeholders.$foreign = runtime.store.createConversation(runtime.project.id, "Sibling chat", {
        activate: false,
      }).id;
    } else if (step === "stale-ref") {
      pageTools.locateAgentPageRef.mockResolvedValue({ found: false });
    } else {
      pageTools.locateAgentPageRef.mockResolvedValue({
        found: true, blocked: false, disabled: false, editable: false,
        label: "Continue", x: 42, y: 28,
      });
    }
  }
  return placeholders;
}

async function send(
  session: TransportSession,
  call: MisuseCall,
  placeholders: Placeholders,
): Promise<TransportReply> {
  return await session.call(call.tool, substitute(call.arguments, placeholders), call.callId);
}

async function replay(misuse: MisuseCase, transport: ToolTransport): Promise<TransportReply> {
  const broker = misuse.browser ? createPreviewBrokerHarness(PreviewBroker).broker : undefined;
  const runtime = await createSurfaceRuntime({
    ...(broker ? { browser: broker } : {}),
    accessMode: misuse.browser ? "full" : "supervised",
  });
  try {
    const placeholders = await arrange(misuse.setup ?? [], runtime);
    const session = await openToolTransport(transport, runtime.bridge, misuse.approval ?? "approve");
    try {
      for (const before of misuse.before ?? []) {
        const prepared = await send(session, before, placeholders);
        if (!prepared.success) throw new Error(`Setup call ${before.tool} failed: ${prepared.text}`);
      }
      if (!("batch" in misuse.call)) return await send(session, misuse.call, placeholders);
      const body = await session.mcpBody!(misuse.call.batch.map((call, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params: { name: call.tool, arguments: substitute(call.arguments, placeholders) },
      })));
      return mcpReply((body as unknown[])[0]);
    } finally {
      await session.close();
    }
  } finally {
    pageTools.locateAgentPageRef.mockImplementation(defaultLocate);
    await runtime.close();
    broker?.close();
  }
}

function replyCode(reply: TransportReply): string | null {
  if (reply.protocolErrorCode !== undefined) return String(reply.protocolErrorCode);
  const protocol = /^MCP error (-?\d+):/u.exec(reply.text);
  if (protocol) return protocol[1]!;
  try {
    const parsed = JSON.parse(reply.text) as { error?: { code?: unknown } } | null;
    return parsed?.error?.code === undefined ? null : String(parsed.error.code);
  } catch {
    return null;
  }
}

function visibleText(reply: TransportReply): string {
  return reply.text.replaceAll("\\\\", "\\").replaceAll("\\\"", "\"").replaceAll("\\n", "\n");
}

function shortfalls(reply: TransportReply, expected: MisuseExpectation): string[] {
  const text = visibleText(reply);
  const problems: string[] = [];
  if (reply.success !== expected.success) problems.push(`success was ${reply.success}, expected ${expected.success}`);
  const code = replyCode(reply);
  if (expected.code !== undefined && expected.code !== null && code !== expected.code) {
    problems.push(`error code was ${code}, expected ${expected.code}`);
  }
  for (const fragment of expected.includes ?? []) {
    if (!text.includes(fragment)) problems.push(`does not mention ${JSON.stringify(fragment)}`);
  }
  for (const pattern of expected.matches ?? []) {
    if (!pattern.test(text)) problems.push(`does not match ${pattern}`);
  }
  if (/"path":\s*\[/u.test(text)) problems.push("echoes raw zod issue JSON");
  const longRegex = (text.match(/\^[^\s"]*?\$/gu) ?? []).find((pattern) => pattern.length > MAX_ECHOED_REGEX_CHARS);
  if (longRegex) problems.push(`echoes a ${longRegex.length}-character regex`);
  return problems;
}

function pendingReason(misuse: MisuseCase, transport: ToolTransport): string | undefined {
  return typeof misuse.pending === "string" ? misuse.pending : misuse.pending?.[transport];
}

function expectation(misuse: MisuseCase, transport: ToolTransport): MisuseExpectation {
  return { ...misuse.expect, ...misuse.transportExpect?.[transport] };
}

describe("host tool misuse eval: recorded wrong and right calls replayed through each provider's real transport", () => {
  it("keeps every case uniquely named, explained and covering the three kinds", () => {
    expect(new Set(MISUSE_CASES.map(({ id }) => id)).size).toBe(MISUSE_CASES.length);
    expect(MISUSE_CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(MISUSE_CASES.map(({ kind }) => kind))).toEqual(new Set(["bad", "guard", "control"]));
    for (const misuse of MISUSE_CASES) {
      expect(misuse.mistake, misuse.id).toMatch(/^[A-Z].*\.$/u);
      if (misuse.kind === "control") expect(misuse.pending, misuse.id).toBeUndefined();
    }
  });

  for (const misuse of MISUSE_CASES) {
    describe(`${misuse.kind} ${misuse.id}: ${misuse.mistake}`, () => {
      for (const transport of misuse.transports ?? ALL_TRANSPORTS) {
        const pending = pendingReason(misuse, transport);
        const title = pending ? `${transport} (known gap: ${pending})` : transport;
        it(title, async () => {
          const reply = await replay(misuse, transport);
          expect(reply.text, "The reply leaks an internal failure.").not.toMatch(INTERNAL_FAILURE);
          const problems = shortfalls(reply, expectation(misuse, transport));
          if (pending) {
            expect(problems, `The known gap is closed; remove its pending mark. Reply: ${reply.text}`)
              .not.toEqual([]);
          } else {
            expect(problems, `Reply: ${reply.text}`).toEqual([]);
          }
        });
      }
    });
  }
});
