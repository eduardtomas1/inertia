import { MAX_AGENT_BROWSER_TEXT_BYTES } from "../../shared/agent-browser";

const MAX_ELEMENTS = 200;
const MAX_ISSUE_REFS = 24;
const MIN_TARGET_SIZE = 24;
const INTERACTIVE_ROLES = new Set([
  "button", "checkbox", "combobox", "input", "link", "menuitem",
  "menuitemcheckbox", "menuitemradio", "option", "radio", "searchbox",
  "select", "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
]);
const WEAK_NAME_SOURCES = new Set(["none", "placeholder", "value"]);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface AuditedElement {
  ref: string;
  role: string;
  name: string;
  nameSource: string | null;
  actionable: boolean;
  editable: boolean;
  disabled: boolean;
  rect: Rect;
}

interface AuditIssue {
  code:
    | "clipped-control"
    | "missing-stable-name"
    | "overlapping-controls"
    | "small-target";
  severity: "error" | "warning";
  count: number;
  refs: string[];
  explanation: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeElement(value: unknown): AuditedElement | null {
  const element = record(value);
  const rect = record(element?.rect);
  const x = finite(rect?.x);
  const y = finite(rect?.y);
  const width = finite(rect?.width);
  const height = finite(rect?.height);
  if (
    !element
    || typeof element.ref !== "string"
    || !/^[A-Za-z0-9_-]{1,64}$/u.test(element.ref)
    || typeof element.role !== "string"
    || element.role.length > 50
    || typeof element.name !== "string"
    || element.name.length > 300
    || typeof element.disabled !== "boolean"
    || x === null
    || y === null
    || width === null
    || height === null
    || width <= 0
    || height <= 0
    || !Number.isFinite(x + width)
    || !Number.isFinite(y + height)
    || x + width <= x
    || y + height <= y
  ) return null;
  return {
    ref: element.ref,
    role: element.role,
    name: element.name,
    nameSource: typeof element.nameSource === "string"
      && /^[a-z-]{1,30}$/u.test(element.nameSource)
      ? element.nameSource
      : null,
    actionable: element.actionable === true,
    editable: element.editable === true,
    disabled: element.disabled,
    rect: { x, y, width, height },
  };
}

function intersects(left: Rect, right: Rect): boolean {
  const width = Math.min(left.x + left.width, right.x + right.width)
    - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height)
    - Math.max(left.y, right.y);
  if (width <= 0 || height <= 0) return false;
  const leftRatio = (width / left.width) * (height / left.height);
  const rightRatio = (width / right.width) * (height / right.height);
  return Math.max(leftRatio, rightRatio) >= 0.5;
}

function issue(
  code: AuditIssue["code"],
  severity: AuditIssue["severity"],
  refs: readonly string[],
  count: number,
  explanation: string,
): AuditIssue | null {
  if (count === 0) return null;
  return {
    code,
    severity,
    count,
    refs: [...new Set(refs)].slice(0, MAX_ISSUE_REFS),
    explanation,
  };
}

function boundedSnapshot(snapshot: Record<string, unknown>): string {
  let serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_AGENT_BROWSER_TEXT_BYTES) {
    return serialized;
  }
  snapshot.truncated = true;
  if (typeof snapshot.text === "string") snapshot.text = snapshot.text.slice(0, 4_000);
  const audit = record(snapshot.inertiaAudit);
  if (audit) {
    const issues = Array.isArray(audit.issues) ? audit.issues : [];
    audit.issues = issues.map((value) => {
      const candidate = record(value);
      return candidate ? { ...candidate, refs: [] } : value;
    });
  }
  const elements = Array.isArray(snapshot.elements) ? snapshot.elements : [];
  let low = 0;
  let high = elements.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    snapshot.elements = elements.slice(0, middle);
    const candidate = JSON.stringify(snapshot);
    if (Buffer.byteLength(candidate, "utf8") <= MAX_AGENT_BROWSER_TEXT_BYTES) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  snapshot.elements = elements.slice(0, low);
  serialized = JSON.stringify(snapshot);
  return Buffer.byteLength(serialized, "utf8") <= MAX_AGENT_BROWSER_TEXT_BYTES
    ? serialized
    : JSON.stringify({
        truncated: true,
        inertiaAudit: snapshot.inertiaAudit,
      });
}

/**
 * Adds deterministic, semantic-only frontend checks to the existing bounded
 * Browser snapshot. This deliberately does not infer CSS quality from pixels.
 */
export function withFrontendBrowserAudit(snapshotText: string): string {
  let snapshot: Record<string, unknown>;
  try {
    const parsed = record(JSON.parse(snapshotText) as unknown);
    if (!parsed || !Array.isArray(parsed.elements)) return snapshotText;
    snapshot = { ...parsed };
  } catch {
    return snapshotText;
  }
  const sourceElements: unknown[] = Array.isArray(snapshot.elements)
    ? snapshot.elements
    : [];
  const elements: AuditedElement[] = sourceElements
    .slice(0, MAX_ELEMENTS)
    .map(safeElement)
    .filter((value): value is AuditedElement => value !== null);
  const viewport = record(snapshot.viewport);
  const viewportWidth = finite(viewport?.width);
  const viewportHeight = finite(viewport?.height);
  const interactive = elements.filter(({ role, actionable, editable, disabled }) => (
    !disabled
    && (actionable || editable || INTERACTIVE_ROLES.has(role.toLowerCase()))
  ));
  const unnamed = interactive.filter(({ name, nameSource }) => (
    name.trim().length === 0
    || (nameSource !== null && WEAK_NAME_SOURCES.has(nameSource))
  ));
  const small = interactive.filter(({ rect }) => (
    rect.width < MIN_TARGET_SIZE || rect.height < MIN_TARGET_SIZE
  ));
  const clipped = viewportWidth === null || viewportHeight === null
    ? []
    : interactive.filter(({ rect }) => (
        rect.x < 0
        || rect.y < 0
        || rect.x + rect.width > viewportWidth
        || rect.y + rect.height > viewportHeight
      ));
  const overlapping = new Set<string>();
  let overlapPairs = 0;
  for (let left = 0; left < interactive.length; left += 1) {
    for (let right = left + 1; right < interactive.length; right += 1) {
      if (!intersects(interactive[left]!.rect, interactive[right]!.rect)) continue;
      overlapPairs += 1;
      overlapping.add(interactive[left]!.ref);
      overlapping.add(interactive[right]!.ref);
    }
  }
  const issues = [
    issue(
      "missing-stable-name",
      "error",
      unnamed.map(({ ref }) => ref),
      unnamed.length,
      "Interactive controls need a stable label or semantic name, not only placeholder or current-value text.",
    ),
    issue(
      "clipped-control",
      "warning",
      clipped.map(({ ref }) => ref),
      clipped.length,
      "Interactive controls extend outside the current visible viewport.",
    ),
    issue(
      "overlapping-controls",
      "warning",
      [...overlapping],
      overlapPairs,
      "Interactive controls overlap by at least half of the smaller target.",
    ),
    issue(
      "small-target",
      "warning",
      small.map(({ ref }) => ref),
      small.length,
      `Interactive targets are smaller than ${MIN_TARGET_SIZE} by ${MIN_TARGET_SIZE} CSS pixels.`,
    ),
  ].filter((value): value is AuditIssue => value !== null);
  snapshot.inertiaAudit = {
    version: 1,
    scope: "current-semantic-viewport",
    checkedElements: elements.length,
    checkedInteractiveElements: interactive.length,
    errors: issues.filter(({ severity }) => severity === "error")
      .reduce((total, current) => total + current.count, 0),
    warnings: issues.filter(({ severity }) => severity === "warning")
      .reduce((total, current) => total + current.count, 0),
    issues,
    limitations: [
      "Semantic checks cannot judge color, typography, imagery, canvas, animation, or pixel-level visual quality.",
      "Repeat the snapshot after the user or layout changes the viewport; this result covers only the current visible viewport.",
    ],
  };
  return boundedSnapshot(snapshot);
}
