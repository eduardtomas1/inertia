import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, normalize, sep, win32 } from "node:path";

import { z } from "zod";

import {
  RestrictedCliError,
  runRestrictedCli,
  type RestrictedCliDependencies,
} from "../restricted-cli-runner";
import {
  decodeConsole,
  DWG_NEXT,
  dwgScript,
  dxfScript,
  parseAcadLocations,
  parseProbe,
  planPlot,
  plotScript,
  pngSize,
  probeScript,
  TEMPLATE_INSERT,
  TEMPLATE_NOTE,
  templateScript,
  type Bounds,
  type CadExportInput,
  type ExportFormat,
  type PaperSize,
} from "./cad-export-scripts";
import { CadError, type CadDocument } from "./cad-hosts";

export {
  DWG_NEXT,
  EXPORT_FORMATS,
  PAPER_SIZES,
  TEMPLATE_NOTE,
  type Bounds,
  type CadExportInput,
  type ExportFormat,
  type PaperSize,
} from "./cad-export-scripts";

export interface CadExportResult {
  format: ExportFormat;
  /** The file written; absent for a png without destination, which only returns the image. */
  path?: string;
  screenshot?: { pngBase64: string; width: number; height: number };
  sourcePath: string;
  sourceSavedAt: string;
  /** The open drawing has changes newer than the saved file that was exported. */
  liveUnsaved?: true;
  areaPlotted?: Bounds | "layout" | null;
  paper?: PaperSize;
  mmPerUnit?: number;
  warnings: string[];
  next?: string;
}

export interface ExportRunOptions {
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal | undefined;
}

/**
 * Runs one console program and resolves with its raw stdout whatever its exit code, which says
 * nothing reliable about accoreconsole's work: the produced file does. Rejects with a
 * `RestrictedCliError` when the program could not start, timed out or was cancelled
 * (`timeout`), could not be confirmed stopped (`cleanup`), or printed too much (`output-limit`).
 */
export type ExportRunner = (
  executable: string,
  args: readonly string[],
  options: ExportRunOptions,
) => Promise<{ stdout: Uint8Array }>;

export interface CadExporterOptions {
  /** Inertia's CAD state folder: holds exports.jsonl, the console profile and scratch copies. */
  stateDirectory: string;
  platform: NodeJS.Platform;
  programFiles?: string;
  systemRoot?: string;
  /** The open AutoCAD drawings, to resolve documentIds and report unsaved changes. */
  documents: () => Promise<CadDocument[]>;
  run?: ExportRunner;
  now?: () => number;
}

// Answers before the 60-second timeout most MCP clients use, across all of an export's passes.
const EXPORT_BUDGET_MS = 55_000;
const MIN_PASS_MS = 5_000;
const REGISTRY_TIMEOUT_MS = 10_000;
// The restricted runner's ceiling. The console writes UTF-16, so it is about 512 Ki characters.
const MAX_CONSOLE_BYTES = 1024 * 1024;
/** The `/isolate` profile name, so the console never reads or writes the designer's own profile. */
const PROFILE_NAME = "inertia";

const UNSUPPORTED = "inertia_cad_export needs full AutoCAD on Windows.";

/**
 * The production runner, over the restricted runner: no shell, an allowlisted environment, and a
 * process-tree kill on timeout or cancellation.
 *
 * The restricted runner hands back stdout decoded as UTF-8. The console's UTF-16LE output keeps
 * every ASCII character that way (each is followed by a zero byte, which is valid UTF-8 and
 * `decodeConsole` drops), and only non-ASCII characters turn into replacement characters. The
 * export engine reads nothing but ASCII from the console, so re-encoding the text is enough.
 */
export function restrictedExportRunner(dependencies: RestrictedCliDependencies = {}): ExportRunner {
  return async (executable, args, options) => {
    try {
      const { stdout } = await runRestrictedCli(executable, args, {
        ...options,
        failureMessage: `${basename(executable)} stopped with an error.`,
        // A non-zero exit still printed what the probe needs; keep all of it.
        classifyFailure: (output) => output,
      }, dependencies);
      return { stdout: Buffer.from(stdout, "utf8") };
    } catch (error) {
      // Only an exit code has no cause; a spawn failure keeps its errno error as the cause.
      if (error instanceof RestrictedCliError && error.code === "failed" && error.cause === undefined) {
        return { stdout: Buffer.from(error.reason ?? "", "utf8") };
      }
      throw error;
    }
  };
}

const invalid = (message: string): CadError => new CadError("INVALID_REQUEST", message);

// Checked with this computer's path rules, which are the ones the files are opened with.
const windowsPaths = sep === "\\";
const samePath = (a: string, b: string): boolean => (windowsPaths ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Whether two paths reach the same file, also through links, junctions or other spellings: a
 * destination that is the source or the template must never be written.
 */
async function sameFile(a: string, b: string): Promise<boolean> {
  if (samePath(a, b)) return true;
  const [left, right] = await Promise.all([realpath(a).catch(() => undefined), realpath(b).catch(() => undefined)]);
  if (left !== undefined && right !== undefined && samePath(left, right)) return true;
  const [x, y] = await Promise.all([
    stat(a, { bigint: true }).catch(() => undefined),
    stat(b, { bigint: true }).catch(() => undefined),
  ]);
  return x !== undefined && y !== undefined && x.ino !== 0n && x.dev === y.dev && x.ino === y.ino;
}

/** Windows opens these as devices even with an extension, in any folder. */
function reservedWindowsName(path: string): boolean {
  const stem = win32.basename(path).split(".")[0]?.replace(/[ .]+$/u, "") ?? "";
  return /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu.test(stem);
}

/**
 * A path the agent gave: absolute, on a local drive on Windows (never a share, device or stream),
 * and never a Windows device name, which exports refuse on every platform since they run on Windows.
 */
function localPath(path: string, field: string, extensions: readonly string[]): string {
  const refusal = invalid(
    `${field} must be an absolute path${windowsPaths ? " on a local drive" : ""} ending in ${extensions.join(" or ")}.`,
  );
  if (/[\p{Cc}\p{Cf}"]/u.test(path) || !isAbsolute(path)) throw refusal;
  const normalized = normalize(path);
  if (
    (windowsPaths && (!/^[A-Za-z]:\\/u.test(normalized) || normalized.includes(":", 2)))
    || !extensions.includes(extname(normalized).toLowerCase())
  ) {
    throw refusal;
  }
  if (reservedWindowsName(normalized)) {
    throw invalid(`${field} names a Windows device (CON, PRN, AUX, NUL, COM1-9, LPT1-9). Choose another file name.`);
  }
  return normalized;
}

const fileExists = (path: string): Promise<boolean> => stat(path).then((stats) => stats.isFile(), () => false);
const nonEmpty = (path: string): Promise<boolean> => stat(path).then((stats) => stats.isFile() && stats.size > 0, () => false);
const sha256File = (path: string): Promise<string | undefined> =>
  readFile(path).then((bytes) => createHash("sha256").update(bytes).digest("hex"), () => undefined);

const exportReceiptSchema = z.object({
  export: z.object({ path: z.string(), sha256: z.string() }),
  at: z.string(),
});

/** `Plan (Inertia export 2026-11-21 163005).pdf`, in the designer's local time. */
function stampedName(path: string, epochMillis: number): string {
  const extension = extname(path);
  const local = new Date(epochMillis);
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}${pad(local.getMinutes())}${pad(local.getSeconds())}`;
  return join(dirname(path), `${basename(path, extension)} (Inertia export ${stamp})${extension}`);
}

/** `<folder>/<name>.<format>`. */
const defaultDestination = (folder: string, sourcePath: string, format: ExportFormat): string =>
  join(folder, `${basename(sourcePath, extname(sourcePath))}.${format}`);

/** Runs one export at a time: they share one console profile, and each loads a whole drawing. */
class ExportQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

interface Drawing {
  path: string;
  savedAt: string;
  liveUnsaved: boolean;
}

interface Prepared {
  input: CadExportInput;
  source: Drawing;
  template: Drawing | undefined;
  destination: string | undefined;
}

interface Outcome {
  warnings: string[];
  areaPlotted: Bounds | "layout" | null | undefined;
  paperSize: PaperSize | undefined;
  bytes: Buffer | undefined;
  path: string | undefined;
}

/**
 * Runs AutoCAD's console (accoreconsole.exe) on a copy of a drawing. The open session and the
 * original file are never touched, and outputs never overwrite anything but Inertia's own earlier
 * exports, which exports.jsonl records by hash.
 */
export class CadExporter {
  private readonly options: CadExporterOptions;
  private readonly run: ExportRunner;
  private readonly now: () => number;
  private readonly receiptsFile: string;
  private readonly profileDirectory: string;
  private readonly lock = new ExportQueue();
  private located: string | undefined;

  constructor(options: CadExporterOptions) {
    this.options = options;
    this.run = options.run ?? restrictedExportRunner();
    this.now = options.now ?? Date.now;
    // Its own file: the apply receipts are trimmed, and export ownership must never be dropped.
    this.receiptsFile = join(options.stateDirectory, "exports.jsonl");
    this.profileDirectory = join(options.stateDirectory, "accoreconsole");
  }

  /** Whether AutoCAD's console is installed, so exports can run. */
  async headless(): Promise<boolean> {
    return (await this.locate()) !== undefined;
  }

  /**
   * The file an export would write, checked before the user approves a custom destination.
   * A default name may still gain a later timestamp; a png without destination writes no file
   * and is refused here.
   */
  async destinationFor(input: CadExportInput): Promise<string> {
    const prepared = await this.prepare(input);
    await this.requireConsole();
    const target = await this.target(prepared);
    if (target === undefined) {
      throw invalid("A png without destination writes no file; the image is returned instead.");
    }
    return (await this.delivery(target.path, target.explicit, inputsOf(prepared))).path;
  }

  async export(input: CadExportInput, signal?: AbortSignal): Promise<CadExportResult> {
    const prepared = await this.prepare(input);
    const accoreconsole = await this.requireConsole();
    const deadline = this.now() + EXPORT_BUDGET_MS;
    const outcome = await this.lock.run(async () => await this.runExport(prepared, accoreconsole, deadline, signal));
    const size = outcome.bytes === undefined ? undefined : pngSize(outcome.bytes);
    return {
      format: input.format,
      ...(outcome.path === undefined ? {} : { path: outcome.path }),
      ...(outcome.bytes === undefined || size === undefined
        ? {}
        : { screenshot: { pngBase64: outcome.bytes.toString("base64"), width: size.width, height: size.height } }),
      sourcePath: prepared.source.path,
      sourceSavedAt: prepared.source.savedAt,
      ...(prepared.source.liveUnsaved ? { liveUnsaved: true as const } : {}),
      ...(outcome.areaPlotted === undefined ? {} : { areaPlotted: outcome.areaPlotted }),
      ...(outcome.paperSize === undefined ? {} : { paper: outcome.paperSize }),
      ...(input.format === "pdf" && input.mmPerUnit !== undefined ? { mmPerUnit: input.mmPerUnit } : {}),
      warnings: outcome.warnings,
      ...(input.format === "dwg" ? { next: DWG_NEXT } : {}),
    };
  }

  /** accoreconsole.exe from the registry, else Program Files; only a found one is remembered. */
  private async locate(): Promise<string | undefined> {
    if (this.options.platform !== "win32") return undefined;
    if (this.located !== undefined) return this.located;
    const reg = join(this.options.systemRoot ?? "C:\\Windows", "System32", "reg.exe");
    let output = "";
    try {
      await mkdir(this.options.stateDirectory, { recursive: true });
      const { stdout } = await this.run(
        reg,
        ["query", "HKLM\\SOFTWARE\\Autodesk\\AutoCAD", "/s", "/v", "AcadLocation"],
        { cwd: this.options.stateDirectory, timeoutMs: REGISTRY_TIMEOUT_MS, maxOutputBytes: MAX_CONSOLE_BYTES },
      );
      output = decodeConsole(stdout);
    } catch {
      // No registry answer: the Program Files folders still count.
    }
    const programFiles = this.options.programFiles ?? "C:\\Program Files";
    const installed = await readdir(join(programFiles, "Autodesk")).catch(() => [] as string[]);
    const folders = [
      ...parseAcadLocations(output),
      ...installed
        .filter((name) => /^AutoCAD 20\d\d$/u.test(name))
        .sort()
        .reverse()
        .map((name) => join(programFiles, "Autodesk", name)),
    ];
    for (const folder of folders) {
      const candidate = join(folder, "accoreconsole.exe");
      if (await fileExists(candidate)) {
        this.located = candidate;
        return candidate;
      }
    }
    return undefined;
  }

  private async requireConsole(): Promise<string> {
    const accoreconsole = await this.locate();
    if (accoreconsole === undefined) {
      throw new CadError(
        "NOT_INSTALLED",
        "Headless AutoCAD (accoreconsole.exe) was not found. inertia_cad_export needs full AutoCAD for Windows; AutoCAD LT has no console.",
      );
    }
    return accoreconsole;
  }

  /** Every check that needs no console: options per format, the source, template and destination. */
  private async prepare(input: CadExportInput): Promise<Prepared> {
    if (this.options.platform !== "win32") throw new CadError("UNSUPPORTED_PLATFORM", UNSUPPORTED);
    const reject = (field: string, allowed: string): CadError => invalid(`${field} applies only to ${allowed}.`);
    if (input.format !== "png" && input.format !== "pdf") {
      for (const field of ["area", "layout", "plotStyle"] as const) {
        if (input[field] !== undefined) throw reject(field, "png and pdf");
      }
    }
    if (input.format !== "pdf") {
      if (input.mmPerUnit !== undefined) throw reject("mmPerUnit", "pdf");
      if (input.paper !== undefined) throw reject("paper", "pdf");
    }
    if (input.template !== undefined && input.format !== "dwg") throw reject("template", "dwg");
    if (
      input.format === "dwg"
      && !input.source.startsWith("skp:")
      && (input.source.startsWith("acad:") || extname(input.source).toLowerCase() !== ".dxf")
    ) {
      throw invalid("dwg builds a new drawing from a .dxf file you wrote; pass its absolute path as source.");
    }
    const source = await this.resolveDrawing(input.source, "source", input.format === "dwg" ? [".dxf"] : [".dwg", ".dxf"]);
    const template = input.template === undefined
      ? undefined
      : await this.resolveDrawing(input.template, "template", [".dwg", ".dwt"]);
    const destination = input.destination === undefined
      ? undefined
      : localPath(input.destination, "destination", [`.${input.format}`]);
    return { input, source, template, destination };
  }

  /** A documentId or path, and whether the open drawing has unsaved changes. */
  private async resolveDrawing(reference: string, field: "source" | "template", extensions: readonly string[]): Promise<Drawing> {
    if (reference.startsWith("skp:")) {
      throw invalid("inertia_cad_export works on AutoCAD drawings; SketchUp models are not supported.");
    }
    const documents = async (): Promise<CadDocument[]> => await this.options.documents().catch(() => []);
    let path: string;
    let document: CadDocument | undefined;
    if (reference.startsWith("acad:")) {
      document = (await documents()).find((candidate) => candidate.documentId === reference);
      if (document === undefined) {
        throw new CadError("DOCUMENT_NOT_FOUND", "Unknown documentId. Call inertia_cad_status for the open drawings.");
      }
      if (document.path == null) {
        throw invalid("This drawing has never been saved, so there is no file to export. Ask the designer to save it first.");
      }
      path = localPath(document.path, field, extensions);
    } else {
      path = localPath(reference, field, extensions);
      // Only the designer's drawings are open in AutoCAD; DXFs are the agent's own.
      if (extname(path).toLowerCase() !== ".dxf") {
        document = (await documents()).find(
          (candidate) => candidate.path != null && samePath(normalize(candidate.path), path),
        );
      }
    }
    const stats = await stat(path).catch(() => undefined);
    if (stats === undefined || !stats.isFile() || stats.size === 0) {
      throw new CadError("SOURCE_NOT_FOUND", `The ${field} file ${path} does not exist or is empty.`);
    }
    return { path, savedAt: new Date(stats.mtimeMs).toISOString(), liveUnsaved: document?.modified === true };
  }

  /** Where the output goes before the overwrite rule; undefined for a png only returned inline. */
  private async target(prepared: Prepared): Promise<{ path: string; explicit: boolean } | undefined> {
    const { input, source, destination } = prepared;
    if (destination !== undefined) return { path: destination, explicit: true };
    if (input.format === "png") return undefined;
    const folder = (await this.ownSource(source.path))
      ? dirname(source.path)
      : join(this.options.stateDirectory, "exported");
    return { path: defaultDestination(folder, source.path, input.format), explicit: false };
  }

  /** A DXF the agent wrote, or an earlier Inertia export: its exports may go beside it. */
  private async ownSource(sourcePath: string): Promise<boolean> {
    if (extname(sourcePath).toLowerCase() === ".dxf") return true;
    const sha256 = await sha256File(sourcePath);
    return sha256 !== undefined && (await this.ownedExports()).has(ledgerKey(sourcePath, sha256));
  }

  private async runExport(prepared: Prepared, accoreconsole: string, deadline: number, signal: AbortSignal | undefined): Promise<Outcome> {
    if (signal?.aborted) throw cancelled();
    const { input, source, template } = prepared;
    let workDirectory: string;
    try {
      await mkdir(join(this.options.stateDirectory, "exports"), { recursive: true });
      workDirectory = await mkdtemp(join(this.options.stateDirectory, "exports", "run-"));
    } catch {
      throw new CadError("EXPORT_FAILED", "Could not create Inertia's scratch folder for the export.");
    }
    try {
      const drawing = `in${extname(source.path).toLowerCase()}`;
      try {
        await copyFile(source.path, join(workDirectory, drawing));
        if (template !== undefined) await copyFile(template.path, join(workDirectory, "template.dwg"));
      } catch {
        throw new CadError("SOURCE_NOT_FOUND", "Could not copy the drawing; it may be locked or gone.");
      }
      const pass = async (file: string, name: string, contents: string): Promise<string> =>
        await this.runPass(accoreconsole, workDirectory, file, name, contents, deadline, signal);
      const warnings: string[] = [];
      let areaPlotted: Bounds | "layout" | null | undefined;
      let paperSize: PaperSize | undefined;
      if (input.format === "png" || input.format === "pdf") {
        const probe = parseProbe(await pass(drawing, "probe", probeScript()));
        const planned = planPlot({ ...input, format: input.format }, probe);
        if (planned instanceof CadError) throw planned;
        warnings.push(...planned.warnings);
        paperSize = planned.paperSize;
        areaPlotted = planned.plan.area === "extents" ? probe.extents : planned.plan.area;
        await pass(drawing, "plot", plotScript(planned.plan));
      } else if (input.format === "dxf") {
        await pass(drawing, "dxf", dxfScript());
      } else if (template === undefined) {
        await pass(drawing, "dwg", dwgScript(false));
      } else {
        await pass(drawing, "dwg", dwgScript(true));
        if (!(await nonEmpty(join(workDirectory, TEMPLATE_INSERT)))) {
          throw new CadError(
            "EXPORT_FAILED",
            "Headless AutoCAD could not read the DXF. Check that it opens in a DXF reader such as ezdxf's audit.",
          );
        }
        await pass("template.dwg", "template", templateScript());
        warnings.push(TEMPLATE_NOTE);
      }
      const produced = join(workDirectory, `out.${input.format}`);
      if (!(await nonEmpty(produced))) {
        throw new CadError(
          "EXPORT_FAILED",
          `Headless AutoCAD produced no ${input.format}. Check that the drawing opens in AutoCAD; damaged or password-protected files cannot be exported.`,
        );
      }
      const bytes = input.format === "png" ? await readFile(produced) : undefined;
      const target = await this.target(prepared);
      const path = target === undefined ? undefined : await this.deliver(produced, target.path, target.explicit, inputsOf(prepared));
      return { warnings, areaPlotted, paperSize, bytes, path };
    } finally {
      await rm(workDirectory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
    }
  }

  /** One console run on the copy; resolves with what it printed. */
  private async runPass(
    accoreconsole: string,
    workDirectory: string,
    drawing: string,
    name: string,
    contents: string,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const scriptPath = join(workDirectory, `${name}.scr`);
    await writeFile(scriptPath, contents, "latin1");
    const timeoutMs = Math.max(MIN_PASS_MS, deadline - this.now());
    try {
      const { stdout } = await this.run(
        accoreconsole,
        // The isolated profile copies the designer's PrinterStyleSheetDir, so their own .ctb/.stb
        // tables stay listed; only its registry and user data folders are Inertia's.
        ["/i", join(workDirectory, drawing), "/s", scriptPath, "/isolate", PROFILE_NAME, this.profileDirectory],
        { cwd: workDirectory, timeoutMs, maxOutputBytes: MAX_CONSOLE_BYTES, signal },
      );
      return decodeConsole(stdout);
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      if (!(error instanceof RestrictedCliError)) throw error;
      switch (error.code) {
        case "timeout":
        case "cleanup":
          throw new CadError(
            "EXPORT_TIMEOUT",
            "Headless AutoCAD did not finish in time and was stopped. Export a smaller area, or ask the designer to check that the drawing opens without prompts.",
          );
        case "output-limit":
          throw new CadError(
            "EXPORT_FAILED",
            "Headless AutoCAD printed more output than Inertia reads (1 MiB) and was stopped. The drawing may be damaged; ask the designer to run AUDIT on it, or export a simpler DXF.",
          );
        default:
          throw new CadError("HOST_ERROR", "Headless AutoCAD (accoreconsole.exe) could not start.");
      }
    }
  }

  /**
   * Never overwrites, except a file Inertia exported there before that nobody changed since.
   * Otherwise an explicit destination fails and a default one gets a stamped name.
   */
  private async delivery(target: string, explicit: boolean, inputs: readonly string[]): Promise<{ path: string; replacing: boolean }> {
    let path = target;
    // Compared as files, not strings: an alias of the source must not pass as an earlier export.
    const isSource = (await Promise.all(inputs.map(async (input) => await sameFile(target, input)))).some(Boolean);
    if (isSource || (await fileExists(target))) {
      const existing = isSource ? undefined : await sha256File(target);
      const owned = existing !== undefined && (await this.ownedExports()).has(ledgerKey(target, existing));
      if (!owned) {
        if (explicit) {
          throw new CadError(
            "DESTINATION_EXISTS",
            `${target} already exists and Inertia did not export it. Choose another destination; Inertia never overwrites other files.`,
          );
        }
        path = stampedName(target, this.now());
      }
    }
    return { path, replacing: path === target && !isSource && (await fileExists(target)) };
  }

  private async deliver(produced: string, target: string, explicit: boolean, inputs: readonly string[]): Promise<string> {
    const { path, replacing } = await this.delivery(target, explicit, inputs);
    const sha256 = await sha256File(produced);
    try {
      await mkdir(dirname(path), { recursive: true });
      if (!replacing) {
        await copyFile(produced, path, constants.COPYFILE_EXCL);
      } else {
        const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
        await copyFile(produced, temporary, constants.COPYFILE_EXCL);
        await rename(temporary, path).catch(async (error: unknown) => {
          await rm(temporary, { force: true });
          throw error;
        });
      }
    } catch {
      throw new CadError(
        "EXPORT_FAILED",
        `Could not write ${path}. It may be open in another program, or the folder may be read-only.`,
      );
    }
    if (sha256 !== undefined) await this.recordExport(path, sha256);
    return path;
  }

  /** Every export Inertia wrote, by path and hash; never trimmed, so ownership is never lost. */
  private async ownedExports(): Promise<Set<string>> {
    const text = await readFile(this.receiptsFile, "utf8").catch(() => "");
    const owned = new Set<string>();
    for (const line of text.split("\n")) {
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const receipt = exportReceiptSchema.safeParse(parsed);
      if (receipt.success) owned.add(ledgerKey(receipt.data.export.path, receipt.data.export.sha256));
    }
    return owned;
  }

  // The export stands even if its receipt cannot be written; the next one is then a stamped copy.
  private async recordExport(path: string, sha256: string): Promise<void> {
    const line = JSON.stringify({ export: { path, sha256 }, at: new Date(this.now()).toISOString() });
    try {
      await mkdir(dirname(this.receiptsFile), { recursive: true });
      await appendFile(this.receiptsFile, `${line}\n`);
    } catch {
      // Without the receipt Inertia only treats the file as someone else's, which is the safe side.
    }
  }
}

/** The files an export reads, which it must never write. */
const inputsOf = (prepared: Prepared): string[] =>
  prepared.template === undefined ? [prepared.source.path] : [prepared.source.path, prepared.template.path];

const ledgerKey = (path: string, sha256: string): string => `${windowsPaths ? path.toLowerCase() : path}\n${sha256}`;

const cancelled = (): CadError => new CadError("CANCELLED", "The export was cancelled. The designer's files were not touched.");
