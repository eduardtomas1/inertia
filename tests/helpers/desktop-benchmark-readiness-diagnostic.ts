import WebSocket from "ws";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";

import { LIFECYCLE_ACTIONABLE_STATES } from "../../src/shared/lifecycle-diagnostics";
import { CURRENT_KNOWN_HARNESS_IDS } from "../../src/shared/model-routing";

export const BENCHMARK_READINESS_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const BENCHMARK_LOGIN_MARKER = ".inertia-login-readiness.json";
export const benchmarkLoginFixtureSource = `
if (process.argv[2] === "status") {
  const fs = require("node:fs");
  const startedAt = Date.now();
  const marker = (stage) => {
    try {
      fs.writeFileSync(${JSON.stringify(BENCHMARK_LOGIN_MARKER)}, JSON.stringify({
        stage, startedAt, observedAt: Date.now(),
      }));
    } catch { /* Best-effort test evidence must not alter authentication. */ }
  };
  marker("started");
  process.stdout.write("Logged in using ChatGPT\\n");
  marker("write-completed");
  process.exit(0);
}
process.stdout.write("Sign-in complete\\n");
`;
const providerIds = ["codex", "claude", "cursor", "gemini", "kimi", "opencode"] as const;
const backendIds = ["builtin:openai", "builtin:anthropic", "builtin:cursor", "builtin:gemini", "builtin:kimi", "builtin:opencode"] as const;
const installStates = ["checking", "installed", "not-installed", "error"] as const;
const authStates = ["checking", "authenticated", "unauthenticated", "configured", "unknown", "error"] as const;
const actions = ["send-disabled", "send-ready", "submitting", "stop-ready", "stop-pending"] as const;
const routeBadges = ["CLI missing", "Checking", "Connection issue", "Disabled", "Key missing", "Probe needed", "Probing", "Sign in", "Unavailable", "Update needed"] as const;
const routeRepairs = ["none", "add-key", "configure", "connect", "install", "probe", "refresh"] as const;
const statusCodes = new Map([
  ["Connected", "connected"], ["Configured", "configured"],
  ["Installed; connection not confirmed", "auth-unconfirmed"],
  ["Sign in required", "auth-required"], ["Connection check failed", "auth-error"],
  ["Agent discovery failed", "discovery-failed"], ["CLI not found", "cli-missing"],
  ["Codex CLI not found", "cli-missing"], ["CLI did not respond", "cli-unresponsive"],
  ["Codex CLI was found but failed to start", "cli-unresponsive"],
  ["Codex App Server is unsupported; update the selected CLI", "protocol-unavailable"],
]);
for (const label of ["Codex", "Claude Code", "Cursor", "Gemini", "Kimi Code", "OpenCode"]) {
  statusCodes.set(`${label} is installed; authentication was not checked`, "auth-unchecked");
  statusCodes.set(`${label} probe cleanup could not be confirmed stopped`, "cleanup-unconfirmed");
  statusCodes.set(`${label} connection probe timed out, and its process tree could not be confirmed stopped`, "cleanup-unconfirmed");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function member<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | null {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}
function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// Never retain IDs, arbitrary model/backend names, paths, status text, prompts,
// credentials, provider output, or the full welcome snapshot.
export function projectBenchmarkRuntimeReadiness(payload: string | Buffer) {
  if (Buffer.byteLength(payload) > BENCHMARK_READINESS_MAX_FRAME_BYTES) return null;
  let event: Record<string, unknown> | null;
  try { event = record(JSON.parse(String(payload))); } catch { return null; }
  if (event?.type === "runtime.event") event = record(event.event);
  if (event?.type !== "server.welcome" && event?.type !== "snapshot.updated") return null;
  const snapshot = record(event.snapshot);
  if (!snapshot || !Array.isArray(snapshot.conversations) || snapshot.conversations.length > 4096
    || !Array.isArray(snapshot.providers) || snapshot.providers.length > providerIds.length) return null;
  const selected = typeof snapshot.activeConversationId === "string"
    ? record(snapshot.conversations.find((value) => record(value)?.id === snapshot.activeConversationId)) : null;
  const selection = record(selected?.modelSelection);
  const providerId = member(selected?.providerId, providerIds);
  const matches = snapshot.providers.filter((value) => providerId !== null && record(value)?.id === providerId);
  const provider = matches.length === 1 ? record(matches[0]) : null;
  const lifecycle = record(snapshot.lifecycleDiagnostics);
  return {
    selectedConversationPresent: selected !== null,
    selectedRoute: {
      providerId,
      harnessId: member(selection?.harnessId, CURRENT_KNOWN_HARNESS_IDS),
      backend: member(selection?.backendProfileId, backendIds) ?? "other-or-missing",
      model: selection?.modelId === "provider-default" ? "provider-default"
        : typeof selection?.modelId === "string" && selection.modelId.length > 0 ? "other" : "missing",
      reasoningSelected: typeof selection?.reasoningEffort === "string" && selection.reasoningEffort.length > 0,
      providerOptionsPresent: Object.keys(record(selection?.providerOptions) ?? {}).length > 0,
    },
    provider: provider === null ? null : {
      available: boolean(provider.available),
      executablePresent: typeof provider.executable === "string" && provider.executable.length > 0,
      installState: member(provider.installState, installStates),
      authState: member(provider.authState, authStates),
      canRun: boolean(provider.canRun),
      statusCode: typeof provider.statusMessage === "string"
        ? statusCodes.get(provider.statusMessage) ?? "other-or-absent" : "other-or-absent",
    },
    admission: member(lifecycle?.actionableState, LIFECYCLE_ACTIONABLE_STATES),
  };
}
export type BenchmarkRuntimeReadiness = ReturnType<typeof projectBenchmarkRuntimeReadiness>;

export async function readBenchmarkRuntimeReadiness(url: string | null, timeoutMs: number) {
  if (url === null) return { outcome: "unavailable" as const };
  return await new Promise<
    { outcome: "captured"; value: NonNullable<BenchmarkRuntimeReadiness> }
    | { outcome: "unavailable" | "timed-out" | "invalid-frame" }
  >((resolve) => {
    const duration = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(1000, Math.trunc(timeoutMs))) : 1000;
    const socket = new WebSocket(url, { origin: "inertia://bundle",
      maxPayload: BENCHMARK_READINESS_MAX_FRAME_BYTES, handshakeTimeout: duration });
    let settled = false;
    const finish = (result: Parameters<typeof resolve>[0]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ outcome: "timed-out" }), duration);
    timer.unref();
    socket.on("error", () => finish({ outcome: "unavailable" }));
    socket.once("close", () => finish({ outcome: "unavailable" }));
    socket.once("message", (data) => {
      const value = projectBenchmarkRuntimeReadiness(data.toString());
      finish(value ? { outcome: "captured", value } : { outcome: "invalid-frame" });
    });
  });
}

export async function readBenchmarkLoginMarker(workspace: string, launchedAt: number) {
  try {
    const path = join(workspace, BENCHMARK_LOGIN_MARKER);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 512) return null;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const bytes = Buffer.alloc(513);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 512) return null;
      const value = record(JSON.parse(bytes.subarray(0, bytesRead).toString()));
      const stage = member(value?.stage, ["started", "write-completed"] as const);
      const startedAt = value?.startedAt;
      const observedAt = value?.observedAt;
      if (!stage || typeof startedAt !== "number" || !Number.isSafeInteger(startedAt)
        || typeof observedAt !== "number" || !Number.isSafeInteger(observedAt)
        || startedAt < 0 || observedAt < startedAt || observedAt > Date.now()) return null;
      return { stage, startedAt, observedAt, fromCurrentLaunch: startedAt >= launchedAt };
    } finally { await file.close(); }
  } catch { return null; }
}

export function projectBenchmarkComposerAdmission(value: unknown) {
  const input = record(value) ?? {};
  return {
    connection: member(input.connection, ["connecting", "online", "offline", "reconnecting", "error"] as const),
    composerPresent: boolean(input.composerPresent),
    promptPresent: boolean(input.promptPresent),
    inputDisabled: boolean(input.inputDisabled),
    composerDisabled: boolean(input.composerDisabled),
    composerBusy: boolean(input.composerBusy),
    sendDisabled: boolean(input.sendDisabled),
    sendBusy: boolean(input.sendBusy),
    action: member(input.action, actions),
    routeBlocked: boolean(input.routeBlocked),
    routeTransient: boolean(input.routeTransient),
    routeBadge: member(input.routeBadge, routeBadges),
    routeRepair: member(input.routeRepair, routeRepairs),
  };
}

// Self-contained so Playwright can evaluate this function in the renderer.
// Only booleans and explicitly recognized DOM enums cross back to the test.
export function readBenchmarkComposerAdmission() {
  const composer = document.querySelector<HTMLElement>('[aria-label="Message composer"]');
  const input = composer?.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  const send = composer?.querySelector<HTMLButtonElement>('button[data-composer-action-state]');
  const notice = composer?.querySelector<HTMLElement>(".provider-readiness");
  const allowed = (value: string | null | undefined, values: string[]): string | null =>
    value !== undefined && value !== null && values.includes(value) ? value : null;
  const flag = (value: string | null | undefined): boolean | null =>
    value === "true" ? true : value === "false" ? false : null;
  return {
    connection: allowed(document.querySelector(".app-shell")?.getAttribute("data-connection-status"),
      ["connecting", "online", "offline", "reconnecting", "error"]),
    composerPresent: Boolean(composer),
    promptPresent: input ? input.value.trim().length > 0 : null,
    inputDisabled: input?.disabled ?? null,
    composerDisabled: flag(composer?.dataset.disabled),
    composerBusy: flag(composer?.getAttribute("aria-busy")),
    sendDisabled: send?.disabled ?? null,
    sendBusy: flag(send?.getAttribute("aria-busy")),
    action: allowed(send?.dataset.composerActionState,
      ["send-disabled", "send-ready", "submitting", "stop-ready", "stop-pending"]),
    routeBlocked: composer ? Boolean(notice) : null,
    routeTransient: notice ? flag(notice.dataset.transient) : null,
    routeBadge: allowed(notice?.querySelector(".route-readiness-badge")?.textContent?.trim(),
      ["CLI missing", "Checking", "Connection issue", "Disabled", "Key missing", "Probe needed", "Probing", "Sign in", "Unavailable", "Update needed"]),
    routeRepair: allowed(notice?.dataset.routeRepair,
      ["none", "add-key", "configure", "connect", "install", "probe", "refresh"]),
  };
}

export function benchmarkReadinessBlockers(runtime: BenchmarkRuntimeReadiness,
  composer: ReturnType<typeof projectBenchmarkComposerAdmission> | null): readonly string[] {
  const reasons: string[] = [];
  if (!runtime) reasons.push("runtime-observation-unavailable");
  else {
    if (!runtime.selectedConversationPresent) reasons.push("selected-conversation-unavailable");
    if (runtime.admission && runtime.admission !== "safe-and-ready") reasons.push("runtime-admission-blocked");
    if (!runtime.provider) reasons.push("selected-provider-unavailable");
    else if (runtime.provider.canRun === false) {
      reasons.push("provider-not-runnable");
      if (runtime.provider.authState === "unknown") reasons.push("provider-auth-unknown");
      if (runtime.provider.authState === "checking") reasons.push("provider-auth-checking");
      if (runtime.provider.statusCode === "cleanup-unconfirmed") reasons.push("provider-cleanup-unconfirmed");
    }
  }
  if (!composer || composer.composerPresent !== true) reasons.push("composer-observation-unavailable");
  else {
    if (composer.connection !== "online") reasons.push("connection-not-online");
    if (composer.promptPresent === false) reasons.push("prompt-empty");
    if (composer.composerDisabled === true || composer.inputDisabled === true) reasons.push("composer-disabled-or-update-pending");
    if (composer.composerBusy === true) reasons.push("composer-busy");
    if (composer.routeBlocked === true) reasons.push("selected-route-blocked");
    if (composer.sendDisabled === true) reasons.push("send-disabled");
  }
  return reasons;
}
