import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NativeDesktopUnavailable, withNativeDesktopSession } from "./native-desktop-session";

// argv: <electron binary> <fixture folder>
const root = fileURLToPath(new URL(".", import.meta.url));
const [electron, fixture] = process.argv.slice(2);
try {
  await withNativeDesktopSession(async () => {
    // The harness process plays Inertia's main and runtime; the fixture it
    // launches gets --no-sandbox only when it runs as root.
    const child = spawn(electron!, ["--no-sandbox", join(root, "main.mjs"), `--user-data-dir=${join(root, "inertia-profile")}`, `--fixture=${fixture}`, `--app-electron=${electron}`], {
      shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_AT_BRIDGE: "0", ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, APPIMAGE: undefined, APPDIR: undefined },
    });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
    try { assert.equal(await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), 0); }
    finally { clearTimeout(timer); }
  });
} catch (error) {
  if (!(error instanceof NativeDesktopUnavailable)) throw error;
  console.log("NATIVE_APP_SKIP at-spi-unavailable");
}
