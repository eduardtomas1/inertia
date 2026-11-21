import { CadError } from "./cad-hosts";

/**
 * The pure half of headless exports: the console scripts Inertia writes, and the parsers for what
 * AutoCAD's console prints back. Nothing here touches the filesystem or starts a process.
 */

export const EXPORT_FORMATS = ["png", "pdf", "dxf", "dwg"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** ISO sizes in mm, landscape. */
const PAPER_DIMENSIONS = {
  A4: [297, 210],
  A3: [420, 297],
  A2: [594, 420],
  A1: [841, 594],
  A0: [1189, 841],
} as const;
export const PAPER_SIZES = ["A4", "A3", "A2", "A1", "A0"] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export interface Bounds {
  min: [number, number];
  max: [number, number];
}

export interface CadExportInput {
  /** A documentId from inertia_cad_status (`acad:<path>`), or an absolute .dwg/.dxf path. */
  source: string;
  format: ExportFormat;
  area?: { min: number[]; max: number[] };
  layout?: string;
  mmPerUnit?: number;
  paper?: PaperSize;
  plotStyle?: string;
  template?: string;
  destination?: string;
}

export const DWG_NEXT =
  "Render it (png) beside one of the designer's sheets before delivering. Match what the designer's sheets contain and omit what they omit (dimensions, callouts, legends). Choose the scale so the drawing fills most of the sheet. Use heavy lines for cut and outline, hairlines for joints and glazing.";

export const TEMPLATE_NOTE =
  "Built on a copy of the template: model space holds only your DXF, layouts keep their page setups and viewports but nothing else, and unused blocks were purged.";

// A script line is console input and a newline is Enter, so every line is printable ASCII built
// here: numbers are formatted by Inertia, names come only from AutoCAD's own listings, layouts are
// chosen by index, and files have fixed names relative to the scratch folder.
const SCRIPT_LINE = /^[\x20-\x7E]*$/u;

/** A name AutoCAD listed that may be typed back at a prompt; `(`, `!` and `'` would run LISP or a transparent command. */
export function isPromptSafe(name: string): boolean {
  return /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/u.test(name)
    && !/^[(!']/u.test(name)
    && !name.includes('"');
}

/** Plain decimal text, never exponent notation. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) {
    throw new RangeError("Script numbers must be finite and below 1e15.");
  }
  const text = value.toFixed(6).replace(/\.?0+$/u, "");
  return text === "-0" ? "0" : text;
}

function script(lines: readonly string[]): string {
  for (const line of lines) {
    if (!SCRIPT_LINE.test(line)) throw new Error("A script line is not printable ASCII.");
  }
  return `${lines.join("\r\n")}\r\n`;
}

const START = ["_.FILEDIA", "0"];
const QUIT = ["_.QUIT", "_Y"];

/** Every line Inertia's probe prints starts with this, so console noise is never mistaken for data. */
const MARKER = "INR|";

// Strings leave LISP as comma-separated code points, so names survive any console encoding.
const LISP_HELPERS = [
  String.raw`(defun inrp (s) (princ (strcat "\nINR|" s "\n")) (princ))`,
  String.raw`(defun inrs (s) (if (= (type s) (quote STR)) (apply (quote strcat) (mapcar (quote (lambda (c) (strcat (itoa c) ","))) (vl-string->list s))) ""))`,
  String.raw`(defun inrn (x) (if (numberp x) (rtos x 2 6) ""))`,
];

/** Reads layouts, extents, references, and the PDF device's paper sizes and plot style tables. */
export function probeScript(): string {
  return script([
    ...START,
    ...LISP_HELPERS,
    String.raw`(setvar "TILEMODE" 1)`,
    "_.ZOOM",
    "_E",
    String.raw`(inrp (strcat "V|" (itoa (getvar "PSTYLEMODE"))))`,
    String.raw`(setq inra (getvar "EXTMIN") inrb (getvar "EXTMAX"))`,
    String.raw`(inrp (strcat "E|" (inrn (car inra)) "|" (inrn (cadr inra)) "|" (inrn (car inrb)) "|" (inrn (cadr inrb))))`,
    String.raw`(setq inri 0 inrk nil)`,
    String.raw`(foreach p (dictsearch (namedobjdict) "ACAD_LAYOUT") (cond ((= (car p) 3) (setq inrk (cdr p))) ((= (car p) 350) (setq inre (entget (cdr p))) (inrp (strcat "L|" (itoa inri) "|" (inrn (cdr (assoc 44 inre))) "|" (inrn (cdr (assoc 45 inre))) "|" (inrn (cdr (assoc 73 inre))) "|" (inrs (cdr (assoc 7 inre))) "|" (inrs inrk))) (setq inri (1+ inri)))))`,
    String.raw`(setq inrr (tblnext "BLOCK" T))`,
    String.raw`(while inrr (if (= 4 (logand 4 (cdr (assoc 70 inrr)))) (inrp (strcat "X|" (inrs (cdr (assoc 1 inrr)))))) (setq inrr (tblnext "BLOCK")))`,
    String.raw`(foreach inrd (list "ACAD_IMAGE_DICT" "ACAD_PDFDEFINITIONS" "ACAD_DWFDEFINITIONS" "ACAD_DGNDEFINITIONS") (foreach p (dictsearch (namedobjdict) inrd) (if (= (car p) 350) (inrp (strcat "X|" (inrs (cdr (assoc 1 (entget (cdr p))))))))))`,
    "_.-PLOT",
    "_Y",
    "",
    "DWG To PDF.pc3",
    "?",
    "",
    "_M",
    "_L",
    "_N",
    "_E",
    "_F",
    "_C",
    "_Y",
    "?",
    "",
    "_Y",
    "_A",
    "probe.pdf",
    "_N",
    "_N",
    ...QUIT,
  ]);
}

export interface ProbeLayout {
  index: number;
  name: string;
  plotStyle: string;
  paperWidth: number | null;
  paperHeight: number | null;
  rotation: number;
}

export interface Probe {
  namedPlotStyles: boolean;
  extents: Bounds | null;
  layouts: ProbeLayout[];
  references: string[];
  papers: string[];
  plotStyles: string[];
}

/**
 * The console writes UTF-16 for most output and 8-bit text for some, so drop the zero bytes:
 * Inertia's lines are ASCII by construction and listings are only used when ASCII.
 */
export function decodeConsole(bytes: Uint8Array): string {
  return Buffer.from(bytes.filter((byte) => byte !== 0)).toString("latin1");
}

function fromCodePoints(text: string): string {
  return String.fromCodePoint(
    ...text
      .split(",")
      .filter((part) => part !== "")
      .map(Number)
      .filter((code) => Number.isInteger(code) && code >= 0 && code <= 0x10ffff),
  );
}

function number(text: string | undefined): number | null {
  const value = text === undefined || text.trim() === "" ? Number.NaN : Number(text);
  return Number.isFinite(value) && Math.abs(value) < 1e15 ? value : null;
}

export function parseProbe(output: string): Probe {
  let namedPlotStyles = false;
  let extents: Bounds | null = null;
  const layouts: ProbeLayout[] = [];
  const references: string[] = [];
  const papers: string[] = [];
  const plotStyles: string[] = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.replace(/\r$/u, "");
    const listed = /^\s+"([^"]+)"\s*$/u.exec(line)?.[1];
    if (listed !== undefined) {
      if (/\.(ctb|stb)$/iu.test(listed)) plotStyles.push(listed);
      else papers.push(listed);
      continue;
    }
    if (!line.startsWith(MARKER)) continue;
    const [kind, ...fields] = line.slice(MARKER.length).split("|");
    if (kind === "V") namedPlotStyles = fields[0] === "0";
    else if (kind === "E") {
      const [x1, y1, x2, y2] = fields.map(number);
      if (x1 != null && y1 != null && x2 != null && y2 != null && x1 <= x2 && y1 <= y2) {
        extents = { min: [x1, y1], max: [x2, y2] };
      }
    } else if (kind === "L" && fields.length >= 6) {
      const [index, width, height, rotation, style, name] = fields;
      layouts.push({
        index: Number(index),
        name: fromCodePoints(name ?? ""),
        plotStyle: fromCodePoints(style ?? ""),
        paperWidth: number(width),
        paperHeight: number(height),
        rotation: number(rotation) ?? 0,
      });
    } else if (kind === "X" && fields[0] !== undefined) {
      references.push(fromCodePoints(fields[0]));
    }
  }
  return { namedPlotStyles, extents, layouts, references, papers, plotStyles };
}

/** Parses `ISO full bleed A2 (594.00 x 420.00 mm)`; `?` listings are localized, the dimensions are not. */
function paperDimensions(name: string): { width: number; height: number } | undefined {
  const match = /\((\d+(?:[.,]\d+)?)\s*[xX×]\s*(\d+(?:[.,]\d+)?)\s*([^)]*)\)\s*$/u.exec(name);
  if (match === null) return undefined;
  const unit = (match[3] ?? "").trim().toLowerCase();
  const factor = unit.startsWith("mm") || unit.startsWith("mil")
    ? 1
    : /^(in|pul|zoll|po)/u.test(unit) ? 25.4 : 0;
  if (factor === 0) return undefined;
  const width = Number(match[1]?.replace(",", ".")) * factor;
  const height = Number(match[2]?.replace(",", ".")) * factor;
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}

/** The listed paper with `size`'s dimensions, preferring full bleed and the requested orientation. */
export function matchPaper(papers: readonly string[], size: PaperSize, landscape: boolean): string | undefined {
  const [long, short] = PAPER_DIMENSIONS[size];
  const candidates = papers.flatMap((name, order) => {
    const dimensions = paperDimensions(name);
    if (dimensions === undefined || !isPromptSafe(name)) return [];
    const { width, height } = dimensions;
    if (Math.abs(Math.max(width, height) - long) > 1 || Math.abs(Math.min(width, height) - short) > 1) {
      return [];
    }
    const rank = (/full bleed/iu.test(name) ? 0 : 2) + (width >= height === landscape ? 0 : 1) + order / 1e6;
    return [{ name, rank }];
  });
  return candidates.sort((a, b) => a.rank - b.rank)[0]?.name;
}

export interface PlotPlan {
  device: "png" | "pdf";
  /** Index into the drawing's layout dictionary; `model` plots model space. */
  layout: number | "model";
  /** A listed paper name; empty accepts the device's default. */
  paper: string;
  landscape: boolean;
  area: Bounds | "extents" | "layout";
  mmPerUnit: number | undefined;
  /** A listed plot style table; empty accepts the layout's own. */
  plotStyle: string;
}

const point = ([x, y]: readonly [number, number]): string => `${formatNumber(x)},${formatNumber(y)}`;

export function plotScript(plan: PlotPlan): string {
  const model = plan.layout === "model";
  for (const name of [plan.paper, plan.plotStyle]) {
    if (name !== "" && !isPromptSafe(name)) throw new Error("A listed name is not prompt safe.");
  }
  if (typeof plan.layout === "number" && !Number.isSafeInteger(plan.layout)) {
    throw new Error("A layout index must be an integer.");
  }
  return script([
    ...START,
    ...(typeof plan.layout === "number"
      ? [
        String.raw`(defun inrlay (k / i r) (setq i 0) (foreach p (dictsearch (namedobjdict) "ACAD_LAYOUT") (if (= (car p) 3) (progn (if (= i k) (setq r (cdr p))) (setq i (1+ i))))) r)`,
        `(setvar "CTAB" (inrlay ${plan.layout}))`,
      ]
      : [String.raw`(setvar "TILEMODE" 1)`]),
    "_.-PLOT",
    "_Y",
    "",
    plan.device === "png" ? "PublishToWeb PNG.pc3" : "DWG To PDF.pc3",
    plan.paper,
    ...(plan.device === "pdf" ? ["_M"] : []),
    plan.landscape ? "_L" : "_P",
    "_N",
    ...(plan.area === "extents"
      ? ["_E"]
      : plan.area === "layout"
        ? ["_L"]
        : ["_W", point(plan.area.min), point(plan.area.max)]),
    plan.mmPerUnit === undefined ? "_F" : `${formatNumber(plan.mmPerUnit)}=1`,
    // A layout's offset prompt has no Center option.
    model ? "_C" : "",
    "_Y",
    plan.plotStyle,
    "_Y",
    ...(model ? ["_A"] : ["_N", "_N", "_N"]),
    plan.device === "png" ? "out.png" : "out.pdf",
    "_N",
    "_Y",
    ...QUIT,
  ]);
}

export function dxfScript(): string {
  return script([...START, "_.DXFOUT", "out.dxf", "_V", "2018", "16", ...QUIT]);
}

/** The intermediate drawing a template build inserts. */
export const TEMPLATE_INSERT = "inrnew.dwg";

/** A DXF to a DWG; with `forTemplate` its units are cleared so inserting it never rescales. */
export function dwgScript(forTemplate: boolean): string {
  return script([
    ...START,
    "_.AUDIT",
    "_Y",
    ...(forTemplate ? ["_.INSUNITS", "0"] : []),
    "_.SAVEAS",
    "2018",
    forTemplate ? TEMPLATE_INSERT : "out.dwg",
    ...QUIT,
  ]);
}

/**
 * Empties a copy of the designer's drawing and inserts inrnew.dwg exploded at 0,0, so its layer,
 * text and dimension style definitions win. Locked layers are unlocked only while erasing.
 */
export function templateScript(): string {
  return script([
    ...START,
    String.raw`(defun inrlock (e on / d f) (setq d (entget e) f (cdr (assoc 70 d))) (entmod (subst (cons 70 (if on (logior f 4) (logand f (~ 4)))) (assoc 70 d) d)))`,
    String.raw`(setq inrlk nil inrl (tblnext "LAYER" T))`,
    String.raw`(while inrl (if (= 4 (logand 4 (cdr (assoc 70 inrl)))) (setq inrlk (cons (tblobjname "LAYER" (cdr (assoc 2 inrl))) inrlk))) (setq inrl (tblnext "LAYER")))`,
    String.raw`(foreach e inrlk (inrlock e nil))`,
    String.raw`(if (setq inrss (ssget "_X")) (progn (setq inri 0) (repeat (sslength inrss) (entdel (ssname inrss inri)) (setq inri (1+ inri)))))`,
    String.raw`(setq inru (getvar "INSUNITS"))`,
    String.raw`(setvar "INSUNITS" 0)`,
    String.raw`(setvar "INSUNITSDEFSOURCE" 0)`,
    String.raw`(setvar "INSUNITSDEFTARGET" 0)`,
    // A template saved on a layout tab would otherwise receive the geometry in paper space.
    "_.TILEMODE",
    "1",
    "_.-INSERT",
    `*${TEMPLATE_INSERT}`,
    "0,0",
    "1",
    "0",
    String.raw`(setvar "INSUNITS" inru)`,
    String.raw`(foreach e inrlk (inrlock e T))`,
    "_.-PURGE",
    "_B",
    "*",
    "_N",
    "_.SAVEAS",
    "2018",
    "out.dwg",
    ...QUIT,
  ]);
}

/** AutoCAD folders from `reg.exe query ... /s /v AcadLocation`, newest release first. */
export function parseAcadLocations(regOutput: string): string[] {
  const found: { release: number; folder: string }[] = [];
  let release = 0;
  for (const line of regOutput.split(/\r?\n/u)) {
    const key = /\\AutoCAD\\R(\d+(?:\.\d+)?)\\/iu.exec(line);
    if (line.startsWith("HKEY_")) release = key === null ? 0 : Number(key[1]);
    const value = /^\s+AcadLocation\s+REG_\w+\s+(.+?)\s*$/u.exec(line);
    if (value?.[1] !== undefined) found.push({ release, folder: value[1] });
  }
  return found.sort((a, b) => b.release - a.release).map((entry) => entry.folder);
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const invalid = (message: string): CadError => new CadError("INVALID_REQUEST", message);

const sizeOf = (bounds: Bounds): { width: number; height: number } => ({
  width: bounds.max[0] - bounds.min[0],
  height: bounds.max[1] - bounds.min[1],
});

function fits(size: PaperSize, width: number, height: number): boolean {
  const [long, short] = PAPER_DIMENSIONS[size];
  return Math.max(width, height) <= long + 0.5 && Math.min(width, height) <= short + 0.5;
}

export interface PlannedPlot {
  plan: PlotPlan;
  paperSize?: PaperSize;
  warnings: string[];
}

/** What to plot, from the request and the probe; a `CadError` names what to change. */
export function planPlot(input: CadExportInput & { format: "png" | "pdf" }, probe: Probe): PlannedPlot | CadError {
  const warnings: string[] = [];
  const wanted = input.layout ?? "Model";
  const layout = probe.layouts.find((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase());
  const isModel = wanted.toLowerCase() === "model";
  if (layout === undefined && !isModel) {
    return invalid(
      `No layout named ${JSON.stringify(wanted)}. Layouts: ${probe.layouts.map((candidate) => candidate.name).join(", ")}.`,
    );
  }
  const area: Bounds | undefined = input.area === undefined
    ? undefined
    : {
      min: [input.area.min[0] ?? 0, input.area.min[1] ?? 0],
      max: [input.area.max[0] ?? 0, input.area.max[1] ?? 0],
    };
  if (area !== undefined && [...area.min, ...area.max].some((value) => !Number.isFinite(value) || Math.abs(value) >= 1e15)) {
    return invalid("area coordinates must be finite and below 1e15.");
  }
  if (area !== undefined && (area.min[0] >= area.max[0] || area.min[1] >= area.max[1])) {
    return invalid("area.min must be below and left of area.max.");
  }
  if (input.mmPerUnit !== undefined && !(input.mmPerUnit >= 1e-6 && input.mmPerUnit <= 1e6)) {
    return invalid("mmPerUnit must be between 0.000001 and 1000000.");
  }
  const layoutSheet = !isModel && layout?.paperWidth != null && layout.paperHeight != null
    ? layout.rotation % 2 === 1
      ? { width: layout.paperHeight, height: layout.paperWidth }
      : { width: layout.paperWidth, height: layout.paperHeight }
    : undefined;
  const shape = area !== undefined
    ? sizeOf(area)
    : isModel
      ? probe.extents === null ? undefined : sizeOf(probe.extents)
      : layoutSheet;
  // A PNG's pixel size is fixed; portrait would only turn the drawing on its side.
  const landscape = input.format === "png" || shape === undefined || shape.width >= shape.height;

  const extension = probe.namedPlotStyles ? ".stb" : ".ctb";
  const listedStyle = (name: string): string | undefined =>
    probe.plotStyles.find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  let plotStyle: string;
  if (input.plotStyle !== undefined) {
    const requested = /\.(ctb|stb)$/iu.test(input.plotStyle) ? input.plotStyle : `${input.plotStyle}${extension}`;
    const listed = listedStyle(requested);
    if (listed === undefined || !listed.toLowerCase().endsWith(extension) || !isPromptSafe(listed)) {
      return invalid(
        `plotStyle must be one of: ${probe.plotStyles.filter((name) => name.toLowerCase().endsWith(extension) && isPromptSafe(name)).join(", ")}.`,
      );
    }
    plotStyle = listed;
  } else {
    const own = (layout ?? probe.layouts.find((candidate) => candidate.name.toLowerCase() === "model"))?.plotStyle ?? "";
    const listed = own === "" ? undefined : listedStyle(own);
    if (listed !== undefined) {
      plotStyle = isPromptSafe(listed) ? listed : "";
    } else {
      // Typing a table AutoCAD does not list would make it ask again and stall the script.
      const monochrome = listedStyle(`monochrome${extension}`);
      plotStyle = monochrome !== undefined && isPromptSafe(monochrome) ? monochrome : "";
      if (own !== "") {
        warnings.push(
          `The layout's plot style ${JSON.stringify(own)} was not found in the designer's plot style folder; plotted with ${plotStyle === "" ? "no plot style" : plotStyle}.`,
        );
      }
    }
  }

  const relative = probe.references.filter((path) => path !== "" && !/^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(path));
  if (relative.length > 0) {
    warnings.push(
      `References by relative path don't resolve from the temporary copy, so they are missing from the plot: ${relative.slice(0, 5).join(", ")}${relative.length > 5 ? ", ..." : ""}.`,
    );
  }

  let paper = "";
  let paperSize: PaperSize | undefined;
  if (input.format === "pdf") {
    const plotted = input.mmPerUnit === undefined || shape === undefined
      ? undefined
      : { width: shape.width * input.mmPerUnit, height: shape.height * input.mmPerUnit };
    if (input.paper !== undefined) {
      paperSize = input.paper;
      if (plotted !== undefined && !fits(paperSize, plotted.width, plotted.height)) {
        return invalid(
          `At ${input.mmPerUnit} mm per unit the area is ${Math.round(plotted.width)} x ${Math.round(plotted.height)} mm, larger than ${paperSize}. Pass a larger paper, a smaller mmPerUnit, or a smaller area.`,
        );
      }
    } else if (plotted !== undefined) {
      paperSize = PAPER_SIZES.find((size) => fits(size, plotted.width, plotted.height));
      if (paperSize === undefined) {
        return invalid(
          `At ${input.mmPerUnit} mm per unit the area is ${Math.round(plotted.width)} x ${Math.round(plotted.height)} mm, larger than A0. Pass a smaller mmPerUnit or area.`,
        );
      }
    } else {
      paperSize = (layoutSheet === undefined
        ? undefined
        : PAPER_SIZES.find((size) => {
          const [long, short] = PAPER_DIMENSIONS[size];
          return Math.abs(Math.max(layoutSheet.width, layoutSheet.height) - long) <= 2
            && Math.abs(Math.min(layoutSheet.width, layoutSheet.height) - short) <= 2;
        })) ?? "A3";
    }
    const listed = matchPaper(probe.papers, paperSize, landscape);
    if (listed === undefined) {
      return new CadError("EXPORT_FAILED", `Headless AutoCAD's PDF device lists no ${paperSize} paper.`);
    }
    paper = listed;
  }

  return {
    plan: {
      device: input.format,
      layout: isModel || layout === undefined ? "model" : layout.index,
      paper,
      landscape,
      area: area ?? (isModel ? "extents" : "layout"),
      mmPerUnit: input.format === "pdf" ? input.mmPerUnit : undefined,
      plotStyle,
    },
    ...(paperSize === undefined ? {} : { paperSize }),
    warnings,
  };
}
