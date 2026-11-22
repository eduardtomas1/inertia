// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAD_GUIDE_AUTOCAD,
  CAD_GUIDE_PRESENTATION,
  CAD_GUIDE_SKETCHUP,
} from "../../src/server/cad/bridge-sources";
import { CadError } from "../../src/server/cad/cad-hosts";
import type { CadExporter, CadExportInput, CadExportResult } from "../../src/server/cad/cad-export";
import { CadService } from "../../src/server/cad/cad-service";
import type {
  ProviderHostToolApprovalDecision,
  ProviderHostToolApprovalRequest,
  ProviderHostToolCall,
  ProviderHostToolResult,
} from "../../src/server/provider/contracts";
import { CadHostTools } from "../../src/server/runtime/cad-host-tools";
import {
  ACAD_DOCUMENT_ID,
  fakeCadHost,
  SKP_DOCUMENT_ID,
} from "../helpers/cad-fake-host";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await removeTemporaryDirectory(root)));
});

const PDF_RESULT: CadExportResult = {
  format: "pdf",
  path: "C:\\Work\\Plan.pdf",
  sourcePath: "C:\\Work\\Plan.dwg",
  sourceSavedAt: "2026-11-21T10:00:00.000Z",
  paper: "A3",
  mmPerUnit: 20,
  warnings: [],
};

const PNG_RESULT: CadExportResult = {
  format: "png",
  screenshot: { pngBase64: "iVBORw0KGgo=", width: 1600, height: 1280 },
  sourcePath: "C:\\Work\\Plan.dwg",
  sourceSavedAt: "2026-11-21T10:00:00.000Z",
  liveUnsaved: true,
  warnings: ["Plotted the last saved file."],
};

function fakeExporter(result: CadExportResult = PDF_RESULT, headless = true) {
  const exporter = {
    headless: vi.fn(async () => headless),
    destinationFor: vi.fn(async (input: CadExportInput) => input.destination ?? "C:\\Inertia\\exported\\Plan.pdf"),
    export: vi.fn(async (_input: CadExportInput, _signal?: AbortSignal) => result),
  };
  return { exporter, typed: exporter as unknown as CadExporter };
}

async function service(options: { exporter?: CadExporter } = {}) {
  const root = await mkdtemp(join(tmpdir(), "inertia-cad-export-tools-"));
  roots.push(root);
  const autocad = fakeCadHost("autocad", {
    query: () => ({ units: "mm", items: [{ handle: "1A" }] }),
    info: (params) => ({ documentId: ACAD_DOCUMENT_ID, style: params.style ?? null, layers: [] }),
  });
  const sketchup = fakeCadHost("sketchup", { info: () => ({ documentId: SKP_DOCUMENT_ID, tags: [] }) });
  const cad = new CadService({ hosts: [autocad, sketchup], stateDirectory: root, ...options });
  return { cad, autocad, tools: new CadHostTools(cad) };
}

function call(tool: string, args: unknown, decision: ProviderHostToolApprovalDecision = "approve") {
  return {
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: randomUUID(),
    tool,
    arguments: args,
    signal: new AbortController().signal,
    requestApproval: vi.fn(async (_request: ProviderHostToolApprovalRequest) => decision),
  } satisfies ProviderHostToolCall;
}

const body = (result: ProviderHostToolResult): Record<string, unknown> => JSON.parse(result.text) as Record<string, unknown>;

async function rejection(promise: Promise<unknown>): Promise<CadError> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(CadError);
  return error as CadError;
}

describe("CAD guides", () => {
  it("returns each embedded guide by topic", async () => {
    const { cad, tools } = await service();
    expect(cad.guide("autocad")).toEqual({ topic: "autocad", guide: CAD_GUIDE_AUTOCAD });
    expect(cad.guide("sketchup").guide).toBe(CAD_GUIDE_SKETCHUP);
    const result = await tools.invoke(call("inertia_cad_guide", { topic: "presentation" }), true);
    expect(body(result)).toEqual({ topic: "presentation", guide: CAD_GUIDE_PRESENTATION });
  });

  it("names Inertia's own tools and never T3's", () => {
    for (const guide of [CAD_GUIDE_AUTOCAD, CAD_GUIDE_SKETCHUP, CAD_GUIDE_PRESENTATION]) {
      expect(guide.length).toBeGreaterThan(500);
      expect(guide).toMatch(/inertia_cad_/u);
      expect(guide).not.toMatch(/(?<!inertia_)\bcad_[a-z]/u);
      expect(guide).not.toMatch(/\bT3\b/u);
    }
  });
});

describe("CAD service additions", () => {
  it("reports whether AutoCAD's console is available", async () => {
    expect((await (await service()).cad.status()).headless).toBe(false);
    const { typed } = fakeExporter(PDF_RESULT, true);
    expect((await (await service({ exporter: typed })).cad.status()).headless).toBe(true);
  });

  it("passes style to AutoCAD and refuses it for SketchUp", async () => {
    const { cad, autocad } = await service();
    expect(await cad.info({ documentId: ACAD_DOCUMENT_ID, style: true })).toMatchObject({ style: true });
    expect(autocad.calls.at(-1)?.params).toMatchObject({ documentId: ACAD_DOCUMENT_ID, style: true });
    const error = await rejection(cad.info({ documentId: SKP_DOCUMENT_ID, style: true }));
    expect(error).toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining("only in AutoCAD") });
  });

  it("drops the units echo from query pages", async () => {
    const { cad } = await service();
    expect(await cad.query({ documentId: ACAD_DOCUMENT_ID })).toEqual({ items: [{ handle: "1A" }] });
  });

  it("refuses exports where no exporter is configured", async () => {
    const { cad } = await service();
    expect((await rejection(cad.export({ source: ACAD_DOCUMENT_ID, format: "pdf" }))).code).toBe("UNSUPPORTED_PLATFORM");
  });
});

describe("inertia_cad_export", () => {
  it("exports to the default place without asking and returns the receipt as text", async () => {
    const { exporter, typed } = fakeExporter(PDF_RESULT);
    const { tools } = await service({ exporter: typed });
    const request = call("inertia_cad_export", { source: ACAD_DOCUMENT_ID, format: "pdf", paper: "A3", mmPerUnit: 20 });
    const result = await tools.invoke(request, true);
    expect(result.success).toBe(true);
    expect(result.images).toBeUndefined();
    expect(body(result)).toEqual(PDF_RESULT);
    expect(request.requestApproval).not.toHaveBeenCalled();
    expect(exporter.export).toHaveBeenCalledWith(
      { source: ACAD_DOCUMENT_ID, format: "pdf", paper: "A3", mmPerUnit: 20 },
      request.signal,
    );
  });

  it("asks the user before writing to a destination the agent chose, naming the file", async () => {
    const { exporter, typed } = fakeExporter(PDF_RESULT);
    const { tools } = await service({ exporter: typed });
    const request = call("inertia_cad_export", { source: ACAD_DOCUMENT_ID, format: "pdf", destination: "C:\\Work\\Out.pdf" });
    expect((await tools.invoke(request, true)).success).toBe(true);
    expect(request.requestApproval).toHaveBeenCalledTimes(1);
    expect(request.requestApproval.mock.calls[0]![0]).toMatchObject({ detail: expect.stringContaining("C:\\Work\\Out.pdf") });
    expect(exporter.export).toHaveBeenCalledTimes(1);
  });

  it.each([
    { decision: "deny" as const, code: "user_denied" },
    { decision: "timeout" as const, code: "approval_timed_out" },
  ])("writes nothing when the user answers $decision", async ({ decision, code }) => {
    const { exporter, typed } = fakeExporter(PDF_RESULT);
    const { tools } = await service({ exporter: typed });
    const result = await tools.invoke(call("inertia_cad_export", { source: ACAD_DOCUMENT_ID, format: "dwg", destination: "C:\\Work\\Out.dwg" }, decision), true);
    expect(result.success).toBe(false);
    expect(body(result)).toMatchObject({ error: { code } });
    expect(exporter.export).not.toHaveBeenCalled();
  });

  it("returns a png rendering as an image to a model that reads images", async () => {
    const { typed } = fakeExporter(PNG_RESULT);
    const { tools } = await service({ exporter: typed });
    const result = await tools.invoke(call("inertia_cad_export", { source: ACAD_DOCUMENT_ID, format: "png" }), true);
    expect(result.images).toEqual([{ mimeType: "image/png", data: "iVBORw0KGgo=" }]);
    const text = body(result);
    expect(text).toMatchObject({ format: "png", width: 1600, height: 1280, liveUnsaved: true });
    expect(text.screenshot).toBeUndefined();
  });

  it("refuses a png for a model that cannot read images, without running AutoCAD", async () => {
    const { exporter, typed } = fakeExporter(PNG_RESULT);
    const { tools } = await service({ exporter: typed });
    const result = await tools.invoke(call("inertia_cad_export", { source: ACAD_DOCUMENT_ID, format: "png" }), false);
    expect(body(result)).toMatchObject({ error: { code: "images_not_supported" } });
    expect(exporter.export).not.toHaveBeenCalled();
  });

  it("reports an export failure as a tool error", async () => {
    const { exporter, typed } = fakeExporter();
    exporter.export.mockRejectedValueOnce(new CadError("NOT_INSTALLED", "AutoCAD's console was not found."));
    const { tools } = await service({ exporter: typed });
    const result = await tools.invoke(call("inertia_cad_export", { source: ACAD_DOCUMENT_ID, format: "dxf" }), true);
    expect(body(result)).toEqual({ error: { code: "NOT_INSTALLED", message: "AutoCAD's console was not found." } });
  });
});
