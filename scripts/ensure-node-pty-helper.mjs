import { chmod, readdir } from "node:fs/promises";
import { join } from "node:path";

if (process.platform === "darwin") {
  const prebuildsDirectory = join(process.cwd(), "node_modules", "node-pty", "prebuilds");

  try {
    const architectures = await readdir(prebuildsDirectory, { withFileTypes: true });

    await Promise.all(
      architectures
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("darwin-"))
        .map((entry) => chmod(join(prebuildsDirectory, entry.name, "spawn-helper"), 0o755)),
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
  }
}
