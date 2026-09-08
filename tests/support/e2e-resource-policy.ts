import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type E2eResource = "isolated" | "primary-display";
const resourceMarker = /^\/\/ @inertia-e2e-resource (isolated|primary-display)$/u;
const scenarioFile = /\.spec\.[cm]?[jt]sx?$/u;

export function scenarioResource(source: string, file: string): E2eResource {
  const lines = source.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  const marker = resourceMarker.exec(lines[0] ?? "");
  if (!marker || lines.filter((line) => line.startsWith("// @inertia-e2e-resource")).length !== 1) {
    throw new Error(`${file} needs exactly one first-line @inertia-e2e-resource declaration.`);
  }
  return marker[1] as E2eResource;
}

/** Recursive, fail-closed assignment: a newly added scenario must name its resource. */
export function discoverE2eResources(testDirectory: string): Record<E2eResource, string[]> {
  const root = resolve(testDirectory);
  const result: Record<E2eResource, string[]> = { isolated: [], "primary-display": [] };
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.includes("\\")) throw new Error("E2E resource paths must have unambiguous separators.");
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("E2E resource discovery rejects symbolic links.");
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && scenarioFile.test(entry.name)) {
        const path = relative(root, file).replaceAll("\\", "/");
        result[scenarioResource(readFileSync(file, "utf8"), path)].push(file);
      }
    }
  };
  visit(root);
  for (const files of Object.values(result)) files.sort();
  if (!result.isolated.length && !result["primary-display"].length) {
    throw new Error("E2E resource discovery found no scenarios.");
  }
  return result;
}

/** Literal file identity, not glob syntax (nested names may contain [] or ()). */
export function exactScenarioPattern(files: readonly string[]): RegExp {
  const escaped = files.map((file) => file.split(/[\\/]/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[\\\\/]"));
  return new RegExp(`^(?:${escaped.length ? escaped.join("|") : "(?!)"})$`, "u");
}

/** Also catches a helper selecting the primary display at runtime. */
export function assertE2eWindowResource(project: string, display: "primary" | undefined): void {
  if (display === "primary" && project !== "display-sensitive") {
    throw new Error("A primary-display window requires @inertia-e2e-resource primary-display.");
  }
}
