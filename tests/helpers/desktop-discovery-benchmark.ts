import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { expect, type Page } from "@playwright/test";

import { writeNodeFlagExecutable } from "./portable-provider-fixture";

interface DiscoveryRun {
  page: Page;
  firstWindowMs: number;
  startupMs: number;
}

interface DiscoveryBenchmarkOptions<Run extends DiscoveryRun> {
  root: string;
  workspace: string;
  seed(dataDirectory: string): void;
  launch(dataDirectory: string, profile: string, environment: NodeJS.ProcessEnv): Promise<Run>;
  close(run: Run): Promise<number>;
}

// The production resolver also checks these global roots independently of
// PATH. Refuse the scenario if a host CLI could be selected. Synthetic HOME
// controls all remaining user-install roots; no host CLI is invoked here.
export function desktopDiscoveryHostIsIsolated(): boolean {
  return process.platform === "linux" && ![
    "/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin",
  ].some((root) => [
    "codex", "claude", "cursor-agent", "agent", "gemini", "kimi", "opencode",
  ].some((name) => existsSync(join(root, name))));
}

function isolatedEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "LANG", "LC_ALL", "CI",
  ]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return {
    ...environment,
    PATH: "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    TMPDIR: join(home, "tmp"),
    NODE_ENV: "test",
  };
}

export async function measureDesktopDiscovery<Run extends DiscoveryRun>(
  options: DiscoveryBenchmarkOptions<Run>,
) {
  if (!desktopDiscoveryHostIsIsolated()) {
    return {
      outcome: "not-exercised" as const,
      reason: "Controlled desktop discovery requires Linux with no provider CLI in production global search roots.",
      samples: [],
    };
  }
  const home = join(options.root, "home");
  await mkdir(join(home, "tmp"), { recursive: true });
  const environment = isolatedEnvironment(home);
  const installed = writeNodeFlagExecutable(options.root, "discovery-codex", `
    const args = process.argv.slice(2);
    if (args[0] === "--version") process.stdout.write("codex-cli 1.0.0\\n");
    else if (args[0] === "app-server" || args[0] === "login") {
      process.argv.splice(1, 1);
      require(require("node:path").join(${JSON.stringify(options.workspace)}, args[0]));
    }
    else process.exitCode = 1;
  `);
  const marker = join(options.root, "slow-probe.pid");
  const slow = writeNodeFlagExecutable(options.root, "slow-discovery-codex", `
    require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid), { mode: 0o600 });
    setInterval(() => {}, 1000);
  `);
  const samples = [];
  const installedData = join(options.root, "installed-data");
  const installedProfile = join(options.root, "installed-profile");
  for (const scenario of ["installed-cold", "installed-warm", "unavailable", "slow"] as const) {
    const installedCase = scenario.startsWith("installed");
    const dataDirectory = installedCase ? installedData : join(options.root, `${scenario}-data`);
    const profile = installedCase ? installedProfile : join(options.root, `${scenario}-profile`);
    await mkdir(dataDirectory, { recursive: true });
    await mkdir(profile, { recursive: true });
    if (scenario !== "installed-warm") options.seed(dataDirectory);
    const startedAt = performance.now();
    const run = await options.launch(dataDirectory, profile, {
      ...environment,
      INERTIA_PACKAGE_SMOKE_CODEX_EXPECTED: installedCase ? installed
        : scenario === "slow" ? slow : join(options.root, "unavailable-codex"),
    });
    try {
      await run.page.getByRole("button", { name: "Settings", exact: true }).click();
      await run.page.getByRole("button", { name: "Providers", exact: true }).click();
      const status = run.page.locator(".provider-settings-list-row").filter({
        has: run.page.getByRole("button", { name: "Configure Codex", exact: true }),
      }).locator(".provider-status");
      await expect(status).not.toHaveClass(/is-checking/u, { timeout: 20_000 });
      await expect(status).toHaveClass(installedCase ? /is-ready/u : /is-unavailable/u);
      const discoveryVisibleMs = performance.now() - startedAt;
      const shutdownMs = await options.close(run);
      if (scenario === "slow") {
        const pid = Number(readFileSync(marker, "utf8"));
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        let terminalCode: unknown;
        try { process.kill(pid, 0); } catch (error) {
          terminalCode = (error as NodeJS.ErrnoException).code;
        }
        expect(terminalCode).toBe("ESRCH");
      }
      samples.push({
        scenario,
        existingProfile: scenario === "installed-warm",
        firstWindowMs: run.firstWindowMs,
        runtimeInteractiveMs: run.startupMs,
        discoveryVisibleMs,
        shutdownMs,
        providerResult: installedCase ? "ready" : "unavailable",
        cleanupConfirmed: true,
      });
    } finally {
      // The existing benchmark cleanup owner makes close idempotent and also
      // adopts late acquisitions if the outer Playwright deadline wins.
      await options.close(run);
    }
  }
  return {
    outcome: "measured" as const,
    scope: "Credential-free synthetic Codex; global provider-root absence checked before launch; no authenticated upstream requests.",
    discoveryClock: "Main-host elapsed time until settled provider status is visible in Settings, including opening Settings; not internal probe-only latency.",
    slowFixture: "Version probe deliberately never exits; production discovery timeout and owned-process cleanup are unchanged.",
    samples,
  };
}
