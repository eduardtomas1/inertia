import type { DesktopWindowContext } from "../shared/desktop.js";

function exactRestartRequest(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.keys(value).length === 1
    && (value as { restart?: unknown }).restart === true;
}

export function applyRuntimeConnectionRequest(
  args: readonly unknown[],
  role: DesktopWindowContext["role"],
  supervisor: { restartFromUser(): boolean } | null,
): void {
  if (args.length === 0) return;
  if (args.length !== 1 || role !== "main" || !exactRestartRequest(args[0])) {
    throw new Error("Rejected invalid runtime connection request");
  }
  supervisor?.restartFromUser();
}
