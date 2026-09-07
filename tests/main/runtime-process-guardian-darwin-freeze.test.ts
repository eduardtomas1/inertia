import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe.runIf(process.platform === "darwin")("Darwin guardian freeze exit race", () => {
  let directory = "";
  let fixture = "";

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "inertia-darwin-freeze-"));
    fixture = join(directory, "freeze-race");
    const built = spawnSync("/usr/bin/xcrun", [
      "clang", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      join(process.cwd(), "tests/fixtures/darwin-guardian-freeze-race.c"),
      "-o", fixture,
    ], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      shell: false,
      timeout: 30_000,
    });
    expect(built.status, `${built.stderr}\n${built.stdout}`).toBe(0);
  });

  afterAll(() => {
    if (directory) rmSync(directory, { force: true, recursive: true });
  });

  function run(scenario: string): Record<string, unknown> {
    const result = spawnSync(fixture, [scenario], {
      encoding: "utf8", shell: false, timeout: 5_000,
    });
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  it("retries an interrupted fork observation without tainting an empty queue", () => {
    expect(run("observer-empty")).toMatchObject({
      forkTainted: 0,
      observerCalls: 2,
      observer: "none",
    });
  });

  it.each(["fork", "event-error", "hard-error"])(
    "retains %s proof failure after an interrupted fork observation",
    (outcome) => {
      expect(run(`observer-${outcome}`)).toMatchObject({
        forkTainted: 1,
        observerCalls: 2,
        observer: outcome === "fork" ? "note-fork" : outcome === "hard-error" ? "syscall-error" : "event-error",
      });
    },
  );

  it("taints fork observation when interruptions exhaust the existing pass budget", () => {
    expect(run("observer-eintr-exhausted")).toMatchObject({
      forkTainted: 1,
      observerCalls: 16,
      observer: "retry-budget",
    });
  });

  it("rebuilds the full ownership census when its selected direct child exits before SIGSTOP", () => {
    expect(run("direct-exit")).toMatchObject({
      cleaned: 1,
      census: "none",
      identityReads: 2,
      zombieObserved: 1,
      zombieLibprocBytes: 0,
      stopSignalsDelivered: 0,
      members: 0,
    });
  });

  it("still drains another owned member after reaping the exiting child", () => {
    expect(run("direct-exit-with-survivor")).toMatchObject({
      cleaned: 1,
      zombieObserved: 1,
      members: 0,
      survivorReaped: 1,
    });
  });

  it.each(["live-unreadable", "changed-birth", "signal-refused"])(
    "keeps %s proof failure closed without signaling the unresolved member",
    (scenario) => {
      expect(run(scenario)).toMatchObject({
        cleaned: 0,
        phase: "freeze-stop-signal",
        census: "none",
        zombieObserved: 0,
        stopSignalsDelivered: 0,
        members: 1,
      });
    },
  );

  it("retains fork taint after positively reaping the census-selected child", () => {
    expect(run("fork-tainted-exit")).toMatchObject({
      cleaned: 0,
      phase: "term-fork-taint",
      zombieObserved: 1,
      members: 0,
      forkTainted: 1,
    });
  });

  it("keeps an unreadable non-child zombie fail closed without trying to reap it", () => {
    expect(run("non-child-exit")).toMatchObject({
      cleaned: 0,
      phase: "freeze-stop-signal",
      zombieObserved: 1,
      stopSignalsDelivered: 0,
      members: 2,
      nonChildZombieRetained: 1,
      nonChildWaitAttempts: 0,
    });
  });
});
