// @inertia-test-suite portable
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

import type { ProcessTreeTerminator } from "../../src/server/process-lifecycle";
import { CappedProviderBuffer } from "../../src/server/provider/io";
import { startOwnedOpenCodeServer } from "../../src/server/provider/opencode-owned-server";
import {
  portableFixtureRoot,
  portableNodeExecutable,
  removePortableFixture,
  writeNodeSubcommand,
} from "../helpers/portable-provider-fixture";

function closed(child: ChildProcess): boolean {
  return (child.exitCode !== null || child.signalCode !== null)
    && child.stdio.every((stream) => stream === null || stream === undefined || stream.closed);
}

describe("OpenCode owned server self-exit", () => {
  const roots: string[] = [];
  afterEach(async () => await Promise.all(roots.splice(0).map(removePortableFixture)));

  it("confirms a Windows server that exited on its own only after its handles close", async () => {
    const root = portableFixtureRoot("OpenCode self exit");
    roots.push(root);
    const executable = portableNodeExecutable(root, "opencode");
    writeNodeSubcommand(root, "serve", `
const http = require("node:http");
const { spawn } = require("node:child_process");
const server = http.createServer(() => undefined);
server.listen(0, "127.0.0.1", () => {
  console.log("opencode server listening on http://127.0.0.1:" + server.address().port);
  spawn(process.execPath, ["-e", "setTimeout(() => undefined, 300)"], { stdio: ["ignore", "inherit", "inherit"] });
  setTimeout(() => process.exit(3), 50);
});
`);
    const observedClosed: boolean[] = [];
    const windowsTerminator: ProcessTreeTerminator = async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "close");
        return true;
      }
      observedClosed.push(closed(child));
      return closed(child);
    };

    const started = await startOwnedOpenCodeServer(
      executable,
      root,
      process.env,
      new CappedProviderBuffer(4_096),
      windowsTerminator,
      "OpenCode self-exit fixture",
      undefined,
      true,
      "win32",
    );
    await once(started.child, "exit");

    await expect(started.terminate(true)).resolves.toBeUndefined();
    expect(observedClosed).toEqual([true]);
  });
});
