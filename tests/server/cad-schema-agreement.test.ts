// @inertia-test-suite portable
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { describe, expect, it } from "vitest";

import { createClaudeHostTools } from "../../src/server/provider/claude-host-tools";
import type { ProviderHostToolBridge } from "../../src/server/provider/contracts";
import { createProviderHostToolMcpSession } from "../../src/server/provider/host-tool-mcp-http";
import { ProviderHostToolRuntime } from "../../src/server/provider/host-tool-runtime";
import { CAD_TOOL_DEFINITIONS } from "../../src/server/runtime/cad-host-tools";

type Schema = Record<string, unknown>;
type Input = Record<string, unknown>;

const DOC = "skp:4242:1";
const ACAD_DOC = "acad:C:/Drawings/Plan.dwg";

/** One minimal valid sample of every preview operation. */
const OPERATIONS: Record<string, Input> = {
  "acad.create_layer": { name: "Doors" },
  "acad.set_layer": { handles: ["2A"], layer: "Doors" },
  "acad.set_color": { handles: ["2A"], color: 256 },
  "acad.set_text": { handles: ["2A"], text: "" },
  "acad.set_attribute": { handles: ["2A"], tag: "ROOM", value: "" },
  "acad.move": { handles: ["2A"], vector: [1, 2] },
  "acad.erase": { handles: ["2A"] },
  "acad.add_line": { start: [0, 0], end: [1, 1, 1] },
  "acad.add_polyline": { points: [[0, 0], [1, 1]] },
  "acad.add_circle": { center: [0, 0], radius: 0.5 },
  "acad.add_text": { position: [0, 0], height: 2.5, text: "Hi" },
  "skp.create_tag": { name: "Walls" },
  "skp.create_material": { name: "Oak", color: "#A0522d" },
  "skp.set_tag": { ids: ["11"], tag: "Walls" },
  "skp.set_material": { ids: ["11"], material: "Oak" },
  "skp.rename": { ids: ["11"], name: "" },
  "skp.move": { ids: ["11"], vectorMm: [0, 0, 100] },
  "skp.set_hidden": { ids: ["11"], hidden: true },
  "skp.erase": { ids: ["11"] },
  "skp.add_box": { originMm: [0, 0, 0], sizeMm: [1, 1, 1] },
};

const operation = (op: string, overrides: Input = {}): Input => ({ op, ...OPERATIONS[op], ...overrides });
const preview = (...operations: Input[]): Input => ({
  documentId: String(operations[0]?.op ?? "").startsWith("acad.") ? ACAD_DOC : DOC,
  operations,
});

function previewSamples(): { valid: Input[]; invalid: Input[] } {
  const valid: Input[] = Object.keys(OPERATIONS).map((op) => preview(operation(op)));
  valid.push(
    preview(operation("acad.create_layer", { color: 1 }), operation("acad.create_layer", { color: 255 })),
    preview(operation("acad.set_color", { color: 0 })),
    preview(operation("acad.add_polyline", { closed: true, layer: "A-WALL" })),
    preview(operation("acad.add_text", { rotationDeg: -90, layer: "A-TEXT" })),
    preview(operation("acad.add_line", { layer: "0" })),
    preview(operation("acad.add_circle", { center: [0, 0, 0], layer: "0" })),
    preview(operation("acad.move", { vector: [1, 2, 3] })),
    preview(operation("skp.create_material", { alpha: 0 }), operation("skp.create_material", { alpha: 1 })),
    preview(operation("skp.add_box", { name: "", tag: "Walls", material: "Oak" })),
    preview(operation("skp.set_hidden", { hidden: false })),
    preview(operation("skp.erase", { ids: ["12345678901234567890"] })),
    preview(operation("acad.erase", { handles: Array.from({ length: 500 }, (_, index) => index.toString(16)) })),
    preview(...Array.from({ length: 50 }, () => operation("skp.erase"))),
  );
  const invalid: Input[] = [
    preview({ op: "skp.explode", ids: ["11"] }),
    preview({ op: "acad.purge" }),
    preview({ ids: ["11"] }),
    { documentId: DOC, operations: [] },
    { documentId: DOC, operations: Array.from({ length: 51 }, () => operation("skp.erase")) },
    { operations: [operation("skp.erase")] },
    { documentId: DOC, operations: [operation("skp.erase")], extra: true },
    preview(operation("acad.create_layer", { color: 0 })),
    preview(operation("acad.create_layer", { name: "" })),
    preview(operation("acad.set_color", { color: 257 })),
    preview(operation("acad.set_color", { color: 1.5 })),
    preview(operation("acad.set_text", { text: "t".repeat(2001) })),
    preview(operation("acad.move", { vector: [1] })),
    preview(operation("acad.move", { vector: [1, 2, 3, 4] })),
    preview(operation("acad.move", { vector: ["1", 2] })),
    preview(operation("acad.erase", { handles: [] })),
    preview(operation("acad.erase", { handles: [""] })),
    preview(operation("acad.erase", { handles: ["x".repeat(33)] })),
    preview(operation("acad.erase", { handles: Array.from({ length: 501 }, () => "2A") })),
    preview(operation("acad.add_polyline", { points: [[0, 0]] })),
    preview(operation("acad.add_circle", { radius: 0 })),
    preview(operation("acad.add_text", { height: -1 })),
    preview(operation("acad.add_text", { text: "" })),
    preview(operation("skp.create_material", { color: "red" })),
    preview(operation("skp.create_material", { color: "#12345" })),
    preview(operation("skp.create_material", { alpha: 1.01 })),
    preview(operation("skp.move", { vectorMm: [0, 0] })),
    preview(operation("skp.add_box", { sizeMm: [1, 1, 1, 1] })),
    preview(operation("skp.erase", { ids: ["abc"] })),
    preview(operation("skp.erase", { ids: ["123456789012345678901"] })),
    preview(operation("skp.erase", { ids: [] })),
    preview(operation("skp.set_hidden", { hidden: "yes" })),
    preview(operation("skp.rename", { name: "n".repeat(201) })),
  ];
  for (const op of Object.keys(OPERATIONS)) {
    invalid.push(preview(operation(op, { extra: 1 })));
    // A field of the other app's operations never belongs to this one.
    invalid.push(preview(operation(op, op.startsWith("acad.") ? { ids: ["11"] } : { handles: ["2A"] })));
    for (const field of Object.keys(OPERATIONS[op]!)) {
      const { [field]: _dropped, ...rest } = operation(op);
      invalid.push(preview(rest));
    }
  }
  return { valid, invalid };
}

const appSamples = {
  valid: [{}, { app: "autocad" }, { app: "sketchup" }],
  invalid: [{ app: "revit" }, { app: null }, { app: "" }, { extra: 1 }],
};

const SAMPLES: Record<string, { valid: Input[]; invalid: Input[] }> = {
  inertia_cad_status: appSamples,
  inertia_cad_setup: appSamples,
  inertia_cad_get_selection: {
    valid: [{ documentId: DOC }, { documentId: DOC, limit: 1 }, { documentId: DOC, limit: 500 }, { documentId: "x".repeat(1024) }],
    invalid: [
      {}, { documentId: "skp:" }, { documentId: "x".repeat(1025) }, { documentId: 42 },
      { documentId: DOC, limit: 0 }, { documentId: DOC, limit: 501 }, { documentId: DOC, limit: 1.5 },
      { documentId: DOC, extra: true },
    ],
  },
  inertia_cad_query_objects: {
    valid: [
      { documentId: ACAD_DOC },
      { documentId: ACAD_DOC, types: ["LINE", "INSERT"], layer: "A-*", layout: "*", textContains: "ROOM", cursor: "0", limit: 50 },
      { documentId: DOC, types: [], tag: "Walls", nameContains: "Door", maxDepth: 0, cursor: "123456789" },
      { documentId: DOC, maxDepth: 32, types: Array.from({ length: 20 }, () => "group") },
      { documentId: ACAD_DOC, bbox: true, fields: "compact" },
      { documentId: ACAD_DOC, bbox: false, fields: "full" },
      { documentId: ACAD_DOC, within: { min: [0, 0], max: [100.5, -2] } },
      { documentId: ACAD_DOC, within: { min: [0, 0], max: [1, 1], mode: "crossing" } },
      { documentId: DOC, within: { min: [-1e6, 0], max: [1e6, 1], mode: "window" }, fields: "compact", tag: "Walls" },
    ],
    invalid: [
      { documentId: DOC, cursor: "1234567890" }, { documentId: DOC, cursor: "-1" }, { documentId: DOC, cursor: "1.5" },
      { documentId: DOC, cursor: 5 }, { documentId: DOC, types: Array.from({ length: 21 }, () => "group") },
      { documentId: DOC, types: [""] }, { documentId: DOC, maxDepth: 33 }, { documentId: DOC, maxDepth: -1 },
      { documentId: DOC, layer: "" }, { documentId: DOC, textContains: "t".repeat(201) }, { documentId: DOC, fields: ["all"] },
      { documentId: DOC, fields: "all" }, { documentId: DOC, fields: "" }, { documentId: DOC, fields: null },
      { documentId: DOC, bbox: "true" }, { documentId: DOC, bbox: 1 }, { documentId: DOC, bbox: { min: [0, 0], max: [1, 1] } },
      { documentId: DOC, within: { min: [0, 0] } }, { documentId: DOC, within: { max: [1, 1] } },
      { documentId: DOC, within: { min: [0], max: [1, 1] } }, { documentId: DOC, within: { min: [0, 0, 0], max: [1, 1] } },
      { documentId: DOC, within: { min: [0, 0], max: ["1", 1] } }, { documentId: DOC, within: { min: [0, 0], max: [1, 1], mode: "inside" } },
      { documentId: DOC, within: { min: [0, 0], max: [1, 1], mode: "WINDOW" } },
      { documentId: DOC, within: { min: [0, 0], max: [1, 1], layer: "0" } }, { documentId: DOC, within: [[0, 0], [1, 1]] },
    ],
  },
  inertia_cad_document_info: {
    valid: [{ documentId: DOC }, { documentId: ACAD_DOC }, { documentId: "x".repeat(1024) }],
    invalid: [
      {}, { documentId: "skp:" }, { documentId: "x".repeat(1025) }, { documentId: 42 },
      { documentId: DOC, limit: 10 }, { documentId: DOC, extra: true },
    ],
  },
  inertia_cad_capture_view: {
    valid: [
      { documentId: DOC }, { documentId: DOC, maxWidth: 64, maxHeight: 2048 },
      { documentId: ACAD_DOC, extents: true }, { documentId: ACAD_DOC, extents: false, maxWidth: 640 },
      { documentId: ACAD_DOC, bbox: { min: [0, 0], max: [1200, 800.5] } },
      { documentId: ACAD_DOC, bbox: { min: [-10, -10], max: [10, 10] }, maxHeight: 64 },
    ],
    invalid: [
      { documentId: DOC, maxWidth: 63 }, { documentId: DOC, maxHeight: 2049 }, { documentId: DOC, maxWidth: 100.5 },
      { documentId: DOC, format: "jpeg" }, { maxWidth: 64 },
      { documentId: ACAD_DOC, extents: "yes" }, { documentId: ACAD_DOC, extents: 1 }, { documentId: ACAD_DOC, extents: null },
      { documentId: ACAD_DOC, bbox: true }, { documentId: ACAD_DOC, bbox: { min: [0, 0] } },
      { documentId: ACAD_DOC, bbox: { max: [1, 1] } }, { documentId: ACAD_DOC, bbox: { min: [0, 0, 0], max: [1, 1] } },
      { documentId: ACAD_DOC, bbox: { min: [0, 0], max: [1] } }, { documentId: ACAD_DOC, bbox: { min: [0, 0], max: [1, "1"] } },
      { documentId: ACAD_DOC, bbox: { min: [0, 0], max: [1, 1], mode: "window" } },
      { documentId: ACAD_DOC, bbox: [[0, 0], [1, 1]] },
    ],
  },
  inertia_cad_preview_changes: previewSamples(),
  inertia_cad_apply_changes: {
    valid: [{ proposalId: "cadp_x" }, { proposalId: "p".repeat(64) }],
    invalid: [{}, { proposalId: "" }, { proposalId: "p".repeat(65) }, { proposalId: 7 }, { proposalId: "cadp_x", force: true }],
  },
  inertia_cad_save_copy: {
    valid: [{ documentId: DOC }, { documentId: DOC, destination: "/a.sk" }, { documentId: DOC, destination: "C:\\Models\\Copy.skp" }],
    invalid: [
      { documentId: DOC, destination: "a.sk" }, { documentId: DOC, destination: "d".repeat(1025) },
      { documentId: DOC, overwrite: true }, { destination: "/tmp/copy.skp" },
    ],
  },
};

/** Inputs where the advertised schema, the zod validator, and the expected verdict do not all agree. */
function disagreements(schemas: ReadonlyMap<string, Schema>): string[] {
  const json = new AjvJsonSchemaValidator();
  const found: string[] = [];
  for (const definition of CAD_TOOL_DEFINITIONS) {
    const samples = SAMPLES[definition.name]!;
    const validate = json.getValidator(schemas.get(definition.name)!);
    for (const [expected, inputs] of [[true, samples.valid], [false, samples.invalid]] as const) {
      for (const input of inputs) {
        const advertised = validate(input).valid;
        const parsed = definition.inputValidator!.safeParse(input).success;
        if (advertised !== expected || parsed !== expected) {
          found.push(`${definition.name} ${JSON.stringify(input).slice(0, 200)} expected=${expected} schema=${advertised} zod=${parsed}`);
        }
      }
    }
  }
  return found;
}

function keysIn(value: unknown, key: string): number {
  if (Array.isArray(value)) return value.reduce<number>((count, item) => count + keysIn(item, key), 0);
  if (value === null || typeof value !== "object") return 0;
  return Object.entries(value).reduce((count, [name, child]) => count + (name === key ? 1 : 0) + keysIn(child, key), 0);
}

function fixtureRuntime(): ProviderHostToolRuntime {
  const bridge: ProviderHostToolBridge = {
    definitions: CAD_TOOL_DEFINITIONS,
    invoke: async () => ({ success: true, text: "{}" }),
  };
  return new ProviderHostToolRuntime({
    bridge, conversationId: "thread", turnId: "turn", cwd: "/project",
    onApproval: () => undefined, onApprovalResolved: () => undefined,
  });
}

describe("CAD tool schemas", () => {
  it("have samples for every tool", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(CAD_TOOL_DEFINITIONS.map(({ name }) => name).sort());
    for (const [tool, samples] of Object.entries(SAMPLES)) {
      expect(samples.valid.length, tool).toBeGreaterThan(0);
      expect(samples.invalid.length, tool).toBeGreaterThan(0);
    }
  });

  it("cover every preview operation with a sample", () => {
    const operations = CAD_TOOL_DEFINITIONS.find(({ name }) => name === "inertia_cad_preview_changes")!.inputSchema as Schema;
    const items = ((operations.properties as Record<string, Schema>).operations!.items ?? {}) as Schema;
    const branches = (items.anyOf ?? []) as Schema[];
    const advertised = branches.map((branch) => ((branch.properties as Record<string, Schema>).op!).const);
    expect(advertised).toHaveLength(20);
    expect(advertised.sort()).toEqual(Object.keys(OPERATIONS).sort());
  });

  it("advertise no $schema dialect and no oneOf", () => {
    for (const definition of CAD_TOOL_DEFINITIONS) {
      expect(keysIn(definition.inputSchema, "$schema"), definition.name).toBe(0);
      expect(keysIn(definition.inputSchema, "oneOf"), definition.name).toBe(0);
      expect(definition.inputSchema.type, definition.name).toBe("object");
      expect(definition.inputSchema.additionalProperties, definition.name).toBe(false);
    }
    const preview = CAD_TOOL_DEFINITIONS.find(({ name }) => name === "inertia_cad_preview_changes")!;
    expect(keysIn(preview.inputSchema, "anyOf")).toBeGreaterThan(0);
  });

  it("agree with their validators in the raw definitions (also sent to Codex thread/start)", () => {
    const schemas = new Map(CAD_TOOL_DEFINITIONS.map((tool) => [tool.name, tool.inputSchema as Schema]));
    expect(disagreements(schemas)).toEqual([]);
  });

  it("agree with their validators in the Claude SDK tools/list override", async () => {
    const tools = createClaudeHostTools(fixtureRuntime());
    const client = new Client({ name: "inertia-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await tools.config.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name).sort()).toEqual(CAD_TOOL_DEFINITIONS.map(({ name }) => name).sort());
      expect(disagreements(new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema as Schema])))).toEqual([]);
    } finally {
      await tools.close();
      await client.close();
    }
  });

  it("agree with their validators in the HTTP bridge tools/list", async () => {
    const session = createProviderHostToolMcpSession(fixtureRuntime());
    try {
      const connection = await session.start();
      const response = await fetch(connection.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.bearerToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const listed = ListToolsResultSchema.parse(((await response.json()) as { result: unknown }).result);
      expect(disagreements(new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema as Schema])))).toEqual([]);
    } finally {
      await session.close();
    }
  });
});
