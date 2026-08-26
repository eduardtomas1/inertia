import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeSystemSuspendTracker } from "../../src/main/runtime-system-suspend-tracker";

const directories: string[] = [];

function statePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-system-suspend-"));
  directories.push(directory);
  return join(directory, "runtime-system-suspends.json");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RuntimeSystemSuspendTracker", () => {
  it("retains one completed interval and ignores duplicate suspend signals", () => {
    const tracker = new RuntimeSystemSuspendTracker();
    tracker.suspend("2026-08-25T12:15:39.000Z");
    tracker.suspend("2026-08-25T12:16:00.000Z");

    expect(tracker.resume("2026-08-26T05:10:02.000Z")).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      suspendedAt: "2026-08-25T12:15:39.000Z",
      resumedAt: "2026-08-26T05:10:02.000Z",
    });
    expect(tracker.resume("2026-08-26T05:11:00.000Z")).toBeNull();
    expect(tracker.completed()).toHaveLength(1);
  });

  it("keeps completed intervals chronological across backward wall-clock corrections", () => {
    const tracker = new RuntimeSystemSuspendTracker();
    tracker.suspend("2026-08-25T12:15:39.000Z");
    tracker.resume("2026-08-25T12:20:00.000Z");

    tracker.suspend("2026-08-25T12:10:00.000Z");
    expect(tracker.resume("2026-08-25T12:12:00.000Z")).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      suspendedAt: "2026-08-25T12:20:00.000Z",
      resumedAt: "2026-08-25T12:20:00.000Z",
    });
  });

  it("recovers an unfinished suspend after restart and replays it until acknowledged", () => {
    const path = statePath();
    const first = new RuntimeSystemSuspendTracker({ statePath: path });
    first.suspend("2026-08-25T12:15:39.000Z");
    const active = JSON.parse(readFileSync(path, "utf8")) as {
      active: { id: string };
    };

    const recovered = new RuntimeSystemSuspendTracker({
      statePath: path,
      recoveredAt: "2026-08-26T05:10:02.000Z",
    });
    expect(recovered.completed()).toEqual([{
      id: active.active.id,
      suspendedAt: "2026-08-25T12:15:39.000Z",
      resumedAt: "2026-08-26T05:10:02.000Z",
    }]);
    expect(new RuntimeSystemSuspendTracker({
      statePath: path,
      recoveredAt: "2026-08-26T06:00:00.000Z",
    }).completed()).toEqual(recovered.completed());

    expect(recovered.acknowledge(active.active.id)).toBeNull();
    expect(new RuntimeSystemSuspendTracker({ statePath: path }).completed())
      .toEqual([]);
  });

  it("clamps a recovered boundary when the wall clock moved backward", () => {
    const path = statePath();
    const first = new RuntimeSystemSuspendTracker({ statePath: path });
    first.suspend("2026-08-26T05:10:02.000Z");

    expect(new RuntimeSystemSuspendTracker({
      statePath: path,
      recoveredAt: "2026-08-25T12:15:39.000Z",
    }).completed()).toEqual([{
      id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      suspendedAt: "2026-08-26T05:10:02.000Z",
      resumedAt: "2026-08-26T05:10:02.000Z",
    }]);
  });

  it("never evicts unacknowledged intervals when pending capacity is full", () => {
    const path = statePath();
    const diagnostics = vi.fn();
    const tracker = new RuntimeSystemSuspendTracker({
      statePath: path,
      onDiagnostic: diagnostics,
    });
    const origin = Date.parse("2026-08-25T00:00:00.000Z");
    for (let index = 0; index < 64; index += 1) {
      tracker.suspend(new Date(origin + index * 2_000).toISOString());
      expect(tracker.resume(new Date(origin + index * 2_000 + 1_000)
        .toISOString())).not.toBeNull();
    }
    const retained = tracker.completed();
    tracker.suspend(new Date(origin + 128_000).toISOString());
    expect(tracker.resume(new Date(origin + 129_000).toISOString())).toBeNull();
    expect(tracker.completed()).toEqual(retained);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      message: "System suspend accounting is waiting for runtime acknowledgements.",
    }));

    const reloaded = new RuntimeSystemSuspendTracker({
      statePath: path,
      recoveredAt: new Date(origin + 1_000_000).toISOString(),
      onDiagnostic: diagnostics,
    });
    expect(reloaded.completed()).toEqual(retained);
    const released = reloaded.acknowledge(retained[0].id);
    expect(released).toMatchObject({
      suspendedAt: new Date(origin + 128_000).toISOString(),
      resumedAt: new Date(origin + 129_000).toISOString(),
    });
    expect(reloaded.completed()).toHaveLength(64);
    expect(reloaded.completed()).not.toContainEqual(retained[0]);
    expect(reloaded.completed()).toContainEqual(released);
  });

  it("rejects bounded malformed durable state without fabricating an interval", () => {
    const path = statePath();
    writeFileSync(path, JSON.stringify({
      version: 1,
      active: {
        id: "not-a-uuid",
        suspendedAt: "2026-08-25T12:15:39.000Z",
        resumedAt: null,
      },
      intervals: [],
    }));
    const diagnostic = vi.fn();

    expect(new RuntimeSystemSuspendTracker({
      statePath: path,
      recoveredAt: "2026-08-26T05:10:02.000Z",
      onDiagnostic: diagnostic,
    }).completed()).toEqual([]);
    expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({
      message: "The persisted system suspend state is invalid.",
    }));
  });

  it.runIf(process.platform !== "win32")(
    "persists the app-owned journal with mode 0600",
    () => {
      const path = statePath();
      new RuntimeSystemSuspendTracker({ statePath: path })
        .suspend("2026-08-25T12:15:39.000Z");

      expect(lstatSync(path).isFile()).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0o600);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects an unsafe journal and never sends an interval it could not persist",
    () => {
      const path = statePath();
      const destination = join(path, "..", "outside.json");
      writeFileSync(destination, "outside");
      symlinkSync(destination, path);
      const diagnostic = vi.fn();
      const tracker = new RuntimeSystemSuspendTracker({
        statePath: path,
        onDiagnostic: diagnostic,
      });

      tracker.suspend("2026-08-25T12:15:39.000Z");
      expect(tracker.resume("2026-08-25T12:20:00.000Z")).toBeNull();
      expect(tracker.completed()).toEqual([]);
      expect(readFileSync(destination, "utf8")).toBe("outside");
      expect(diagnostic).toHaveBeenCalled();
    },
  );
});
