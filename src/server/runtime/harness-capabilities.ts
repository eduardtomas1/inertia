import { createHash } from "node:crypto";

import type {
  AgentTurn,
  Conversation,
} from "../../shared/contracts";
import type {
  ProviderHostToolBridge,
  ProviderHostToolCall,
  ProviderHostToolDefinition,
  ProviderHostToolResult,
} from "../provider/contracts";
import type { HiddenProviderInstruction } from "./turns/request-context";

const MAX_CAPABILITY_PACKS = 16;
const MAX_CAPABILITY_TOOLS = 64;
const MAX_CAPABILITY_INSTRUCTIONS = 24;
const MAX_CAPABILITY_INSTRUCTION_BYTES = 24 * 1024;
const CAPABILITY_ID = /^[a-z][a-z0-9.-]{0,63}$/u;
const INSTRUCTION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TOOL_NAME = /^inertia_[a-z0-9_]{1,119}$/u;
const SAFE_METADATA = /^[^\u0000-\u001f\u007f]+$/u;
const EVIDENCE_KINDS = new Set<HarnessCapabilityEvaluation["evidenceKinds"][number]>([
  "browser-evidence",
  "git-artifact",
  "host-tool-result",
  "provider-event",
]);

export interface HarnessCapabilityContext {
  conversation: Conversation;
  turn: AgentTurn;
}

export interface HarnessCapabilityEvaluation {
  tags: readonly string[];
  evidenceKinds: readonly (
    | "browser-evidence"
    | "git-artifact"
    | "host-tool-result"
    | "provider-event"
  )[];
  scenarioIds: readonly string[];
}

export interface HarnessCapabilityTool {
  definition: ProviderHostToolDefinition;
  invoke(
    context: HarnessCapabilityContext,
    call: ProviderHostToolCall,
  ): Promise<ProviderHostToolResult>;
}

/** Reviewed, compiled Inertia behavior. Repository code is never loaded as a pack. */
export interface HarnessCapabilityPack {
  id: string;
  revision: number;
  title: string;
  summary: string;
  instructions: readonly HiddenProviderInstruction[];
  tools: readonly HarnessCapabilityTool[];
  evaluation: HarnessCapabilityEvaluation;
}

export interface HarnessCapabilityManifest {
  schemaVersion: 1;
  definitionDigest: string;
  packs: readonly {
    id: string;
    revision: number;
    title: string;
    summary: string;
    toolNames: readonly string[];
    evaluation: HarnessCapabilityEvaluation;
  }[];
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function safeMetadata(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > maximum
    || !SAFE_METADATA.test(normalized)
  ) throw new Error(`${label} is invalid.`);
  return normalized;
}

function safeMetadataList(
  values: readonly string[],
  label: string,
): readonly string[] {
  if (values.length > 32) throw new Error(`${label} contains too many values.`);
  const result = values.map((value) => safeMetadata(value, label, 100));
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} contains duplicate values.`);
  }
  return Object.freeze(result);
}

function safeEvidenceKinds(
  values: HarnessCapabilityEvaluation["evidenceKinds"],
): HarnessCapabilityEvaluation["evidenceKinds"] {
  if (
    values.length > EVIDENCE_KINDS.size
    || values.some((value) => !EVIDENCE_KINDS.has(value))
    || new Set(values).size !== values.length
  ) throw new Error("Capability evidence kinds are invalid.");
  return Object.freeze([...values]);
}

function failure(message: string): ProviderHostToolResult {
  return {
    success: false,
    text: JSON.stringify({ error: { code: "capability_rejected", message } }),
  };
}

/**
 * Deterministically composes Inertia-owned behavior above every rich provider
 * transport while leaving the provider harness and its native extensions intact.
 */
export class HarnessCapabilityRegistry {
  readonly #packs: readonly HarnessCapabilityPack[];
  readonly #tools: ReadonlyMap<string, HarnessCapabilityTool>;
  readonly #definitions: readonly ProviderHostToolDefinition[];
  readonly #instructions: readonly HiddenProviderInstruction[];
  readonly #manifest: HarnessCapabilityManifest;

  constructor(packs: readonly HarnessCapabilityPack[]) {
    if (packs.length === 0 || packs.length > MAX_CAPABILITY_PACKS) {
      throw new Error("The Inertia capability registry has an invalid pack count.");
    }
    const packIds = new Set<string>();
    const instructionLabels = new Set<string>();
    const tools = new Map<string, HarnessCapabilityTool>();
    let instructionCount = 0;
    let instructionBytes = 0;
    const validated = packs.map((pack) => {
      if (!CAPABILITY_ID.test(pack.id) || packIds.has(pack.id)) {
        throw new Error(`Invalid or duplicate Inertia capability pack '${pack.id}'.`);
      }
      if (!Number.isSafeInteger(pack.revision) || pack.revision < 1) {
        throw new Error(`Inertia capability pack '${pack.id}' has an invalid revision.`);
      }
      packIds.add(pack.id);
      const title = safeMetadata(pack.title, "Capability title", 100);
      const summary = safeMetadata(pack.summary, "Capability summary", 500);
      const validatedInstructions: HiddenProviderInstruction[] = [];
      for (const instruction of pack.instructions) {
        if (
          !INSTRUCTION_LABEL.test(instruction.label)
          || instructionLabels.has(instruction.label)
        ) {
          throw new Error(
            `Invalid or duplicate capability instruction '${instruction.label}'.`,
          );
        }
        if (instruction.text.length === 0 || instruction.text.includes("\0")) {
          throw new Error(`Capability instruction '${instruction.label}' is invalid.`);
        }
        instructionLabels.add(instruction.label);
        instructionCount += 1;
        instructionBytes += utf8Bytes(instruction.text);
        validatedInstructions.push(Object.freeze({ ...instruction }));
      }
      const validatedTools: HarnessCapabilityTool[] = [];
      for (const tool of pack.tools) {
        const { definition } = tool;
        if (
          !TOOL_NAME.test(definition.name)
          || tools.has(definition.name)
        ) {
          throw new Error(
            `Invalid or duplicate Inertia capability tool '${definition.name}'.`,
          );
        }
        if (!definition.inputValidator) {
          throw new Error(
            `Inertia capability tool '${definition.name}' has no runtime validator.`,
          );
        }
        safeMetadata(definition.description, "Capability tool description", 2_000);
        const invoke = tool.invoke;
        const validatedTool = Object.freeze({
          definition: Object.freeze({
            ...definition,
            inputSchema: Object.freeze({ ...definition.inputSchema }),
          }),
          invoke: (
            context: HarnessCapabilityContext,
            call: ProviderHostToolCall,
          ) => invoke(context, call),
        });
        tools.set(definition.name, validatedTool);
        validatedTools.push(validatedTool);
      }
      const evaluation = Object.freeze({
        tags: safeMetadataList(pack.evaluation.tags, "Capability evaluation tag"),
        evidenceKinds: safeEvidenceKinds(pack.evaluation.evidenceKinds),
        scenarioIds: safeMetadataList(
          pack.evaluation.scenarioIds,
          "Capability evaluation scenario",
        ),
      });
      return Object.freeze({
        ...pack,
        title,
        summary,
        instructions: Object.freeze(validatedInstructions),
        tools: Object.freeze(validatedTools),
        evaluation,
      });
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (
      tools.size > MAX_CAPABILITY_TOOLS
      || instructionCount > MAX_CAPABILITY_INSTRUCTIONS
      || instructionBytes > MAX_CAPABILITY_INSTRUCTION_BYTES
    ) throw new Error("The Inertia capability registry exceeds its bounded composition limits.");

    this.#packs = Object.freeze(validated);
    const orderedTools = this.#packs.flatMap((pack) => pack.tools);
    this.#tools = new Map(
      orderedTools.map((tool) => [tool.definition.name, tool]),
    );
    this.#definitions = Object.freeze(
      orderedTools.map(({ definition }) => Object.freeze({ ...definition })),
    );
    this.#instructions = Object.freeze(
      this.#packs.flatMap((pack) => (
        pack.instructions.map((instruction) => Object.freeze({ ...instruction }))
      )),
    );
    const packsManifest = this.#packs.map((pack) => Object.freeze({
      id: pack.id,
      revision: pack.revision,
      title: pack.title,
      summary: pack.summary,
      toolNames: Object.freeze(pack.tools.map(({ definition }) => definition.name)),
      evaluation: pack.evaluation,
    }));
    const digestInput = this.#packs.map((pack) => ({
      id: pack.id,
      revision: pack.revision,
      title: pack.title,
      summary: pack.summary,
      instructions: pack.instructions,
      tools: pack.tools.map(({ definition }) => ({
        name: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
        readOnly: definition.readOnly,
      })),
      evaluation: pack.evaluation,
    }));
    this.#manifest = Object.freeze({
      schemaVersion: 1,
      definitionDigest: createHash("sha256")
        .update(canonicalJson(digestInput), "utf8")
        .digest("hex"),
      packs: Object.freeze(packsManifest),
    });
  }

  instructions(): readonly HiddenProviderInstruction[] {
    return this.#instructions;
  }

  manifest(): HarnessCapabilityManifest {
    return this.#manifest;
  }

  bridgeFor(context: HarnessCapabilityContext): ProviderHostToolBridge {
    return {
      definitions: this.#definitions,
      invoke: async (call) => {
        const tool = this.#tools.get(call.tool);
        if (!tool) return failure("That Inertia capability tool is unavailable.");
        try {
          return await tool.invoke(context, call);
        } catch {
          return failure("The Inertia capability tool failed safely.");
        }
      },
    };
  }
}
