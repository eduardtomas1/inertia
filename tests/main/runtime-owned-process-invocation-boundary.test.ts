import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runtimeOwnedProcessInvocation,
} from "../../src/node/runtime-owned-processes";
import { activatePreparedRuntimeOwnedProcessRegistry as activateRuntimeOwnedProcessRegistry } from
  "../helpers/prepared-runtime-owned-process-registry";
import { runtimeOwnedTerminalSessionPtyInvocation } from "../../src/node/runtime-owned-pty-invocation";

describe("runtime-owned process invocation boundary", () => {
  it("keeps provider processes strict while terminal shells own only their session", () => {
    const directory = mkdtempSync(join(tmpdir(), "inertia-invocation-boundary-"));
    const guardianPath = "/trusted/runtime-process-guardian";
    const deactivate = activateRuntimeOwnedProcessRegistry(
      directory,
      "20000000-0000-4000-8000-000000000002:1",
      "test:10000000-0000-4000-8000-000000000001",
      { platform: "darwin", darwinGuardianPath: guardianPath },
    );

    try {
      expect(runtimeOwnedTerminalSessionPtyInvocation("/bin/zsh", ["-l"])).toEqual({
        command: guardianPath,
        args: [
          "watch-terminal-session",
          String(process.pid),
          "--",
          "/bin/zsh",
          "-l",
        ],
      });
      expect(runtimeOwnedProcessInvocation("/provider", [])).toEqual({
        command: guardianPath,
        args: ["watch", String(process.pid), "--", "/provider"],
      });
    } finally {
      deactivate?.();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
