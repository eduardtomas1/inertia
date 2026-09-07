import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

// Bundle the production policy itself: no separate, weaker canary allowlist
// and no dependency on Node's version-sensitive TypeScript loader behavior.
export async function stageKimiTerminalAuthPolicy(scriptsDirectory, workspace) {
  const outfile = join(workspace, "kimi-terminal-auth-policy.mjs");
  await build({
    entryPoints: [join(scriptsDirectory, "..", "src", "server", "provider", "acp-terminal-auth.ts")],
    outfile, bundle: true, format: "esm", platform: "node", target: "node22",
  });
  return outfile;
}

// Keep the runtime's local import closure together: the isolated workspace has
// its own SDK install and must not resolve cleanup helpers from this checkout.
export async function stageOpenCodeRuntime(scriptsDirectory, workspace) {
  const modules = [
    "provider-drift-opencode-runtime.mjs",
    "provider-drift-process.mjs",
    "bounded-process-tree.mjs",
    "linux-process-group.mjs",
  ];
  await Promise.all(modules.map((name) => copyFile(
    join(scriptsDirectory, name),
    join(workspace, name),
  )));
  return join(workspace, modules[0]);
}
