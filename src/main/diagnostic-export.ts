import { lstat, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { DIAGNOSTIC_LIMITS } from "../shared/application-diagnostics.js";

/** Only main-generated, allowlisted JSON reaches this writer. The renderer can
 * choose filters, never the destination or file contents. Browser downloads
 * remain disabled by the desktop session policy. */
export async function exportDiagnosticReport(
  report: string,
  choosePath: () => Promise<string | null>,
): Promise<{ status: "exported" | "cancelled" }> {
  if (Buffer.byteLength(report) > DIAGNOSTIC_LIMITS.exportBytes) throw new Error("Diagnostics export exceeds its size limit.");
  const selected = await choosePath();
  if (selected === null) return { status: "cancelled" };
  if (!isAbsolute(selected)) throw new Error("Choose an absolute diagnostics export path.");
  const parent = await realpath(dirname(selected));
  const target = join(parent, basename(selected));
  const previous = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous && (!previous.isFile() || previous.isSymbolicLink() || previous.nlink !== 1)) {
    throw new Error("Choose a regular file for diagnostics export, not a link or directory.");
  }
  const staging = await mkdtemp(join(parent, ".inertia-diagnostics-"));
  const temporary = join(staging, "report.json");
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(report, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    // Replace the directory entry atomically; never truncate/follow a target link.
    await rename(temporary, target);
    return { status: "exported" };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
