import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { exportDiagnosticReport } from "../../src/main/diagnostic-export";
import { DIAGNOSTIC_LIMITS } from "../../src/shared/application-diagnostics";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "inertia-diagnostic-export-")); roots.push(root); return root; }

it("writes main-generated JSON atomically to the selected file, with private permissions and no staging leftovers", async () => {
  const root = await fixture(); const path = join(root, "report.json");
  await writeFile(path, "previous report");
  await expect(exportDiagnosticReport('{"records":[]}', async () => path)).resolves.toEqual({ status: "exported" });
  expect(await readFile(path, "utf8")).toBe('{"records":[]}');
  expect(await readdir(root)).toEqual(["report.json"]);
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("treats picker cancellation as cancellation, bounds content before opening the picker, and preserves an unwritable target", async () => {
  const choosePath = vi.fn(async () => null);
  await expect(exportDiagnosticReport("{}", choosePath)).resolves.toEqual({ status: "cancelled" });
  await expect(exportDiagnosticReport("x".repeat(DIAGNOSTIC_LIMITS.exportBytes + 1), choosePath)).rejects.toThrow("size limit");
  expect(choosePath).toHaveBeenCalledOnce();
  const root = await fixture();
  await expect(exportDiagnosticReport("{}", async () => root)).rejects.toThrow("regular file");
  expect(await readdir(root)).toEqual([]);
});

it.skipIf(process.platform === "win32")("refuses a symbolic-link destination without touching its target", async () => {
  const root = await fixture(); const target = join(root, "keep.json"); const link = join(root, "link.json");
  await writeFile(target, "keep unchanged"); await symlink(target, link);
  await expect(exportDiagnosticReport("{}", async () => link)).rejects.toThrow("not a link");
  expect(await readFile(target, "utf8")).toBe("keep unchanged");
});
