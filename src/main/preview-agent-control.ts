import type { WebContents } from "electron";

const MAX_EXPECTED_INPUTS = 64;
const EXPECTED_INPUT_TTL_MS = 2_000;
const MOUSE_TOLERANCE_PX = 1;

type AgentPageInput = Parameters<WebContents["sendInputEvent"]>[0];

interface ObservedInput {
  type?: unknown;
  x?: unknown;
  y?: unknown;
}

interface ExpectedInput {
  kind: "key" | "mouse";
  x: number;
  y: number;
  expiresAt: number;
}

const expectedInputs = new WeakMap<object, ExpectedInput[]>();

function inputKind(type: unknown): ExpectedInput["kind"] | null {
  if (type === "mouseDown") return "mouse";
  if (type === "keyDown" || type === "rawKeyDown") return "key";
  return null;
}

function coordinate(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NaN;
}

function liveExpectations(contents: object, now: number): ExpectedInput[] {
  const live = (expectedInputs.get(contents) ?? []).filter((entry) => entry.expiresAt >= now);
  expectedInputs.set(contents, live);
  return live;
}

export function sendAgentPageInput(contents: WebContents, input: AgentPageInput): void {
  const kind = inputKind(input.type);
  if (kind) {
    const now = Date.now();
    const live = liveExpectations(contents, now);
    const pointer = input as { x?: unknown; y?: unknown };
    live.push({ kind, x: coordinate(pointer.x), y: coordinate(pointer.y), expiresAt: now + EXPECTED_INPUT_TTL_MS });
    if (live.length > MAX_EXPECTED_INPUTS) live.splice(0, live.length - MAX_EXPECTED_INPUTS);
  }
  contents.sendInputEvent(input);
}

export function agentPageInputIsUser(contents: WebContents, input: ObservedInput): boolean {
  const kind = inputKind(input.type);
  if (!kind) return false;
  const live = liveExpectations(contents, Date.now());
  const x = coordinate(input.x);
  const y = coordinate(input.y);
  const index = live.findIndex((entry) => entry.kind === kind && (kind === "key" || (
    Math.abs(entry.x - x) <= MOUSE_TOLERANCE_PX && Math.abs(entry.y - y) <= MOUSE_TOLERANCE_PX
  )));
  if (index < 0) return true;
  live.splice(index, 1);
  return false;
}
