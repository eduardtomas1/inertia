// @inertia-test-suite portable
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CadError } from "../../src/server/cad/cad-hosts";
import { CadService, copyName } from "../../src/server/cad/cad-service";
import type {
  ProviderHostToolApprovalDecision,
  ProviderHostToolCall,
  ProviderHostToolResult,
} from "../../src/server/provider/contracts";
import {
  CAD_TOOL_DEFINITIONS,
  CAD_TOOL_NAMES,
  CadHostTools,
  fitRows,
} from "../../src/server/runtime/cad-host-tools";
import { MAX_PROVIDER_HOST_TOOL_IMAGE_BYTES } from "../../src/shared/provider-host-tools";
import {
  ACAD_DOCUMENT_ID,
  cadDocument,
  fakeCadHost,
  type FakeCadHost,
  previewAnswer,
  SKP_DOCUMENT_ID,
} from "../helpers/cad-fake-host";
import { removeTemporaryDirectory } from "../helpers/temporary-directory";

const roots: string[] = [];
const NOW = Date.UTC(2026, 10, 21, 9, 30);
const RESULT_LIMIT = 30 * 1024;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTemporaryDirectory));
});

async function tools(hosts: FakeCadHost[] = [fakeCadHost("autocad"), fakeCadHost("sketchup")]) {
  const root = await mkdtemp(join(tmpdir(), "inertia-cad-tools-"));
  roots.push(root);
  const cad = new CadService({ hosts, stateDirectory: root, now: () => NOW });
  return { root, hosts, tools: new CadHostTools(cad) };
}

function call(
  tool: string,
  args: unknown,
  decision: ProviderHostToolApprovalDecision = "approve",
): ProviderHostToolCall & { requestApproval: ReturnType<typeof vi.fn> } {
  return {
    providerThreadId: "provider-thread",
    providerTurnId: "provider-turn",
    toolCallId: randomUUID(),
    tool,
    arguments: args,
    signal: new AbortController().signal,
    requestApproval: vi.fn(async () => decision),
  };
}

type Json = Record<string, unknown>;

const body = (result: ProviderHostToolResult): Json => JSON.parse(result.text) as Json;

function expectFailure(result: ProviderHostToolResult, code: string): Json {
  expect(result.success).toBe(false);
  const error = (body(result).error ?? {}) as Json;
  expect(error.code).toBe(code);
  expect(typeof error.message).toBe("string");
  return error;
}

const methods = (host: FakeCadHost): string[] => host.calls.map(({ method }) => method);

describe("CAD tool catalogue", () => {
  it("defines the eight inertia_cad tools", () => {
    expect([...CAD_TOOL_NAMES]).toEqual([
      "inertia_cad_status",
      "inertia_cad_setup",
      "inertia_cad_get_selection",
      "inertia_cad_query_objects",
      "inertia_cad_capture_view",
      "inertia_cad_preview_changes",
      "inertia_cad_apply_changes",
      "inertia_cad_save_copy",
    ]);
    const hints = Object.fromEntries(CAD_TOOL_DEFINITIONS.map(({ name, readOnly, destructive }) => [name, { readOnly, destructive }]));
    expect(hints.inertia_cad_preview_changes).toEqual({ readOnly: true, destructive: false });
    expect(hints.inertia_cad_apply_changes).toEqual({ readOnly: false, destructive: true });
  });

  it("answers unknown_tool for a name it does not own", async () => {
    const { tools: cad } = await tools();
    expectFailure(await cad.invoke(call("inertia_cad_delete_everything", {}), true), "unknown_tool");
  });
});

describe("CAD tool arguments and errors", () => {
  it("returns status as JSON", async () => {
    const { tools: cad } = await tools();
    const result = await cad.invoke(call("inertia_cad_status", undefined), true);
    expect(result.success).toBe(true);
    expect(body(result)).toMatchObject({ hosts: [{ app: "autocad" }, { app: "sketchup" }] });
    expect((body(await cad.invoke(call("inertia_cad_status", { app: "autocad" }), true)).hosts as Json[])).toHaveLength(1);
  });

  it.each([
    { tool: "inertia_cad_status", args: { app: "revit" } },
    { tool: "inertia_cad_get_selection", args: {} },
    { tool: "inertia_cad_get_selection", args: { documentId: SKP_DOCUMENT_ID, extra: true } },
    { tool: "inertia_cad_query_objects", args: { documentId: SKP_DOCUMENT_ID, cursor: "-1" } },
    { tool: "inertia_cad_capture_view", args: { documentId: SKP_DOCUMENT_ID, maxWidth: 32 } },
    { tool: "inertia_cad_preview_changes", args: { documentId: SKP_DOCUMENT_ID, operations: [{ op: "skp.explode", ids: ["1"] }] } },
    { tool: "inertia_cad_preview_changes", args: { documentId: SKP_DOCUMENT_ID, operations: [] } },
    { tool: "inertia_cad_apply_changes", args: { proposalId: "" } },
    { tool: "inertia_cad_save_copy", args: { documentId: "x" } },
  ])("refuses invalid $tool arguments $args before reaching a host", async ({ tool, args }) => {
    const { tools: cad, hosts } = await tools();
    const result = await cad.invoke(call(tool, args), true);
    const error = expectFailure(result, "invalid_arguments");
    expect(error.message).toContain(tool);
    expect(hosts.flatMap(methods)).toEqual([]);
  });

  it("turns a CadError into a coded failure", async () => {
    const sketchup = fakeCadHost("sketchup", {
      selection: () => {
        throw new CadError("HOST_BUSY", "Close the dialog in SketchUp.");
      },
    });
    const { tools: cad } = await tools([sketchup]);
    const result = await cad.invoke(call("inertia_cad_get_selection", { documentId: SKP_DOCUMENT_ID }), true);
    expect(result).toEqual({
      success: false,
      text: JSON.stringify({ error: { code: "HOST_BUSY", message: "Close the dialog in SketchUp." } }),
    });
  });

  it("refuses a document no host owns", async () => {
    const { tools: cad } = await tools();
    expectFailure(await cad.invoke(call("inertia_cad_get_selection", { documentId: "rvt:12345" }), true), "DOCUMENT_NOT_FOUND");
  });

  it("lets an unexpected host failure escape", async () => {
    const sketchup = fakeCadHost("sketchup", {
      selection: () => {
        throw new RangeError("bug");
      },
    });
    const { tools: cad } = await tools([sketchup]);
    await expect(cad.invoke(call("inertia_cad_get_selection", { documentId: SKP_DOCUMENT_ID }), true)).rejects.toThrow("bug");
  });
});

describe("inertia_cad_setup approval", () => {
  function plannedHosts(plan: string[] | undefined) {
    const autocad = fakeCadHost("autocad");
    const sketchup = fakeCadHost("sketchup");
    sketchup.plan = plan;
    return { autocad, sketchup };
  }

  const PLAN = [join(tmpdir(), "SketchUp 2025", "SketchUp", "Plugins", "inertia_cad_bridge.rb")];

  it("asks before writing the extension and runs setup on approval", async () => {
    const { autocad, sketchup } = plannedHosts(PLAN);
    const { tools: cad } = await tools([autocad, sketchup]);
    const request = call("inertia_cad_setup", {});
    const result = await cad.invoke(request, true);
    expect(request.requestApproval).toHaveBeenCalledTimes(1);
    expect(request.requestApproval.mock.calls[0]![0]).toMatchObject({
      title: "Install the Inertia SketchUp extension",
      detail: expect.stringContaining(PLAN[0]!),
      permissionRoots: [],
    });
    expect(result.success).toBe(true);
    expect(body(result)).toEqual({ results: [
      { app: "autocad", installedFor: ["autocad test"], restartRequired: false, note: "autocad ready" },
      { app: "sketchup", installedFor: ["sketchup test"], restartRequired: false, note: "sketchup ready" },
    ] });
  });

  it("writes nothing when the user declines", async () => {
    const { autocad, sketchup } = plannedHosts(PLAN);
    const { tools: cad } = await tools([autocad, sketchup]);
    expectFailure(await cad.invoke(call("inertia_cad_setup", { app: "sketchup" }, "deny"), true), "user_denied");
    expect(sketchup.setupCalls).toBe(0);
  });

  it("writes nothing when the approval times out", async () => {
    const { autocad, sketchup } = plannedHosts(PLAN);
    const { tools: cad } = await tools([autocad, sketchup]);
    expectFailure(await cad.invoke(call("inertia_cad_setup", {}, "timeout"), true), "approval_timed_out");
    expect(sketchup.setupCalls + autocad.setupCalls).toBe(0);
  });

  it.each([
    { label: "has no plan", plan: undefined },
    { label: "plans no paths", plan: [] },
  ])("runs setup without asking when the host $label", async ({ plan }) => {
    const { autocad, sketchup } = plannedHosts(plan);
    const { tools: cad } = await tools([autocad, sketchup]);
    const request = call("inertia_cad_setup", undefined);
    expect((await cad.invoke(request, true)).success).toBe(true);
    expect(request.requestApproval).not.toHaveBeenCalled();
    expect(sketchup.setupCalls).toBe(1);
  });

  it("asks only about the named app's writes", async () => {
    const { autocad, sketchup } = plannedHosts(PLAN);
    const { tools: cad } = await tools([autocad, sketchup]);
    const request = call("inertia_cad_setup", { app: "autocad" });
    expect(body(await cad.invoke(request, true))).toEqual({ results: [expect.objectContaining({ app: "autocad" })] });
    expect(request.requestApproval).not.toHaveBeenCalled();
    expect(sketchup.setupCalls).toBe(0);
  });
});

describe("inertia_cad_save_copy approval", () => {
  function savingHost(path: string | null = null) {
    const sketchup = fakeCadHost("sketchup", { save_copy: (params) => ({ savedTo: params.path }) });
    sketchup.documents = [cadDocument("sketchup", { path })];
    return sketchup;
  }

  it("shows the default destination in the approval and saves there", async () => {
    const original = join(tmpdir(), "House.skp");
    const sketchup = savingHost(original);
    const { tools: cad } = await tools([sketchup]);
    const request = call("inertia_cad_save_copy", { documentId: SKP_DOCUMENT_ID });
    const result = await cad.invoke(request, true);
    const destination = copyName(original, NOW);
    expect(request.requestApproval.mock.calls[0]![0]).toMatchObject({
      title: "Save a copy of the SketchUp document",
      detail: expect.stringContaining(destination),
    });
    expect(body(result)).toEqual({ savedTo: destination });
    expect(sketchup.calls.at(-1)).toMatchObject({ method: "save_copy", params: { documentId: SKP_DOCUMENT_ID, path: destination } });
  });

  it("asks even for an explicit destination", async () => {
    const destination = join(tmpdir(), "Explicit copy.skp");
    const { tools: cad } = await tools([savingHost()]);
    const request = call("inertia_cad_save_copy", { documentId: SKP_DOCUMENT_ID, destination });
    await cad.invoke(request, true);
    expect(request.requestApproval.mock.calls[0]![0].detail).toContain(destination);
  });

  it.each([
    { decision: "deny" as const, code: "user_denied" },
    { decision: "timeout" as const, code: "approval_timed_out" },
  ])("saves nothing on $decision", async ({ decision, code }) => {
    const sketchup = savingHost(join(tmpdir(), "House.skp"));
    const { tools: cad } = await tools([sketchup]);
    expectFailure(await cad.invoke(call("inertia_cad_save_copy", { documentId: SKP_DOCUMENT_ID }, decision), true), code);
    expect(methods(sketchup)).toEqual([]);
  });

  it.each([
    { label: "no file and no destination", args: { documentId: SKP_DOCUMENT_ID }, code: "DESTINATION_REQUIRED" },
    { label: "a relative destination", args: { documentId: SKP_DOCUMENT_ID, destination: "copy.skp" }, code: "INVALID_REQUEST" },
    { label: "the wrong extension", args: { documentId: SKP_DOCUMENT_ID, destination: join(tmpdir(), "copy.dwg") }, code: "INVALID_REQUEST" },
  ])("refuses $label without asking", async ({ args, code }) => {
    const sketchup = savingHost();
    const { tools: cad } = await tools([sketchup]);
    const request = call("inertia_cad_save_copy", args);
    expectFailure(await cad.invoke(request, true), code);
    expect(request.requestApproval).not.toHaveBeenCalled();
  });
});

describe("inertia_cad_capture_view", () => {
  function capturing(pngBase64: string, scene: string | null = "Scene 1") {
    return fakeCadHost("sketchup", {
      capture: (params) => ({ documentId: SKP_DOCUMENT_ID, width: params.maxWidth, height: 720, pngBase64, scene }),
    });
  }

  const png = (decodedBytes: number): string => Buffer.alloc(decodedBytes, 7).toString("base64");

  it("refuses without calling the host when the model cannot read images", async () => {
    const sketchup = capturing(png(16));
    const { tools: cad } = await tools([sketchup]);
    expectFailure(await cad.invoke(call("inertia_cad_capture_view", { documentId: SKP_DOCUMENT_ID }), false), "images_not_supported");
    expect(methods(sketchup)).toEqual([]);
  });

  it("returns the PNG as an image with 1280 px defaults", async () => {
    const data = png(64);
    const sketchup = capturing(data);
    const { tools: cad } = await tools([sketchup]);
    const result = await cad.invoke(call("inertia_cad_capture_view", { documentId: SKP_DOCUMENT_ID }), true);
    expect(sketchup.calls[0]!.params).toEqual({ documentId: SKP_DOCUMENT_ID, maxWidth: 1280, maxHeight: 1280 });
    expect(result).toEqual({
      success: true,
      text: JSON.stringify({ documentId: SKP_DOCUMENT_ID, width: 1280, height: 720, scene: "Scene 1" }),
      images: [{ mimeType: "image/png", data }],
    });
  });

  it("passes the requested size and leaves out a missing scene", async () => {
    const sketchup = capturing(png(8), null);
    const { tools: cad } = await tools([sketchup]);
    const result = await cad.invoke(call("inertia_cad_capture_view", { documentId: SKP_DOCUMENT_ID, maxWidth: 640, maxHeight: 480 }), true);
    expect(sketchup.calls[0]!.params).toMatchObject({ maxWidth: 640, maxHeight: 480 });
    expect(body(result)).toEqual({ documentId: SKP_DOCUMENT_ID, width: 640, height: 720 });
  });

  it("accepts a PNG of exactly 4 MiB", async () => {
    const { tools: cad } = await tools([capturing(png(MAX_PROVIDER_HOST_TOOL_IMAGE_BYTES))]);
    expect((await cad.invoke(call("inertia_cad_capture_view", { documentId: SKP_DOCUMENT_ID }), true)).success).toBe(true);
  });

  it("refuses a PNG over 4 MiB", async () => {
    const { tools: cad } = await tools([capturing(png(MAX_PROVIDER_HOST_TOOL_IMAGE_BYTES + 1))]);
    const result = await cad.invoke(call("inertia_cad_capture_view", { documentId: SKP_DOCUMENT_ID }), true);
    expectFailure(result, "CAPTURE_TOO_LARGE");
    expect(result.images).toBeUndefined();
  });
});

const row = (index: number): Json => ({ id: String(index), name: `Object ${index}`, notes: "n".repeat(80) });
const rows = (count: number): Json[] => Array.from({ length: count }, (_, index) => row(index));
const bigChange = (index: number) => ({ op: "skp.rename", target: `Group ${index}`, field: "name", before: "b".repeat(60), after: "a".repeat(60) });

describe("results cut to the size limit", () => {
  it("resumes a cut query from the first row left out", async () => {
    const sketchup = fakeCadHost("sketchup", { query: () => ({ items: rows(1_000), nextCursor: "1040" }) });
    const { tools: cad } = await tools([sketchup]);
    const result = await cad.invoke(call("inertia_cad_query_objects", { documentId: SKP_DOCUMENT_ID, cursor: "40" }), true);
    expect(result.success).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(RESULT_LIMIT);
    const page = body(result);
    const kept = (page.items as Json[]).length;
    expect(kept).toBeGreaterThan(100);
    expect(kept).toBeLessThan(1_000);
    expect(page.items).toEqual(rows(kept));
    expect(page.nextCursor).toBe(String(40 + kept));
  });

  it("starts a cut first page's cursor at zero", async () => {
    const sketchup = fakeCadHost("sketchup", { query: () => ({ items: rows(1_000) }) });
    const { tools: cad } = await tools([sketchup]);
    const page = body(await cad.invoke(call("inertia_cad_query_objects", { documentId: SKP_DOCUMENT_ID }), true));
    expect(page.nextCursor).toBe(String((page.items as Json[]).length));
    expect(page.truncated).toBeUndefined();
  });

  it("leaves a query that fits untouched", async () => {
    const answer = { items: rows(3), nextCursor: null };
    const sketchup = fakeCadHost("sketchup", { query: () => answer });
    const { tools: cad } = await tools([sketchup]);
    expect(body(await cad.invoke(call("inertia_cad_query_objects", { documentId: SKP_DOCUMENT_ID }), true))).toEqual(answer);
  });

  it("marks a cut selection as truncated", async () => {
    const sketchup = fakeCadHost("sketchup", { selection: () => ({ documentId: SKP_DOCUMENT_ID, items: rows(1_000) }) });
    const { tools: cad } = await tools([sketchup]);
    const result = await cad.invoke(call("inertia_cad_get_selection", { documentId: SKP_DOCUMENT_ID }), true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(RESULT_LIMIT);
    const selection = body(result);
    expect(selection).toMatchObject({ documentId: SKP_DOCUMENT_ID, truncated: true });
    expect(selection.nextCursor).toBeUndefined();
  });

  it("counts the changes a cut preview shows", async () => {
    const changes = Array.from({ length: 500 }, (_, index) => bigChange(index));
    const sketchup = fakeCadHost("sketchup", { preview: () => previewAnswer(SKP_DOCUMENT_ID, changes) });
    const { tools: cad } = await tools([sketchup]);
    const result = await cad.invoke(call("inertia_cad_preview_changes", {
      documentId: SKP_DOCUMENT_ID, operations: [{ op: "skp.rename", ids: ["1"], name: "x" }],
    }), true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(RESULT_LIMIT);
    const preview = body(result);
    expect(preview.proposalId).toEqual(expect.stringMatching(/^cadp_/u));
    expect(preview.changesTotal).toBe(500);
    expect(preview.changesShown).toBe((preview.changes as Json[]).length);
    expect(preview.changesShown).toBeLessThan(500);
  });

  it("counts the changes a cut apply receipt shows", async () => {
    const changes = Array.from({ length: 500 }, (_, index) => bigChange(index));
    const sketchup = fakeCadHost("sketchup", {
      preview: () => previewAnswer(SKP_DOCUMENT_ID, changes),
      apply: () => ({ status: "applied" }),
    });
    const { tools: cad } = await tools([sketchup]);
    const preview = body(await cad.invoke(call("inertia_cad_preview_changes", {
      documentId: SKP_DOCUMENT_ID, operations: [{ op: "skp.erase", ids: ["1"] }],
    }), true));
    const receipt = body(await cad.invoke(call("inertia_cad_apply_changes", { proposalId: preview.proposalId }), true));
    expect(receipt).toMatchObject({ status: "applied", changesTotal: 500 });
    expect(receipt.changesShown).toBe((receipt.changes as Json[]).length);
  });

  it("refuses an answer that cannot be cut small enough", async () => {
    const sketchup = fakeCadHost("sketchup", { selection: () => ({ items: [], blob: "x".repeat(RESULT_LIMIT) }) });
    const { tools: cad } = await tools([sketchup]);
    expectFailure(await cad.invoke(call("inertia_cad_get_selection", { documentId: SKP_DOCUMENT_ID }), true), "RESULT_TOO_LARGE");
  });

  it("refuses a preview with no changes when it is still too large", async () => {
    const acad = fakeCadHost("autocad", {
      preview: () => previewAnswer(ACAD_DOCUMENT_ID, [], ["w".repeat(RESULT_LIMIT)]),
    });
    const { tools: cad } = await tools([acad]);
    const result = await cad.invoke(call("inertia_cad_preview_changes", {
      documentId: ACAD_DOCUMENT_ID, operations: [{ op: "acad.erase", handles: ["2A"] }],
    }), true);
    expectFailure(result, "RESULT_TOO_LARGE");
  });
});

describe("fitRows", () => {
  it("returns the same object when it already fits", () => {
    const result = { items: rows(2) };
    expect(fitRows(result, "items", 0)).toBe(result);
  });

  it("keeps the most rows that fit under the limit", () => {
    const result = { items: rows(50) };
    const maximum = 2_000;
    const fitted = fitRows(result, "items", undefined, maximum)!;
    const kept = (fitted.items as Json[]).length;
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(maximum);
    const oneMore = { ...fitted, items: rows(kept + 1) };
    expect(Buffer.byteLength(JSON.stringify(oneMore))).toBeGreaterThan(maximum);
    expect(fitted.truncated).toBe(true);
  });

  it("returns undefined when the rows are not a list or nothing fits", () => {
    expect(fitRows({ items: "x".repeat(100) }, "items", 0, 50)).toBeUndefined();
    expect(fitRows({ items: rows(5), header: "h".repeat(100) }, "items", 0, 50)).toBeUndefined();
  });

  it("may keep zero rows when only the envelope fits", () => {
    expect(fitRows({ changes: rows(5) }, "changes", undefined, 60)).toEqual({ changes: [], changesShown: 0, changesTotal: 5 });
  });
});
