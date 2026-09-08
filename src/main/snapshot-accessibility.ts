import { SNAPSHOT_MAX_NODES, SNAPSHOT_MAX_TEXT, type SnapshotNode, type SnapshotRect } from "../shared/snapshots.js";

export interface SnapshotElement {
  role: string; name: string | null; value: string | null;
  bounds: SnapshotRect | null; raw: Record<string, unknown>;
  children(): Promise<SnapshotElement[]>;
}

/** Do not copy raw platform dictionaries: they can repeat protected values. */
export async function readSnapshotAccessibility(root: SnapshotElement, shouldContinue: () => boolean): Promise<{
  nodes: SnapshotNode[]; redactions: SnapshotRect[]; truncated: boolean; complete: boolean;
}> {
  const nodes: SnapshotNode[] = [];
  const redactions: SnapshotRect[] = [];
  let remaining = SNAPSHOT_MAX_TEXT;
  let truncated = false;
  let complete = true;
  let visited = 0;
  const text = (value: string | null, limit: number): string | undefined => {
    if (!value) return undefined;
    const safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, "").slice(0, Math.min(limit, remaining));
    remaining -= safe.length;
    if (safe.length < value.length) truncated = true;
    return safe || undefined;
  };
  const visit = async (element: SnapshotElement, depth: number): Promise<void> => {
    if (!shouldContinue() || visited >= 4096 || depth > 16) { truncated = true; complete = false; return; }
    visited += 1;
    if (element.bounds && (!Object.values(element.bounds).every(Number.isFinite)
      || element.bounds.width < 0 || element.bounds.height < 0)) {
      throw new Error("A field could not be located safely.");
    }
    const role = element.role.slice(0, 80);
    // UIA does not expose IsPassword through xa11y's public snapshot API.
    // Mask all editable controls on every platform, including their descendants.
    const protectedField = /text_field|text_area|password|secure|entry|editable/iu.test(role)
      || /password|secure/iu.test(String(element.raw.ax_subrole ?? element.raw.atspi_role ?? ""))
      || /password|passcode|api[ _-]?key|access[ _-]?token|secret[ _-]?key/iu.test(element.name ?? "");
    if (protectedField) {
      if (element.bounds) redactions.push(element.bounds);
      else throw new Error("A protected field could not be located safely.");
      if (nodes.length < SNAPSHOT_MAX_NODES) nodes.push({ depth, role, redacted: true, bounds: element.bounds });
      else truncated = true;
      return;
    }
    if (nodes.length < SNAPSHOT_MAX_NODES && remaining > 0) {
      const name = text(element.name, 1000);
      const value = text(element.value, 2000);
      nodes.push({ depth, role, ...(name ? { name } : {}), ...(value ? { value } : {}), ...(element.bounds ? { bounds: element.bounds } : {}) });
    } else truncated = true;
    const children = await element.children();
    for (const child of children) {
      if (!shouldContinue() || visited >= 4096) { truncated = true; complete = false; break; }
      await visit(child, depth + 1);
    }
  };
  await visit(root, 0);
  return { nodes, redactions, truncated, complete };
}
