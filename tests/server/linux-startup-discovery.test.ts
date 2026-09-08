import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as environment from "../../src/server/environment";
import * as ownership from "../../src/node/runtime-owned-processes";
import * as linuxGuardian from "../../src/node/runtime-owned-process-linux";
import { detectProvider, detectProviders } from "../../src/server/provider/discovery";
import { withCodexControlClient } from "../../src/server/codex/control-client";
import { runGitInspection } from "../../src/server/git/runner";
import { activatePreparedRuntimeOwnedProcessRegistry } from "../helpers/prepared-runtime-owned-process-registry";

const linuxIt = process.platform === "linux" ? it : it.skip;

linuxIt.each(["provider", "git"] as const)("waits for %s claim retirement before publishing a probe result", async (probe) => {
  const root = mkdtempSync(join(tmpdir(), "inertia-probe-retirement-"));
  const guardian = join(process.cwd(), "resources/generated/runtime-process-guardian/runtime-process-guardian");
  const fixture = join(root, "provider");
  writeFileSync(fixture, "#!/bin/sh\nprintf 'fixture 1.0.0\\n'\n", { mode: 0o700 });
  const env = { PATH: "/usr/bin:/bin", HOME: root };
  execFileSync("git", ["init", "--quiet", root], { env });
  vi.spyOn(environment, "providerEnvironment").mockResolvedValue({ env, pathEntries: ["/usr/bin", "/bin"] });
  let deliverExec!: () => void;
  const delivery = new Promise<void>((resolve) => { deliverExec = resolve; });
  let observedClose!: () => void;
  const closed = new Promise<void>((resolve) => { observedClose = resolve; });
  let child: ChildProcess | undefined;
  const spawnOwned = ownership.spawnRuntimeOwnedProcess;
  vi.spyOn(ownership, "spawnRuntimeOwnedProcess").mockImplementation((spawn, kind) => {
    child = spawnOwned(spawn, kind);
    child.once("close", observedClose);
    return child;
  });
  const signal = linuxGuardian.signalLinuxGuardianExactAsync;
  vi.spyOn(linuxGuardian, "signalLinuxGuardianExactAsync").mockImplementation(async (...args) => {
    const result = await signal(...args);
    if (args[2] === "exec") await delivery;
    return result;
  });
  const generation = "63000000-0000-4000-8000-000000000063:1";
  const deactivate = activatePreparedRuntimeOwnedProcessRegistry(root, generation,
    "test:64000000-0000-4000-8000-000000000064", { platform: "linux", darwinGuardianPath: guardian });
  let operation: Promise<unknown> | undefined;
  try {
    let settled = false;
    operation = (probe === "provider"
      ? detectProvider("claude", { command: fixture, cwd: root, probeAuthentication: false })
      : runGitInspection(root, ["rev-parse", "--git-dir"], { failureMessage: "Fixture discovery failed." }))
      .finally(() => { settled = true; });
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(ownership.runtimeOwnedProcessCleanupConfirmed()).toBe(false);
    deliverExec();
    await operation;
    expect(ownership.runtimeOwnedProcessCleanupConfirmed()).toBe(true);
    expect(new ownership.RuntimeOwnedProcessJournal(root).records(generation)).toEqual([]);
    expect(ownership.runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
  } finally {
    deliverExec();
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await operation?.catch(() => undefined);
    deactivate?.();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

linuxIt("retires concurrent startup discovery before returning under delayed native callbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "inertia-startup-fanout-"));
  const guardian = join(process.cwd(), "resources/generated/runtime-process-guardian/runtime-process-guardian");
  const generation = "61000000-0000-4000-8000-000000000061:1";
  const fixture = join(root, "provider");
  const env = { PATH: "/usr/bin:/bin", HOME: root };
  execFileSync("git", ["init", "--quiet", root], { env });
  writeFileSync(fixture, `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('fixture 0.153.4');
else if (args.includes('--help')) console.log('Codex app-server');
else if (args[0] === 'login') console.log('Logged in using ChatGPT');
else if (args[0] === 'auth') console.log(JSON.stringify({ loggedIn: true }));
else {
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf('\\n');
      if (end < 0) break;
      const request = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      if (request.id === undefined) continue;
      process.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }) + '\\n', () => {
        if (request.method === 'account/read') process.exit(0);
      });
    }
  });
}
`, { mode: 0o700 });
  vi.spyOn(environment, "providerEnvironment").mockResolvedValue({ env, pathEntries: ["/usr/bin", "/bin"] });
  const children: ChildProcess[] = [];
  const closes = new Map<number, Promise<void>>();
  const probes: Array<string | undefined> = [];
  const spawnOwned = ownership.spawnRuntimeOwnedProcess;
  vi.spyOn(ownership, "spawnRuntimeOwnedProcess").mockImplementation((spawn, probe) => {
    const child = spawnOwned(spawn, probe);
    children.push(child);
    probes.push(probe);
    closes.set(child.pid!, new Promise<void>((resolve) => child.once("close", () => resolve())));
    return child;
  });
  const signal = linuxGuardian.signalLinuxGuardianExactAsync;
  let delayedCallbacks = 0;
  vi.spyOn(linuxGuardian, "signalLinuxGuardianExactAsync").mockImplementation(async (...args) => {
    const result = await signal(...args);
    if (args[2] === "exec") {
      // Withhold native acknowledgment until the real child-close boundary.
      await closes.get(args[0].pid);
      delayedCallbacks += 1;
    }
    return result;
  });
  const onTainted = vi.fn();
  const deactivate = activatePreparedRuntimeOwnedProcessRegistry(
    root, generation, "test:62000000-0000-4000-8000-000000000062",
    { platform: "linux", darwinGuardianPath: guardian, onTainted },
  );
  try {
    expect(linuxGuardian.verifyLinuxRuntimeOwnedGuardianSandbox(guardian)).not.toBeNull();
    const results = await Promise.allSettled([
      detectProviders({
        codex: { command: fixture, cwd: root },
        claude: { command: fixture, cwd: root },
        cursor: { command: join(root, "absent-cursor"), cwd: root },
        gemini: { command: join(root, "absent-gemini"), cwd: root },
        kimi: { command: join(root, "absent-kimi"), cwd: root },
        opencode: { command: join(root, "absent-opencode"), cwd: root },
      }),
      withCodexControlClient({ executable: fixture, cwd: root, environment: env },
        async ({ request }) => await request("account/read")),
      ...["--show-toplevel", "--git-dir", "--is-inside-work-tree"].map((arg) =>
        runGitInspection(root, ["rev-parse", arg], { failureMessage: "Fixture Git discovery failed." })),
    ]);
    expect(results.map(({ status }) => status)).toEqual(Array(5).fill("fulfilled"));
    if (results[0]?.status === "fulfilled") {
      expect(results[0].value).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: expect.objectContaining({ id: "codex" }), canRun: true, cleanupConfirmed: true }),
        expect.objectContaining({ provider: expect.objectContaining({ id: "claude" }), canRun: true, cleanupConfirmed: true }),
      ]));
    }
    expect(delayedCallbacks).toBeGreaterThanOrEqual(9);
    expect(probes).toEqual(expect.arrayContaining(["provider-version", "provider-auth", "provider-capability", "codex-control", "git"]));
    expect(ownership.runtimeOwnedProcessCleanupConfirmed()).toBe(true);
    expect(new ownership.RuntimeOwnedProcessJournal(root).records(generation)).toEqual([]);
    expect(ownership.runtimeOwnedProcessOwnershipIsTainted()).toBe(false);
    expect(onTainted).not.toHaveBeenCalled();
    expect(children.every((child) => child.exitCode !== null && child.signalCode === null)).toBe(true);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(closes.values());
    deactivate?.();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
