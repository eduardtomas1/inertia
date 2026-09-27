// @inertia-test-suite portable
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { composerRouteReadiness } from "../../src/renderer/src/utils/composerReadiness";
import { detectProvider, ProviderManager } from "../../src/server/providers";
import { createProviderInfoRefresh } from "../../src/server/provider/provider-info-refresh";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";
import {
  portableFixtureRoot,
  removePortableFixture,
  waitFor,
  writeNodeFlagExecutable,
} from "../helpers/portable-provider-fixture";

type Stage = "version" | "app-server" | "login";

const PROBE_TIMEOUT_MS = 1_500;

function route(provider: ProviderInfo): ReturnType<typeof composerRouteReadiness> {
  return composerRouteReadiness({
    provider,
    profile: undefined,
    selection: providerNativeModelSelection({ providerId: provider.id }),
  });
}

describe("provider detection timeouts", { concurrent: false }, () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function fakeCodex(
    hangs: Partial<Record<Stage, number>>,
    options: { signedOut?: boolean } = {},
  ): { root: string; command: string; calls(): string[] } {
    const root = portableFixtureRoot("provider detection timeout");
    roots.push(root);
    const plan = join(root, "hangs.json");
    const log = join(root, "calls.log");
    writeFileSync(plan, JSON.stringify(hangs));
    writeFileSync(log, "");
    const command = writeNodeFlagExecutable(root, "codex", `
const fs = require("node:fs");
const args = process.argv.slice(2);
const stage = args[0] === "--version" ? "version"
  : args[0] === "app-server" && args[1] === "--help" ? "app-server"
  : args[0] === "login" && args[1] === "status" ? "login"
  : "other";
fs.appendFileSync(${JSON.stringify(log)}, stage + "\\n");
const hangs = JSON.parse(fs.readFileSync(${JSON.stringify(plan)}, "utf8"));
if ((hangs[stage] ?? 0) !== 0) {
  hangs[stage] -= 1;
  fs.writeFileSync(${JSON.stringify(plan)}, JSON.stringify(hangs));
  setInterval(() => {}, 1_000);
} else if (stage === "version") {
  console.log("codex-cli 0.200.0");
} else if (stage === "app-server") {
  console.log("Usage: codex app-server [OPTIONS] - Run the app server");
} else if (stage === "login" && ${JSON.stringify(options.signedOut === true)}) {
  console.error("Not logged in");
  process.exit(1);
} else if (stage === "login") {
  console.log("Logged in using ChatGPT");
} else {
  process.exit(2);
}
`);
    return {
      root,
      command,
      calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    };
  }

  function harness(
    fake: { root: string; command: string },
    retryDelaysMs: readonly number[] = [20, 20, 20],
    providerId: ProviderInfo["id"] = "codex",
    fakes: Parameters<typeof detectProvider>[2] = {},
  ) {
    const lifetime = new AbortController();
    const requestedTimeouts: number[] = [];
    const manager = ProviderManager.createForTests({
      commands: { [providerId]: fake.command },
      lifetimeSignal: lifetime.signal,
      detectProvider: async (providerId, options, dependencies) => {
        requestedTimeouts.push(options?.timeoutMs ?? 0);
        return await detectProvider(
          providerId,
          { ...options, timeoutMs: PROBE_TIMEOUT_MS },
          { ...dependencies, ...fakes },
        );
      },
    });
    let providerInfo: ProviderInfo[] = initialProviderSnapshots();
    let closed = false;
    const published: ProviderInfo[] = [];
    const refresh = createProviderInfoRefresh({
      enabled: true,
      providers: manager,
      defaultWorkspacePath: fake.root,
      lifetimeSignal: lifetime.signal,
      providerInfo: () => providerInfo,
      replaceProviderInfo: (value) => { providerInfo = value; },
      broadcastSnapshot: () => {
        published.push(structuredClone(providerInfo.find(({ id }) => id === providerId)!));
      },
      isClosed: () => closed,
      track: async (operation) => await operation(),
      onActivityChange: () => undefined,
      detectionRetryDelaysMs: retryDelaysMs,
    });
    return {
      refresh,
      published,
      requestedTimeouts,
      codex: () => providerInfo.find(({ id }) => id === providerId)!,
      close: () => {
        closed = true;
        lifetime.abort(new Error("The runtime is shutting down."));
      },
    };
  }

  for (const stage of ["login", "version", "app-server"] as const) {
    it(`reports a ${stage} probe timeout as checking and becomes ready after a retry`, async () => {
      const fake = fakeCodex({ [stage]: 1 });
      const runtime = harness(fake);

      await runtime.refresh("codex");

      expect(fake.calls().filter((call) => call === stage)).toHaveLength(1);
      const checking = runtime.codex();
      expect(runtime.published).toHaveLength(1);
      expect(checking).toMatchObject({
        authState: "checking",
        canRun: false,
        statusMessage: "Codex is slow to respond; checking again",
      });
      expect(route(checking)).toMatchObject({
        ready: false,
        transient: true,
        badge: "Checking",
        action: null,
      });
      await waitFor("the background retry to reach ready", () => runtime.codex().canRun, 10_000);
      expect(runtime.published.map(route).map((state) => state.ready ? "ready" : state.badge))
        .not.toContain("Sign in");
      expect(runtime.codex()).toMatchObject({
        installState: "installed",
        authState: "authenticated",
        canRun: true,
      });
      expect(route(runtime.codex())).toEqual({ ready: true });
      expect(fake.calls().filter((call) => call === stage)).toHaveLength(2);
      expect(runtime.requestedTimeouts).toEqual([4_000, 4_000]);
    }, 30_000);
  }

  it("stops after bounded sign-in check timeouts without asking the user to sign in", async () => {
    const fake = fakeCodex({ login: -1 });
    const runtime = harness(fake);

    await runtime.refresh("codex");
    expect(fake.calls().filter((call) => call === "login")).toHaveLength(1);
    await waitFor("the bounded retries to finish", () => runtime.codex().authState === "error", 20_000);

    expect(fake.calls().filter((call) => call === "login")).toHaveLength(4);
    expect(runtime.requestedTimeouts).toEqual([4_000, 4_000, 4_000, 4_000]);
    expect(runtime.codex()).toMatchObject({
      installState: "installed",
      authState: "error",
      canRun: false,
      statusMessage: "Codex did not answer the sign-in check in time; refresh to try again",
    });
    expect(route(runtime.codex())).toMatchObject({
      ready: false,
      transient: false,
      badge: "Connection issue",
      action: "refresh",
    });
    expect(runtime.published.map(route).map((state) => state.ready ? "ready" : state.badge))
      .not.toContain("Sign in");
  }, 60_000);

  it("stops after bounded version probe timeouts with an unavailable CLI state", async () => {
    const fake = fakeCodex({ version: -1 });
    const runtime = harness(fake);

    await runtime.refresh("codex");
    expect(fake.calls()).toEqual(["version"]);
    await waitFor("the bounded retries to finish", () => runtime.codex().installState === "unresponsive", 20_000);

    expect(fake.calls()).toEqual(["version", "version", "version", "version"]);
    expect(runtime.codex()).toMatchObject({
      installState: "unresponsive",
      canRun: false,
      statusMessage: "Codex did not respond in time; refresh to try again",
    });
    expect(route(runtime.codex())).toMatchObject({
      ready: false,
      transient: false,
      badge: "Unavailable",
      title: "Codex harness is not responding",
      action: "refresh",
    });
    const titles = runtime.published.map((provider) => {
      const state = route(provider);
      return state.ready ? "ready" : `${state.badge} ${state.title}`;
    });
    expect(titles.some((title) => /Sign in|missing|not found|could not start/u.test(title))).toBe(false);
  }, 60_000);

  it("keeps a definite signed-out answer as Sign in without retrying", async () => {
    const fake = fakeCodex({}, { signedOut: true });
    const runtime = harness(fake);

    await runtime.refresh("codex");
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fake.calls()).toEqual(["version", "app-server", "login"]);
    expect(runtime.requestedTimeouts).toEqual([4_000]);
    expect(runtime.codex()).toMatchObject({
      installState: "installed",
      authState: "unauthenticated",
      canRun: false,
      statusMessage: "Sign in required",
    });
    expect(route(runtime.codex())).toMatchObject({ badge: "Sign in", action: "connect" });
  }, 30_000);

  it("classifies timeouts for other providers and keeps Kimi's runtime sign-in", async () => {
    const root = portableFixtureRoot("provider detection timeout classification");
    roots.push(root);
    const timedOut = { started: true, timedOut: true, cleanupConfirmed: true, exitCode: null, output: "" };
    const answered = (output: string) => ({
      started: true, timedOut: false, cleanupConfirmed: true, exitCode: 0, output,
    });
    const detect = async (
      providerId: "claude" | "cursor" | "kimi",
      respond: (args: readonly string[]) => ReturnType<typeof answered> | typeof timedOut,
    ) => await detectProvider(providerId, { command: join(root, providerId), cwd: root }, {
      executableCandidates: async () => [join(root, providerId)],
      probeProcess: async (_executable, args) => respond(args),
    });

    await expect(detect("claude", (args) => (
      args[0] === "--version" ? answered("2.1.0 (Claude Code)") : timedOut
    ))).resolves.toMatchObject({
      installState: "installed",
      authState: "error",
      canRun: false,
      probeTimedOut: true,
      statusMessage: "Claude did not answer the sign-in check in time; refresh to try again",
    });
    await expect(detect("cursor", (args) => (
      args.includes("acp") ? timedOut : answered("cursor-agent 2026.09.01")
    ))).resolves.toMatchObject({
      installState: "unresponsive",
      canRun: false,
      probeTimedOut: true,
    });
    const kimi = await detect("kimi", (args) => (
      args[0] === "--version" ? answered("kimi 1.0.0")
        : args[0] === "acp" ? answered("kimi acp: Agent Client Protocol server")
          : timedOut
    ));
    expect(kimi).toMatchObject({ installState: "installed", authState: "unknown", canRun: true });
    expect(kimi.probeTimedOut).toBeUndefined();
  });

  it("retries an OpenCode isolation proof timeout instead of asking for an update", async () => {
    const root = portableFixtureRoot("opencode isolation timeout");
    roots.push(root);
    const executable = join(root, "opencode");
    const proofs: string[] = [];
    const runtime = harness({ root, command: executable }, [20, 20, 20], "opencode", {
      executableCandidates: async () => [executable],
      probeOpenCodePureIsolation: async () => {
        const outcome = proofs.length === 0 ? "timed-out" as const : "verified" as const;
        proofs.push(outcome);
        return { cleanupConfirmed: true, outcome };
      },
      probeProcess: async (_candidate, args) => ({
        started: true,
        timedOut: false,
        cleanupConfirmed: true,
        exitCode: 0,
        output: args[0] === "--version" ? "opencode 1.18.26"
          : args[0] === "serve" ? "--pure run without external plugins"
            : "Credentials\n0 credentials",
      }),
    });

    await runtime.refresh("opencode");
    expect(runtime.codex()).toMatchObject({
      installState: "checking",
      authState: "checking",
      canRun: false,
      statusMessage: "OpenCode is slow to respond; checking again",
    });
    expect(route(runtime.codex())).toMatchObject({ badge: "Checking", action: null, transient: true });
    await waitFor("the isolation proof retry", () => proofs.length === 2 && runtime.published.length === 2, 10_000);

    expect(proofs).toEqual(["timed-out", "verified"]);
    expect(runtime.codex()).toMatchObject({
      installState: "installed",
      authState: "unknown",
      statusMessage: "Installed; connection not confirmed",
    });
    expect(runtime.published.map(({ statusMessage }) => statusMessage).join("\n")).not.toMatch(/update/iu);
    runtime.close();
  }, 30_000);

  it("cancels a pending retry on shutdown without probing again", async () => {
    const fake = fakeCodex({ login: 1 });
    const runtime = harness(fake, [60_000]);

    await runtime.refresh("codex");
    const callsBeforeShutdown = fake.calls();
    runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fake.calls()).toEqual(callsBeforeShutdown);
    expect(runtime.requestedTimeouts).toEqual([4_000]);
    expect(runtime.published).toHaveLength(1);
    expect(runtime.codex()).toMatchObject({
      authState: "checking",
      statusMessage: "Codex is slow to respond; checking again",
    });
  }, 30_000);
});
