// @inertia-test-suite portable
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CadExporter,
  DWG_NEXT,
  restrictedExportRunner,
  TEMPLATE_NOTE,
  type CadExportInput,
  type CadExportResult,
  type ExportRunner,
  type ExportRunOptions,
} from "../../src/server/cad/cad-export";
import {
  decodeConsole,
  dwgScript,
  dxfScript,
  formatNumber,
  matchPaper,
  parseAcadLocations,
  parseProbe,
  planPlot,
  plotScript,
  probeScript,
  templateScript,
  type PlannedPlot,
  type PlotPlan,
} from "../../src/server/cad/cad-export-scripts";
import { CadError, type CadDocument } from "../../src/server/cad/cad-hosts";
import { RestrictedCliError } from "../../src/server/restricted-cli-runner";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

/**
 * A probe transcript from a Spanish AutoCAD 2025, trimmed to the lines Inertia reads and their
 * neighbours (recorded with the fork's `T3|` marker, which Inertia prints as `INR|`).
 */
const ES_PROBE = [
  'Comando: (defun inrp (s) (princ (strcat "\\nINR|" s "\\n")) (princ))',
  "INR|V|1",
  "INR|E|2249.873076|1642.852011|2462.024371|1755.458641",
  "INR|L|0|210|297|0||77,111,100,101,108,",
  "INR|L|1|210|297|1||80,114,101,115,101,110,116,97,99,105,243,110,49,",
  "INR|L|2|0|0|0|109,111,110,111,99,104,114,111,109,101,46,99,116,98,|80,114,101,115,101,110,116,97,99,105,243,110,50,",
  "INR|X|46,46,92,105,109,103,92,102,111,116,111,46,106,112,103,",
  "INR|X|67,58,92,120,114,101,102,92,115,105,116,101,46,100,119,103,",
  "Comando: _.-PLOT",
  "Introduzca un nombre de dispositivo de salida o [?] <Ninguno>: DWG To PDF.pc3",
  "Indique tamaño de papel o [?] <ANSI A (11.00 x 8.50 pulgadas)>: ?",
  "",
  "Tamaños de papel disponibles.",
  '  "ANSI A (11.00 x 8.50 pulgadas)"',
  '  "ANSI expand A (8.50 x 11.00 pulgadas)"',
  '  "ISO A0 (841.00 x 1189.00 mm)"',
  '  "ISO A2 (420.00 x 594.00 mm)"',
  '  "ISO A2 (594.00 x 420.00 mm)"',
  '  "ISO A3 (297.00 x 420.00 mm)"',
  '  "ISO A3 (420.00 x 297.00 mm)"',
  '  "ISO A4 (210.00 x 297.00 mm)"',
  '  "ISO expand A2 (594.00 x 420.00 mm)"',
  '  "ISO full bleed A0 (841.00 x 1189.00 mm)"',
  '  "ISO full bleed A1 (594.00 x 841.00 mm)"',
  '  "ISO full bleed A1 (841.00 x 594.00 mm)"',
  '  "ISO full bleed A2 (420.00 x 594.00 mm)"',
  '  "ISO full bleed A2 (594.00 x 420.00 mm)"',
  '  "ISO full bleed A3 (297.00 x 420.00 mm)"',
  '  "ISO full bleed A3 (420.00 x 297.00 mm)"',
  '  "ISO full bleed A4 (210.00 x 297.00 mm)"',
  '  "ISO full bleed A4 (297.00 x 210.00 mm)"',
  "",
  "Indique nombre de tabla de estilo de trazado o [?] (indique . para ninguna) <>: ?",
  "Tablas de estilos de trazado disponibles.",
  '  "acad.stb"',
  '  "monochrome.stb"',
  '  "acad.ctb"',
  '  "Grayscale.ctb"',
  '  "monochrome.ctb"',
  '  "Screening 25%.ctb"',
  "",
].join("\r\n");

/** The same listings as an English install prints them. */
const EN_PROBE = [
  "INR|V|1",
  "INR|E|0|0|40|30",
  "INR|L|0|0|0|0||77,111,100,101,108,",
  "Available paper sizes.",
  '  "ISO A2 (594.00 x 420.00 MM)"',
  '  "ISO full bleed A2 (420.00 x 594.00 MM)"',
  '  "ISO full bleed A3 (420.00 x 297.00 MM)"',
  '  "ARCH full bleed D (36.00 x 24.00 Inches)"',
  "Available plot style tables.",
  '  "monochrome.ctb"',
].join("\n");

const plan = (overrides: Partial<PlotPlan> = {}): PlotPlan => ({
  device: "png",
  layout: "model",
  paper: "",
  landscape: true,
  area: "extents",
  mmPerUnit: undefined,
  plotStyle: "monochrome.ctb",
  ...overrides,
});

const lines = (script: string): string[] => script.split("\r\n");

describe("cad export scripts", () => {
  it("are printable ASCII lines that end by quitting", () => {
    for (const script of [
      probeScript(),
      plotScript(plan()),
      plotScript(plan({ device: "pdf", layout: 2, area: "layout", paper: "ISO full bleed A2 (594.00 x 420.00 mm)" })),
      dxfScript(),
      dwgScript(false),
      dwgScript(true),
      templateScript(),
    ]) {
      expect(script.endsWith("_.QUIT\r\n_Y\r\n")).toBe(true);
      for (const line of lines(script)) expect(line).toMatch(/^[\x20-\x7E]*$/u);
    }
  });

  it.each([
    [
      "png of model extents, with the device's default paper",
      plan(),
      ["PublishToWeb PNG.pc3", "", "_L", "_N", "_E", "_F", "_C", "_Y", "monochrome.ctb", "_Y", "_A", "out.png"],
    ],
    [
      "pdf of a window at 1:50 in metres",
      plan({
        device: "pdf",
        paper: "ISO full bleed A2 (594.00 x 420.00 mm)",
        area: { min: [2432, 1667.5], max: [2458.25, 1698] },
        mmPerUnit: 20,
        landscape: false,
      }),
      ["DWG To PDF.pc3", "ISO full bleed A2 (594.00 x 420.00 mm)", "_M", "_P", "_N", "_W", "2432,1667.5", "2458.25,1698", "20=1", "_C"],
    ],
    [
      "a layout by index, whose offset prompt has no Center option",
      plan({ layout: 1, area: "layout", plotStyle: "" }),
      ['(setvar "CTAB" (inrlay 1))', '(setvar "PLOTTRANSPARENCYOVERRIDE" 2)', "_.-PLOT", "_Y", "", "PublishToWeb PNG.pc3", "", "_L", "_N", "_L", "_F", "", "_Y", "", "_Y", "_N", "_N", "_N", "out.png"],
    ],
  ] as const)("plots %s", (_name, input, expected) => {
    const script = lines(plotScript(input));
    const start = script.indexOf(expected[0]);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(script.slice(start, start + expected.length)).toEqual(expected);
    // Translucent fills plot solid black unless transparency is forced on.
    expect(script[script.indexOf("_.-PLOT") - 1]).toBe(String.raw`(setvar "PLOTTRANSPARENCYOVERRIDE" 2)`);
  });

  it("dxf, dwg and template scripts write fixed names beside the copy", () => {
    expect(lines(dxfScript())).toContain("out.dxf");
    expect(lines(dwgScript(false))).toEqual(expect.arrayContaining(["_.AUDIT", "out.dwg"]));
    expect(lines(dwgScript(false))).not.toContain("_.INSUNITS");
    expect(lines(dwgScript(true))).toEqual(expect.arrayContaining(["_.INSUNITS", "0", "inrnew.dwg"]));
    const template = lines(templateScript());
    const insert = template.indexOf("_.-INSERT");
    // Model space first, even when the template was saved on a layout tab.
    expect(template.slice(insert - 2, insert + 5)).toEqual(["_.TILEMODE", "1", "_.-INSERT", "*inrnew.dwg", "0,0", "1", "0"]);
    expect(template).toEqual(expect.arrayContaining(['(setvar "INSUNITS" inru)', "out.dwg"]));
  });

  it.each([
    ["a newline in a paper name", plan({ paper: "A2\n_.ERASE" })],
    ["a paper name that would run LISP", plan({ paper: '(command "_.ERASE")' })],
    ["a quote in a plot style", plan({ plotStyle: 'x".ctb' })],
    ["a transparent command", plan({ plotStyle: "'_.ERASE" })],
    ["a non-integer layout index", plan({ layout: 1.5 })],
    ["a coordinate past 1e15", plan({ area: { min: [0, 0], max: [1e16, 1] } })],
  ])("refuses %s", (_name, input) => {
    expect(() => plotScript(input)).toThrow();
  });

  it("formats numbers without exponents", () => {
    expect(formatNumber(20)).toBe("20");
    expect(formatNumber(-0.0000001)).toBe("0");
    expect(formatNumber(1e-5)).toBe("0.00001");
    expect(formatNumber(2432.067375170532)).toBe("2432.067375");
    expect(() => formatNumber(Number.NaN)).toThrow();
  });
});

describe("cad export probe", () => {
  it("reads layouts, extents, references and listings from a Spanish install", () => {
    const probe = parseProbe(ES_PROBE);
    expect(probe.namedPlotStyles).toBe(false);
    expect(probe.extents).toEqual({ min: [2249.873076, 1642.852011], max: [2462.024371, 1755.458641] });
    expect(probe.layouts.map((layout) => [layout.index, layout.name, layout.plotStyle])).toEqual([
      [0, "Model", ""],
      [1, "Presentación1", ""],
      [2, "Presentación2", "monochrome.ctb"],
    ]);
    expect(probe.references).toEqual(["..\\img\\foto.jpg", "C:\\xref\\site.dwg"]);
    expect(probe.plotStyles).toContain("Screening 25%.ctb");
    expect(probe.papers).toContain("ISO full bleed A2 (594.00 x 420.00 mm)");
    expect(probe.papers).not.toContain("monochrome.ctb");
  });

  it("decodes the console's UTF-16 and its 8-bit lines alike", () => {
    const bytes = Buffer.concat([
      Buffer.from("INR|V|1\r\n", "utf16le"),
      Buffer.from("plot stamp log\r\n", "latin1"),
      Buffer.from('  "monochrome.ctb"\r\n', "utf16le"),
    ]);
    const probe = parseProbe(decodeConsole(bytes));
    expect(probe.plotStyles).toEqual(["monochrome.ctb"]);
  });

  it.each([
    ["A2 landscape (es)", ES_PROBE, "A2", true, "ISO full bleed A2 (594.00 x 420.00 mm)"],
    ["A2 portrait (es)", ES_PROBE, "A2", false, "ISO full bleed A2 (420.00 x 594.00 mm)"],
    ["A0, listed only portrait (es)", ES_PROBE, "A0", true, "ISO full bleed A0 (841.00 x 1189.00 mm)"],
    ["A2 landscape (en, upper-case MM)", EN_PROBE, "A2", true, "ISO full bleed A2 (420.00 x 594.00 MM)"],
    ["A3 (en)", EN_PROBE, "A3", false, "ISO full bleed A3 (420.00 x 297.00 MM)"],
    ["A4, not listed (en)", EN_PROBE, "A4", true, undefined],
  ] as const)("matches paper on dimensions: %s", (_name, output, size, landscape, expected) => {
    expect(matchPaper(parseProbe(output).papers, size, landscape)).toBe(expected);
  });

  it("finds AutoCAD folders in reg.exe output, newest first", () => {
    const output = [
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R24.3\\ACAD-7101:409",
      "    AcadLocation    REG_SZ    C:\\Program Files\\Autodesk\\AutoCAD 2024",
      "",
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R25.0\\ACAD-8101:40A",
      "    AcadLocation    REG_SZ    C:\\Program Files\\Autodesk\\AutoCAD 2025\\",
      "",
      "Fin de la búsqueda: 2 coincidencias encontradas.",
    ].join("\r\n");
    expect(parseAcadLocations(output)).toEqual([
      "C:\\Program Files\\Autodesk\\AutoCAD 2025\\",
      "C:\\Program Files\\Autodesk\\AutoCAD 2024",
    ]);
  });
});

describe("cad export plans", () => {
  const probe = parseProbe(ES_PROBE);
  type PlotInput = Partial<CadExportInput> & { format: "png" | "pdf" };
  const planned = (input: PlotInput): PlannedPlot => {
    const result = planPlot({ source: "C:\\a.dwg", ...input }, probe);
    if (result instanceof CadError) throw new Error(result.message);
    return result;
  };
  const refusal = (input: PlotInput): string | undefined => {
    const result = planPlot({ source: "C:\\a.dwg", ...input }, probe);
    return result instanceof CadError ? result.message : undefined;
  };

  it("defaults to model extents in monochrome, and warns about relative references", () => {
    const result = planned({ format: "png" });
    expect(result.plan).toMatchObject({ layout: "model", area: "extents", plotStyle: "monochrome.ctb", landscape: true });
    expect(result.warnings).toEqual([expect.stringContaining("..\\img\\foto.jpg")]);
    expect(result.warnings[0]).not.toContain("site.dwg");
  });

  it("picks layouts by index and keeps their own plot style", () => {
    expect(planned({ format: "png", layout: "presentación2" }).plan).toMatchObject({
      layout: 2,
      area: "layout",
      plotStyle: "monochrome.ctb",
    });
  });

  it("chooses the smallest sheet the scaled area fits, oriented by its shape", () => {
    const result = planned({ format: "pdf", area: { min: [0, 0], max: [26, 16] }, mmPerUnit: 20 });
    expect(result.paperSize).toBe("A2");
    expect(result.plan).toMatchObject({ paper: "ISO full bleed A2 (594.00 x 420.00 mm)", landscape: true, mmPerUnit: 20 });
    const portrait = planned({ format: "pdf", area: { min: [0, 0], max: [12, 16] }, mmPerUnit: 20 });
    expect(portrait.paperSize).toBe("A3");
    expect(portrait.plan.landscape).toBe(false);
  });

  it("keeps PNGs landscape, since their pixel size is fixed", () => {
    expect(planned({ format: "png", area: { min: [0, 0], max: [10, 30] } }).plan.landscape).toBe(true);
  });

  it.each<[string, PlotInput, string]>([
    ["an unknown layout", { format: "png", layout: "Sheet\n_.ERASE" }, "No layout named"],
    ["a plot style that is not installed", { format: "png", plotStyle: "monochrome.ctb\n_.ERASE" }, "plotStyle must be one of"],
    ["a named style in a colour-dependent drawing", { format: "png", plotStyle: "monochrome.stb" }, "plotStyle must be one of"],
    [
      "an area that does not fit the paper",
      { format: "pdf", area: { min: [0, 0], max: [30, 20] }, mmPerUnit: 20, paper: "A3" },
      "larger than A3",
    ],
    ["an empty area", { format: "png", area: { min: [5, 5], max: [5, 9] } }, "area.min"],
    ["a scale of zero, which the script would type as 0=1", { format: "pdf", mmPerUnit: 0 }, "mmPerUnit must be between"],
  ])("refuses %s", (_name, input, message) => {
    expect(refusal(input)).toContain(message);
  });
});

// ---------------------------------------------------------------------------------------------
// The exporter, against a fake AutoCAD console that reads its scripts and writes its outputs.

interface ConsoleRun {
  script: string;
  workDirectory: string;
  args: readonly string[];
  options: ExportRunOptions;
}

/** What the console does for one run; a returned string is what it prints. */
type Behave = (run: ConsoleRun) => Promise<string | void> | string | void;

const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d49484452000006400000050008020000000000000000", "hex");

// Every output differs, so a replaced file is visibly a new one.
let outputs = 0;
/** What AutoCAD's console writes for each script Inertia generates. */
const realistic: Behave = ({ script, workDirectory }) => {
  outputs += 1;
  const write = (name: string, contents: string | Buffer): void => writeFileSync(join(workDirectory, name), contents);
  if (script.includes("probe.pdf")) return ES_PROBE;
  if (script.includes("out.png")) write("out.png", PNG_HEADER);
  else if (script.includes("out.pdf")) write("out.pdf", "%PDF-1.7");
  else if (script.includes("out.dxf")) write("out.dxf", `0\nEOF ${outputs}`);
  else if (script.includes("_.-INSERT")) write("out.dwg", `AC1032 ${outputs}`);
  else if (script.includes("inrnew.dwg")) write("inrnew.dwg", "AC1032 temp");
  else if (script.includes("out.dwg")) write("out.dwg", `AC1032 ${outputs}`);
  return undefined;
};

function fakeConsole(acadDirectory: string | undefined, behave: Behave) {
  const runs: ConsoleRun[] = [];
  const registryQueries: (readonly string[])[] = [];
  const run: ExportRunner = async (executable, args, options) => {
    if (basename(executable) === "reg.exe") {
      registryQueries.push(args);
      return {
        stdout: Buffer.from(
          acadDirectory === undefined
            ? ""
            : `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Autodesk\\AutoCAD\\R25.0\\ACAD-8101:409\r\n    AcadLocation    REG_SZ    ${acadDirectory}\r\n`,
          "latin1",
        ),
      };
    }
    const consoleRun: ConsoleRun = { script: readFileSync(args[3] ?? "", "latin1"), workDirectory: options.cwd, args, options };
    runs.push(consoleRun);
    const printed = await behave(consoleRun);
    // The real console writes UTF-16LE.
    return { stdout: Buffer.from(printed ?? "", "utf16le") };
  };
  return { run, runs, registryQueries };
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A scratch folder with an AutoCAD install, a state folder and a work folder, and the exporter over them. */
async function setup(options: {
  installed?: boolean;
  documents?: CadDocument[];
  platform?: NodeJS.Platform;
  behave?: Behave;
  now?: () => number;
} = {}) {
  const root = await temporaryRoot("inertia-cad-export-");
  const acadDirectory = join(root, "AutoCAD 2025");
  mkdirSync(acadDirectory);
  if (options.installed !== false) writeFileSync(join(acadDirectory, "accoreconsole.exe"), "");
  const work = join(root, "work");
  mkdirSync(work);
  const state = join(root, "state");
  const fake = fakeConsole(acadDirectory, options.behave ?? realistic);
  const exporter = new CadExporter({
    stateDirectory: state,
    platform: options.platform ?? "win32",
    // Keeps the Program Files fallback away from a real AutoCAD on the test machine.
    programFiles: root,
    systemRoot: join(root, "Windows"),
    documents: async () => options.documents ?? [],
    run: fake.run,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const scratch = join(state, "exports");
  return {
    root,
    state,
    work,
    exporter,
    runs: fake.runs,
    registryQueries: fake.registryQueries,
    leftovers: (): string[] => (existsSync(scratch) ? readdirSync(scratch) : []),
    file: (name: string, contents: string): string => {
      const path = join(work, name);
      writeFileSync(path, contents);
      return path;
    },
  };
}

async function failureOf(promise: Promise<unknown>): Promise<CadError> {
  const outcome = await promise.then(
    () => new Error("expected the export to fail"),
    (error: unknown) => error,
  );
  if (!(outcome instanceof CadError)) throw outcome;
  return outcome;
}

describe("CadExporter", () => {
  it("works on a copy: the original path never reaches the console and the file is untouched", async () => {
    const { exporter, runs, file, leftovers, state } = await setup();
    const source = file("Plan nau.dwg", "AC1032 the designer's drawing");
    const before = statSync(source);
    const result = await exporter.export({ source, format: "png" });
    expect(result.screenshot).toMatchObject({ width: 1600, height: 1280 });
    expect(Buffer.from(result.screenshot?.pngBase64 ?? "", "base64")).toEqual(PNG_HEADER);
    expect(result.path).toBeUndefined();
    expect(result.areaPlotted).toEqual({ min: [2249.873076, 1642.852011], max: [2462.024371, 1755.458641] });
    expect(runs.map((run) => run.script.includes("probe.pdf"))).toEqual([true, false]);
    for (const run of runs) {
      expect(run.args.join(" ")).not.toContain(dirname(source));
      expect(run.script).not.toContain("Plan nau");
      expect(run.args.slice(4)).toEqual(["/isolate", "inertia", join(state, "accoreconsole")]);
    }
    const after = statSync(source);
    expect(readFileSync(source, "utf8")).toBe("AC1032 the designer's drawing");
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(leftovers()).toEqual([]);
  });

  it("reports unsaved changes, and keeps exports of the designer's drawings out of their folder", async () => {
    const root = await temporaryRoot("inertia-cad-doc-");
    const path = join(root, "Plan.dwg");
    writeFileSync(path, "AC1032");
    const document: CadDocument = {
      documentId: `acad:${path}`,
      app: "autocad",
      name: "Plan.dwg",
      path,
      modified: true,
      active: true,
    };
    const { exporter, state } = await setup({ documents: [document] });
    const result = await exporter.export({ source: document.documentId, format: "pdf", paper: "A3" });
    expect(result).toMatchObject({ liveUnsaved: true, sourcePath: path, paper: "A3" });
    expect(result.path).toBe(join(state, "exported", "Plan.pdf"));
    expect(readdirSync(root)).toEqual(["Plan.dwg"]);
    const byPath = await exporter.export({ source: path, format: "png" });
    expect(byPath.liveUnsaved).toBe(true);
  });

  it("overwrites only its own earlier export; anything else gets a stamped name or a refusal", async () => {
    const { exporter, work, file } = await setup();
    const source = file("facade.dxf", "0\nEOF");
    const first = await exporter.export({ source, format: "dwg" });
    expect(first).toMatchObject({ path: join(work, "facade.dwg"), next: DWG_NEXT });
    const firstContents = readFileSync(first.path ?? "", "utf8");
    const second = await exporter.export({ source, format: "dwg" });
    expect(second.path).toBe(first.path);
    expect(readFileSync(second.path ?? "", "utf8")).not.toBe(firstContents);
    expect(readdirSync(work).sort()).toEqual(["facade.dwg", "facade.dxf"]);
    const fromOwnDwg = await exporter.export({ source: second.path ?? "", format: "pdf" });
    expect(fromOwnDwg.path).toBe(join(work, "facade.pdf"));

    writeFileSync(first.path ?? "", "the designer saved over it");
    const third = await exporter.export({ source, format: "dwg" });
    expect(third.path).toMatch(/facade \(Inertia export \d{4}-\d\d-\d\d \d{6}\)\.dwg$/u);
    expect(readFileSync(first.path ?? "", "utf8")).toBe("the designer saved over it");

    const foreign = file("Elsewhere.dwg", "not Inertia's");
    const refused = await failureOf(exporter.export({ source, format: "dwg", destination: foreign }));
    expect(refused.code).toBe("DESTINATION_EXISTS");
    expect(readFileSync(foreign, "utf8")).toBe("not Inertia's");

    const sameAsSource = await exporter.export({ source, format: "dxf" });
    expect(sameAsSource.path).toMatch(/facade \(Inertia export .*\)\.dxf$/u);
    expect(readFileSync(source, "utf8")).toBe("0\nEOF");
  });

  it("stops at the timeout and leaves no partial file anywhere", async () => {
    const { exporter, work, file, leftovers } = await setup({
      behave: (run) => {
        if (!run.script.includes("out.pdf")) return realistic(run);
        writeFileSync(join(run.workDirectory, "out.pdf"), "%PDF-partial");
        throw new RestrictedCliError("timeout", "accoreconsole.exe took too long to complete.");
      },
    });
    const source = file("Plan.dwg", "AC1032");
    const error = await failureOf(exporter.export({ source, format: "pdf" }));
    expect(error.code).toBe("EXPORT_TIMEOUT");
    expect(readdirSync(work)).toEqual(["Plan.dwg"]);
    expect(leftovers()).toEqual([]);
  });

  it("fails when the console writes nothing, and when it is missing", async () => {
    const silent = await setup({ behave: () => undefined });
    const error = await failureOf(silent.exporter.export({ source: silent.file("a.dwg", "AC1032"), format: "dxf" }));
    expect(error.code).toBe("EXPORT_FAILED");

    const missing = await setup({ installed: false });
    expect(await missing.exporter.headless()).toBe(false);
    const notInstalled = await failureOf(missing.exporter.export({ source: missing.file("a.dwg", "AC1032"), format: "dxf" }));
    expect(notInstalled.code).toBe("NOT_INSTALLED");
    expect(missing.runs).toEqual([]);
  });

  it("builds a dwg on a template in two passes, and refuses other sources and options", async () => {
    const { exporter, runs, file } = await setup();
    const source = file("new.dxf", "0\nEOF");
    const template = file("Plan.dwg", "AC1032");
    const built = await exporter.export({ source, format: "dwg", template, destination: join(dirname(source), "built.dwg") });
    expect(built.next).toBe(DWG_NEXT);
    expect(built.warnings).toEqual([TEMPLATE_NOTE]);
    expect(runs.map((run) => basename(run.args[1] ?? ""))).toEqual(["in.dxf", "template.dwg"]);

    const refusals: [CadExportInput, string][] = [
      [{ source: template, format: "dwg" }, "dwg builds a new drawing from a .dxf"],
      [{ source, format: "dxf", template }, "template applies only to dwg"],
      [{ source, format: "png", mmPerUnit: 20 }, "mmPerUnit applies only to pdf"],
      [{ source, format: "dxf", area: { min: [0, 0], max: [1, 1] } }, "area applies only to png and pdf"],
      [{ source: "relative\\plan.dwg", format: "png" }, "absolute path"],
      [{ source: "skp:1:model", format: "png" }, "SketchUp"],
      [{ source: "acad:missing", format: "png" }, "Unknown documentId"],
    ];
    for (const [input, message] of refusals) {
      expect((await failureOf(exporter.export(input))).message).toContain(message);
    }
    expect(runs).toHaveLength(2);
  });

  it("is unsupported outside Windows", async () => {
    const { exporter, file, runs, registryQueries } = await setup({ platform: "darwin" });
    const source = file("a.dwg", "AC1032");
    expect((await failureOf(exporter.export({ source, format: "png" }))).code).toBe("UNSUPPORTED_PLATFORM");
    expect((await failureOf(exporter.destinationFor({ source, format: "pdf" }))).code).toBe("UNSUPPORTED_PLATFORM");
    expect(await exporter.headless()).toBe(false);
    expect(runs).toEqual([]);
    expect(registryQueries).toEqual([]);
  });

  it("finds the console in Program Files, newest release first, when the registry has none", async () => {
    const root = await temporaryRoot("inertia-cad-pf-");
    for (const release of ["AutoCAD 2024", "AutoCAD 2026", "AutoCAD LT 2027"]) {
      mkdirSync(join(root, "Autodesk", release), { recursive: true });
      writeFileSync(join(root, "Autodesk", release, "accoreconsole.exe"), "");
    }
    const fake = fakeConsole(undefined, realistic);
    const exporter = new CadExporter({
      stateDirectory: join(root, "state"),
      platform: "win32",
      programFiles: root,
      documents: async () => [],
      run: fake.run,
    });
    expect(await exporter.headless()).toBe(true);
    expect(fake.registryQueries).toEqual([["query", "HKLM\\SOFTWARE\\Autodesk\\AutoCAD", "/s", "/v", "AcadLocation"]]);
    const source = join(root, "a.dxf");
    writeFileSync(source, "0\nEOF");
    await exporter.export({ source, format: "dwg" });
    expect(fake.runs).toHaveLength(1);
    // The located console is remembered, so the registry is asked only once.
    expect(fake.registryQueries).toHaveLength(1);
  });

  it("gives each pass what is left of one 55-second budget, at least 5 seconds, under a 1 MiB output cap", async () => {
    let clock = 1_000_000;
    const { exporter, runs, file } = await setup({
      now: () => clock,
      behave: (run) => {
        const printed = realistic(run);
        // The probe takes 52 seconds, leaving 3: the plot still gets the 5-second minimum.
        if (run.script.includes("probe.pdf")) clock += 52_000;
        return printed;
      },
    });
    await exporter.export({ source: file("Plan.dwg", "AC1032"), format: "png" });
    expect(runs.map((run) => run.options.timeoutMs)).toEqual([55_000, 5_000]);
    expect(runs.map((run) => run.options.maxOutputBytes)).toEqual([1024 * 1024, 1024 * 1024]);
    expect(runs.map((run) => run.options.cwd)).toEqual([runs[0]?.workDirectory, runs[0]?.workDirectory]);
  });

  it("fails clearly when the console prints more than Inertia reads, leaving nothing behind", async () => {
    const { exporter, work, file, leftovers } = await setup({
      behave: (run) => {
        if (run.script.includes("out.dwg")) writeFileSync(join(run.workDirectory, "out.dwg"), "AC1032 half");
        throw new RestrictedCliError("output-limit", "accoreconsole.exe returned more output than Inertia can safely process.");
      },
    });
    const error = await failureOf(exporter.export({ source: file("big.dxf", "0\nEOF"), format: "dwg" }));
    expect(error.code).toBe("EXPORT_FAILED");
    expect(error.message).toContain("more output than Inertia reads");
    expect(readdirSync(work)).toEqual(["big.dxf"]);
    expect(leftovers()).toEqual([]);
  });

  it("answers CANCELLED when the caller cancels, before or during a pass", async () => {
    const controller = new AbortController();
    const { exporter, runs, work, file } = await setup({
      behave: (run) => {
        if (run.script.includes("probe.pdf")) {
          controller.abort();
          throw new RestrictedCliError("timeout", "accoreconsole.exe was cancelled.");
        }
        return realistic(run);
      },
    });
    const source = file("Plan.dwg", "AC1032");
    const during = await failureOf(exporter.export({ source, format: "pdf" }, controller.signal));
    expect(during.code).toBe("CANCELLED");
    expect(runs[0]?.options.signal).toBe(controller.signal);
    expect(runs).toHaveLength(1);
    const before = await failureOf(exporter.export({ source, format: "pdf" }, controller.signal));
    expect(before.code).toBe("CANCELLED");
    expect(runs).toHaveLength(1);
    expect(readdirSync(work)).toEqual(["Plan.dwg"]);
  });

  it("runs one export at a time", async () => {
    let active = 0;
    let most = 0;
    const { exporter, file } = await setup({
      behave: async (run) => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return realistic(run);
      },
    });
    const sources = ["a.dxf", "b.dxf", "c.dxf"].map((name) => file(name, "0\nEOF"));
    const results = await Promise.all(sources.map(async (source) => await exporter.export({ source, format: "dwg" })));
    expect(most).toBe(1);
    expect(results.map((result) => basename(result.path ?? ""))).toEqual(["a.dwg", "b.dwg", "c.dwg"]);
  });

  it.each([
    ["CON.pdf"],
    ["nul .pdf"],
    ["Aux..pdf"],
    ["COM1.pdf"],
    ["com¹.pdf"],
    ["LPT9.backup.pdf"],
    ["prn.pdf"],
  ])("refuses the Windows device name %s for destination and source", async (name) => {
    const { exporter, work, file, runs } = await setup();
    const source = file("Plan.dwg", "AC1032");
    for (const attempt of [
      async () => await exporter.export({ source, format: "pdf", destination: join(work, name) }),
      async () => await exporter.destinationFor({ source, format: "pdf", destination: join(work, name) }),
      async () => await exporter.export({ source: join(work, name.replace(/\.pdf$/u, ".dwg")), format: "png" }),
    ]) {
      const error = await failureOf(attempt());
      expect(error.code).toBe("INVALID_REQUEST");
      expect(error.message).toContain("Windows device");
    }
    expect(runs).toEqual([]);
    expect(readdirSync(work)).toEqual(["Plan.dwg"]);
  });

  it("still writes names that only look like devices", async () => {
    const { exporter, work, file } = await setup();
    const source = file("Plan.dwg", "AC1032");
    for (const name of ["console.pdf", "COM10.pdf", "nul-plan.pdf"]) {
      const result = await exporter.export({ source, format: "pdf", destination: join(work, name) });
      expect(result.path).toBe(join(work, name));
    }
  });

  it("keeps export receipts in exports.jsonl, apart from the trimmed apply receipts", async () => {
    const { exporter, state, work, file } = await setup();
    const source = file("facade.dxf", "0\nEOF");
    const first = await exporter.export({ source, format: "dwg" });
    expect(existsSync(join(state, "receipts.jsonl"))).toBe(false);
    const receipts = readFileSync(join(state, "exports.jsonl"), "utf8").trim().split("\n");
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0] ?? "")).toMatchObject({ export: { path: first.path } });

    // Ownership survives any number of later receipts: exports.jsonl is never trimmed.
    const filler = Array.from({ length: 6_000 }, (_, index) =>
      JSON.stringify({ export: { path: join(work, `other-${index}.dwg`), sha256: "0".repeat(64) }, at: "2026-11-21T00:00:00.000Z" }));
    writeFileSync(join(state, "exports.jsonl"), `${receipts[0]}\n${filler.join("\n")}\n`);
    expect((await exporter.export({ source, format: "dwg" })).path).toBe(first.path);

    // An export-shaped line in the apply receipts grants nothing.
    const current = readFileSync(join(state, "exports.jsonl"), "utf8");
    writeFileSync(join(state, "receipts.jsonl"), current);
    writeFileSync(join(state, "exports.jsonl"), "");
    expect((await exporter.export({ source, format: "dwg" })).path).toMatch(/facade \(Inertia export .*\)\.dwg$/u);
  });

  it("names the file an export would write without running the console", async () => {
    const { exporter, work, file, runs, state } = await setup();
    const dxf = file("facade.dxf", "0\nEOF");
    const designers = file("Plan.dwg", "AC1032");
    expect(await exporter.destinationFor({ source: dxf, format: "dwg" })).toBe(join(work, "facade.dwg"));
    expect(await exporter.destinationFor({ source: designers, format: "pdf" })).toBe(join(state, "exported", "Plan.pdf"));
    expect(await exporter.destinationFor({ source: designers, format: "pdf", destination: join(work, "sheet.pdf") }))
      .toBe(join(work, "sheet.pdf"));
    expect((await failureOf(exporter.destinationFor({ source: designers, format: "png" }))).code).toBe("INVALID_REQUEST");
    expect((await failureOf(exporter.destinationFor({ source: dxf, format: "dwg", destination: designers }))).code)
      .toBe("DESTINATION_EXISTS");
    expect(runs).toEqual([]);

    const written: CadExportResult = await exporter.export({ source: dxf, format: "dwg" });
    // Its own earlier export is replaced, not stamped.
    expect(await exporter.destinationFor({ source: dxf, format: "dwg" })).toBe(written.path);
  });
});

describe("restrictedExportRunner", () => {
  const consoleFixture = (exitCode: number): string[] => [
    "-e",
    `process.stdout.write(Buffer.from('INR|V|0\\r\\nTama\\u00f1os de papel\\r\\n  "monochrome.stb"\\r\\n', 'utf16le'));process.exitCode=${exitCode}`,
  ];

  it.each([[0], [3]])("reads the console's UTF-16 output through the restricted runner, exit code %i", async (exitCode) => {
    const { stdout } = await restrictedExportRunner()(process.execPath, consoleFixture(exitCode), {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
    const probe = parseProbe(decodeConsole(stdout));
    expect(probe.namedPlotStyles).toBe(true);
    expect(probe.plotStyles).toEqual(["monochrome.stb"]);
  });

  it("rejects with the runner's own error when the program cannot start or prints too much", async () => {
    const missing = await restrictedExportRunner()(join(tmpdir(), "inertia-missing", "accoreconsole.exe"), [], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 1024 * 1024,
    }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(RestrictedCliError);
    expect(missing).toMatchObject({ code: "unavailable" });

    const flood = await restrictedExportRunner()(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(8192, 65))"], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      maxOutputBytes: 2048,
    }).catch((error: unknown) => error);
    expect(flood).toMatchObject({ code: "output-limit" });
  });
});
