import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { scaledClaudeRefreshDelays } from "../helpers/claude-refresh-fixture";
import {
  createClaudeRefreshScenario,
  type ClaudeRefreshMeasurement,
} from "../helpers/claude-refresh-scenario";
import { portableFixtureRoot, removePortableFixture } from "../helpers/portable-provider-fixture";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";

const SCALES = (process.env.INERTIA_PROVIDER_REFRESH_SCALES ?? "1,5,10")
  .split(",").map((value) => Number.parseFloat(value)).filter((value) => value > 0);
const RUNS = Number.parseInt(process.env.INERTIA_PROVIDER_REFRESH_RUNS ?? "3", 10);
const guardianPath = resolve("resources/generated/runtime-process-guardian/runtime-process-guardian");
const roots: string[] = [];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Number((sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN).toFixed(0));
}

function summary(runs: readonly ClaudeRefreshMeasurement[]) {
  const finals = runs.map(({ finalLabel, finalModels }) => `${finalLabel}/${finalModels} models`);
  return {
    wallMs: median(runs.map(({ wallMs }) => wallMs)),
    firstConnectedMs: runs.every(({ firstConnectedMs }) => firstConnectedMs !== null)
      ? median(runs.map(({ firstConnectedMs }) => firstConnectedMs!))
      : null,
    settledMs: median(runs.map(({ settledMs }) => settledMs)),
    modelsMs: runs.every(({ modelsMs }) => modelsMs !== null)
      ? median(runs.map(({ modelsMs }) => modelsMs!))
      : null,
    processes: runs[0]!.processes,
    maxConcurrentProcesses: Math.max(...runs.map(({ maxConcurrentProcesses }) => maxConcurrentProcesses)),
    labels: [...new Set(runs.map(({ labels }) => labels.join(" -> ")))],
    finals: [...new Set(finals)],
  };
}

afterAll(async () => {
  await Promise.all(roots.splice(0).map(removePortableFixture));
});

describe.runIf(process.platform === "darwin" || process.platform === "linux")("Claude provider refresh", () => {
  it("measures one refresh against a fake Claude at several speeds", async () => {
    const report: Record<string, unknown> = {
      platform: process.platform,
      arch: process.arch,
      runs: RUNS,
      baseDelays: scaledClaudeRefreshDelays(1),
      scales: {},
    };
    for (const scale of SCALES) {
      const launches: ClaudeRefreshMeasurement[] = [];
      const refreshes: ClaudeRefreshMeasurement[] = [];
      const refreshesWithinTtl: ClaudeRefreshMeasurement[] = [];
      const sharedLaunches: ClaudeRefreshMeasurement[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        for (const shared of [false, true]) {
          const root = portableFixtureRoot("provider refresh benchmark");
          roots.push(root);
          const runtimeDirectory = join(root, "runtime");
          mkdirSync(runtimeDirectory, { mode: 0o700 });
          const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
            runtimeDirectory,
            `${randomUUID()}:1`,
            `test:${randomUUID()}`,
            { platform: process.platform, darwinGuardianPath: guardianPath },
          );
          const scenario = await createClaudeRefreshScenario(root, shared ? { cursorScale: scale } : {});
          try {
            const plan = scaledClaudeRefreshDelays(scale);
            if (shared) {
              sharedLaunches.push(await scenario.measure("launch", plan));
            } else {
              launches.push(await scenario.measure("launch", plan));
              refreshes.push(await scenario.measure("refresh", plan));
              refreshesWithinTtl.push(await scenario.measure("refresh-within-ttl", plan));
            }
          } finally {
            await scenario.close();
            deactivate?.();
          }
        }
      }
      const scaleReport = {
        launch: summary(launches),
        refresh: summary(refreshes),
        refreshWithinTtl: summary(refreshesWithinTtl),
        launchWithCursor: summary(sharedLaunches),
        sampleLaunch: launches[0],
        sampleRefresh: refreshes[0],
        sampleLaunchWithCursor: sharedLaunches[0],
      };
      (report.scales as Record<string, unknown>)[`${scale}x`] = scaleReport;
      for (const name of ["launch", "refresh", "refreshWithinTtl", "launchWithCursor"] as const) {
        process.stdout.write(`${scale}x ${name} ${JSON.stringify(scaleReport[name])}\n`);
      }
    }
    const output = resolve(process.env.INERTIA_PROVIDER_REFRESH_REPORT ?? "performance-results/provider-refresh.json");
    mkdirSync(resolve(output, ".."), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    expect(Object.keys(report.scales as object)).toHaveLength(SCALES.length);
  }, 3_600_000);
});
