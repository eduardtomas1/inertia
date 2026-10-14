import { performance } from "node:perf_hooks";

import type { ProviderInfo } from "../../src/shared/contracts";
import { providerStateLabel } from "../../src/renderer/src/utils/providerStatus";
import { providerEnvironment } from "../../src/server/environment";
import {
  ProviderMetadataCache,
  readProviderMetadata,
} from "../../src/server/provider/metadata";
import { createProviderInfoRefresh } from "../../src/server/provider/provider-info-refresh";
import { detectProvider, ProviderManager } from "../../src/server/providers";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";
import {
  writeClaudeRefreshFixture,
  writeCursorRefreshFixture,
  type ClaudeRefreshCall,
  type ClaudeRefreshFixture,
  type ClaudeRefreshFixturePlan,
} from "./claude-refresh-fixture";

export interface ClaudeRefreshState {
  atMs: number;
  label: string;
  models: number;
  rateLimits: number;
  canRun: boolean;
  statusMessage: string | null;
}

export interface ClaudeRefreshStep {
  name: string;
  startedMs: number;
  endedMs: number | null;
  deadlineMs: number | null;
  outcome: string;
}

export interface ClaudeRefreshMeasurement {
  wallMs: number;
  settledMs: number;
  firstConnectedMs: number | null;
  modelsMs: number | null;
  finalLabel: string;
  finalModels: number;
  finalRateLimits: number;
  labels: string[];
  states: ClaudeRefreshState[];
  processes: Record<string, number>;
  calls: Array<{ kind: string; startedMs: number; endedMs: number | null; requests: string[] }>;
  steps: ClaudeRefreshStep[];
  maxConcurrentProcesses: number;
}

export interface ClaudeRefreshScenario {
  fixture: ClaudeRefreshFixture;
  claude(): ProviderInfo;
  measure(
    mode: "refresh" | "launch",
    plan: ClaudeRefreshFixturePlan,
    settleTimeoutMs?: number,
  ): Promise<ClaudeRefreshMeasurement>;
  close(): Promise<void>;
}

const TERMINAL_WAIT_STEP_MS = 10;

function overlap(calls: readonly ClaudeRefreshCall[], now: number): number {
  const edges = calls.flatMap((call) => [
    { at: call.startedAt, delta: 1 },
    { at: call.endedAt ?? now, delta: -1 },
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let current = 0;
  let maximum = 0;
  for (const edge of edges) {
    current += edge.delta;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

export async function createClaudeRefreshScenario(
  root: string,
  options: { detectionRetryDelaysMs?: readonly number[]; cursorScale?: number } = {},
): Promise<ClaudeRefreshScenario> {
  const fixture = writeClaudeRefreshFixture(root);
  const cursor = options.cursorScale === undefined ? null : writeCursorRefreshFixture(root);
  cursor?.setScale(options.cursorScale!);
  const previousBinDirectory = process.env.INERTIA_TEST_PROVIDER_BIN_DIR;
  process.env.INERTIA_TEST_PROVIDER_BIN_DIR = root;
  await providerEnvironment(true);
  const lifetime = new AbortController();
  let origin = performance.now();
  const elapsed = (): number => performance.now() - origin;
  const steps: ClaudeRefreshStep[] = [];
  const metadataCache = new ProviderMetadataCache({
    read: async (providerId, executable, environment, cwd, fields, signal) => {
      const step: ClaudeRefreshStep = {
        name: `metadata ${providerId} (${(fields ?? []).join("+")})`,
        startedMs: elapsed(),
        endedMs: null,
        deadlineMs: providerId === "claude" ? 6_000 : null,
        outcome: "pending",
      };
      steps.push(step);
      try {
        const result = await readProviderMetadata(providerId, executable, environment, cwd, fields, signal);
        step.outcome = `models=${result.models?.length ?? 0} rateLimits=${result.rateLimits?.length ?? 0}`;
        return result;
      } catch (error) {
        step.outcome = error instanceof Error ? error.message : "failed";
        throw error;
      } finally {
        step.endedMs = elapsed();
      }
    },
  });
  const manager = ProviderManager.createForTests({
    commands: {
      claude: fixture.executable,
      ...(cursor ? { cursor: cursor.executable } : {}),
    },
    lifetimeSignal: lifetime.signal,
    metadataCache,
    detectProvider: async (providerId, detectionOptions, dependencies) => {
      const step: ClaudeRefreshStep = {
        name: `detect ${providerId}`,
        startedMs: elapsed(),
        endedMs: null,
        deadlineMs: detectionOptions?.timeoutMs ?? null,
        outcome: "pending",
      };
      if (providerId === "claude") steps.push(step);
      try {
        const detection = await detectProvider(providerId, detectionOptions, dependencies);
        step.outcome = `${detection.installState}/${detection.authState}${detection.probeTimedOut ? " timed out" : ""}`;
        return detection;
      } catch (error) {
        step.outcome = error instanceof Error ? error.message : "failed";
        throw error;
      } finally {
        step.endedMs = elapsed();
      }
    },
  });
  let providerInfo: ProviderInfo[] = initialProviderSnapshots();
  let active = 0;
  const states: ClaudeRefreshState[] = [];
  const claude = (): ProviderInfo => providerInfo.find(({ id }) => id === "claude")!;
  const refresh = createProviderInfoRefresh({
    enabled: true,
    providers: manager,
    defaultWorkspacePath: root,
    lifetimeSignal: lifetime.signal,
    providerInfo: () => providerInfo,
    replaceProviderInfo: (value) => { providerInfo = value; },
    broadcastSnapshot: () => {
      const current = claude();
      states.push({
        atMs: elapsed(),
        label: providerStateLabel(current),
        models: current.models.length,
        rateLimits: current.rateLimits.length,
        canRun: current.canRun,
        statusMessage: current.statusMessage,
      });
    },
    isClosed: () => lifetime.signal.aborted,
    track: async (operation) => await operation(),
    onActivityChange: (delta) => { active += delta; },
    ...(options.detectionRetryDelaysMs
      ? { detectionRetryDelaysMs: options.detectionRetryDelaysMs }
      : {}),
  });

  const measure: ClaudeRefreshScenario["measure"] = async (mode, plan, settleTimeoutMs = 120_000) => {
    fixture.setPlan(plan);
    fixture.resetCalls();
    states.length = 0;
    steps.length = 0;
    origin = performance.now();
    const wallClockOrigin = Date.now();
    let resolved = false;
    const running = (mode === "refresh"
      ? refresh("claude", true, true)
      : refresh(undefined, true)).finally(() => { resolved = true; });
    await running;
    const wallMs = elapsed();
    const deadline = Date.now() + settleTimeoutMs;
    while (
      (!resolved || active > 0 || providerStateLabel(claude()) === "Checking")
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, TERMINAL_WAIT_STEP_MS));
    }
    const settledMs = states.at(-1)?.atMs ?? wallMs;
    const calls = fixture.calls();
    const now = Date.now();
    const processes: Record<string, number> = {};
    for (const call of calls) processes[call.kind] = (processes[call.kind] ?? 0) + 1;
    const final = claude();
    return {
      wallMs,
      settledMs,
      firstConnectedMs: states.find(({ label }) => label === "Connected")?.atMs ?? null,
      modelsMs: states.find(({ models }) => models > 0)?.atMs ?? null,
      finalLabel: providerStateLabel(final),
      finalModels: final.models.length,
      finalRateLimits: final.rateLimits.length,
      labels: states.map(({ label, models }) => `${label}${models > 0 ? ` +${models} models` : ""}`)
        .filter((label, index, all) => index === 0 || all[index - 1] !== label),
      states: [...states],
      processes,
      calls: calls.map((call) => ({
        kind: call.kind,
        startedMs: call.startedAt - wallClockOrigin,
        endedMs: call.endedAt === null ? null : call.endedAt - wallClockOrigin,
        requests: call.requests,
      })),
      steps: steps.map((step) => ({ ...step })),
      maxConcurrentProcesses: overlap(calls, now),
    };
  };

  return {
    fixture,
    claude,
    measure,
    close: async () => {
      lifetime.abort(new Error("The provider refresh scenario is closing."));
      await manager.disposeAll().catch(() => undefined);
      if (previousBinDirectory === undefined) delete process.env.INERTIA_TEST_PROVIDER_BIN_DIR;
      else process.env.INERTIA_TEST_PROVIDER_BIN_DIR = previousBinDirectory;
      await providerEnvironment(true);
    },
  };
}
