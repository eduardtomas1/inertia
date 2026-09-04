import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "@babel/parser";

import { describe, expect, it } from "vitest";

import { runtimeMigrationCatalog } from "../../src/server/persistence/migrations/runtime-catalog";

interface LineageEntry {
  version: number;
  name: string;
  digest: string;
  sources?: ImplementationSource[];
}

interface ImplementationSource {
  path: string;
  symbols: string[];
  digest: string;
}

interface ImplementationSourceDefinition {
  path: string;
  symbols: string[];
}

function implementation(
  path: string,
  ...symbols: string[]
): ImplementationSourceDefinition {
  return { path, symbols: symbols.sort() };
}

const SQL_IDENTIFIER_SYMBOLS = [
  "SQLITE_IDENTIFIER",
  "quotedSqlIdentifier",
] as const;
const MODEL_ROUTING_MIGRATION_SYMBOLS = [
  "KNOWN_HARNESS_IDS",
  "MODEL_CAPABILITY_IDS",
  "MODEL_CAPABILITY_STATES",
  "NATIVE_BACKENDS",
  "NATIVE_HARNESS",
  "SECRET_OPTION_KEY",
  "boundedIdentitySchema",
  "boundedLabelSchema",
  "boundedModelSchema",
  "boundedOptionKeySchema",
  "containsSecretLikeOptionKey",
  "continuationIdentityForSelection",
  "continuationIdentitySchema",
  "fastModeProviderValue",
  "harnessIdSchema",
  "jsonValueSchema",
  "knownHarnessIdSchema",
  "modelBackendProfileIdSchema",
  "modelCapabilitySchema",
  "modelCapabilityStateSchema",
  "modelSelectionSchema",
  "nativeBackendProfile",
  "nativeHarnessId",
  "nativeModelSelection",
  "opaqueIdentitySchema",
  "safeProviderOptionsSchema",
] as const;

const IMPLEMENTATION_SOURCES = new Map<
  number,
  readonly ImplementationSourceDefinition[]
>([
  [17, [
    implementation(
      "src/server/persistence/migrations/legacy-schema.ts",
      "LEGACY_SCHEMA_SQL",
    ),
    implementation(
      "src/server/persistence/migrations/sql-identifiers.ts",
      ...SQL_IDENTIFIER_SYMBOLS,
    ),
    implementation(
      "src/server/persistence/migrations/turn-association-columns.ts",
      "TURN_ASSOCIATION_COLUMNS",
      "TURN_ASSOCIATION_TABLES",
      "ensureTurnAssociationColumns",
    ),
  ]],
  [18, [
    implementation(
      "src/server/persistence/migrations/runner.ts",
      "ACCESS_MODES",
      "INTERACTION_MODES",
      "PROVIDERS",
      "PUBLISHED_RELEASES_BY_SCHEMA",
      "TERMINAL_WORKSPACE_STATUSES",
      "TURN_OWNERSHIP_TABLES",
      "backfillLegacyAgentTurns",
      "buildResponseGroups",
      "chooseRunId",
      "groupByConversation",
      "hasTable",
      "isoTimestamp",
      "isWithinGroup",
      "normalizedConversation",
      "parseTimestamp",
      "publishedReleasesForSchema",
      "requireLegacyOwnershipSchema",
      "stableIdentifier",
      "tableColumns",
      "validRunId",
    ),
    implementation(
      "src/server/persistence/migrations/sql-identifiers.ts",
      ...SQL_IDENTIFIER_SYMBOLS,
    ),
  ]],
  [24, [
    implementation("src/server/persistence/codecs.ts", "legacyModelSelection"),
    implementation(
      "src/server/persistence/migrations/sql-identifiers.ts",
      ...SQL_IDENTIFIER_SYMBOLS,
    ),
    implementation(
      "src/shared/model-routing.ts",
      ...MODEL_ROUTING_MIGRATION_SYMBOLS,
    ),
  ]],
  [26, [
    implementation(
      "src/server/provider/metadata.ts",
      "AUTH_STATES",
      "AVAILABLE_FIELDS",
      "PROVIDER_METADATA_CATALOG_MODEL_ID",
      "cleanString",
      "nativeProviderMetadataScope",
      "normalizeProviderMetadataScope",
      "providerMetadataScopeKey",
    ),
    implementation(
      "src/shared/model-routing.ts",
      "KNOWN_HARNESS_IDS",
      "NATIVE_BACKENDS",
      "NATIVE_HARNESS",
      "boundedIdentitySchema",
      "knownHarnessIdSchema",
      "legacyProviderIdForHarness",
      "nativeBackendProfile",
      "nativeHarnessId",
    ),
  ]],
  [40, [implementation(
    "src/server/persistence/migrations/duo-deletion-trigger.ts",
    "rebuildPairedLaunchProjectDeletionTrigger",
  )]],
  [45, [implementation(
    "src/server/persistence/migrations/duo-deletion-trigger.ts",
    "protectInterruptedPairedLaunchDeletion",
  )]],
  [46, [
    implementation(
      "src/server/persistence/migrations/duo-comparison-migration.ts",
      "persistDuoThirdModelComparison",
    ),
    implementation(
      "src/server/persistence/migrations/duo-deletion-trigger.ts",
      "protectDuoComparisonDeletion",
    ),
  ]],
  [50, [implementation(
    "src/server/persistence/migrations/duo-deletion-trigger.ts",
    "protectCancellingDuoDeletion",
  )]],
  [56, [
    implementation(
      "src/server/persistence/codecs.ts",
      "isPersistedChatAttachment",
      "parseAttachments",
      "rendererSafeAttachments",
    ),
    implementation(
      "src/server/persistence/migrations/attachment-capabilities.ts",
      "sanitizePersistedAttachmentCapabilities",
    ),
    implementation(
      "src/shared/attachments.ts",
      "CHAT_ATTACHMENT_MIME_TYPES",
      "DOCUMENT_ATTACHMENT_MIME_TYPES",
      "IMAGE_ATTACHMENT_MIME_TYPES",
      "MAX_CHAT_ATTACHMENTS",
      "MAX_CHAT_ATTACHMENT_BYTES",
      "MAX_CHAT_ATTACHMENT_TOTAL_BYTES",
      "SPREADSHEET_ATTACHMENT_MIME_TYPES",
      "attachmentMimeByExtension",
      "chatAttachmentMimeTypeForName",
    ),
  ]],
  [62, [
    implementation(
      "src/server/persistence/migrations/duo-deletion-trigger.ts",
      "protectCancellingDuoDeletion",
    ),
    implementation(
      "src/server/persistence/migrations/native-kimi-provider.ts",
      "nativeKimiProviderMigration",
    ),
  ]],
  [68, [
    implementation(
      "src/server/persistence/migrations/duo-deletion-trigger.ts",
      "protectCancellingDuoDeletion",
    ),
    implementation(
      "src/server/persistence/migrations/native-gemini-provider.ts",
      "nativeGeminiProviderMigration",
    ),
  ]],
]);

function sha256(source: string): string {
  return createHash("sha256").update(source.replaceAll("\r\n", "\n")).digest("hex");
}

function selectedImplementations(
  source: string,
  path: string,
  symbols: readonly string[],
): string {
  const normalized = source.replaceAll("\r\n", "\n");
  const sourceFile = parse(normalized, {
    sourceType: "module",
    plugins: ["typescript"],
  });
  const declarations = new Map<string, string>();
  for (const statement of sourceFile.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (!declaration) continue;
    const text = declaration.start === null || declaration.end === null
      ? null
      : normalized.slice(declaration.start, declaration.end);
    if (!text) continue;
    if (declaration.type === "FunctionDeclaration" && declaration.id) {
      declarations.set(declaration.id.name, text);
      continue;
    }
    if (declaration.type !== "VariableDeclaration") continue;
    for (const variable of declaration.declarations) {
      if (variable.id.type === "Identifier") {
        declarations.set(variable.id.name, text);
      }
    }
  }
  return symbols.map((symbol) => {
    const declaration = declarations.get(symbol);
    if (!declaration) {
      throw new Error(`Migration lineage symbol ${symbol} is missing from ${path}.`);
    }
    return `${symbol}\0${declaration}`;
  }).join("\0");
}

async function implementationSources(version: number): Promise<ImplementationSource[]> {
  return await Promise.all((IMPLEMENTATION_SOURCES.get(version) ?? []).map(
    async ({ path, symbols }) => ({
      path,
      symbols,
      digest: sha256(selectedImplementations(
        await readFile(resolve(path), "utf8"),
        path,
        symbols,
      )),
    }),
  ));
}

function migrationDigest(
  migration: ReturnType<typeof runtimeMigrationCatalog>[number],
  sources: readonly ImplementationSource[],
): string {
  const operation = typeof migration.up === "string"
    ? migration.up
    : migration.up.toString();
  return createHash("sha256").update(JSON.stringify({
    version: migration.version,
    name: migration.name,
    foreignKeys: migration.foreignKeys ?? "on",
    operation,
    ...(sources.length > 0 ? { sources } : {}),
  })).digest("hex");
}

async function currentLineage(): Promise<LineageEntry[]> {
  return await Promise.all(runtimeMigrationCatalog().map(async (migration) => {
    const sources = await implementationSources(migration.version);
    return {
      version: migration.version,
      name: migration.name,
      digest: migrationDigest(migration, sources),
      ...(sources.length > 0 ? { sources } : {}),
    };
  }));
}

describe("released database migration lineage", () => {
  it("matches the durable per-migration lineage manifest exactly", async () => {
    const actual = await currentLineage();
    if (process.env.INERTIA_PRINT_DATABASE_LINEAGE === "true") {
      console.log(JSON.stringify({ format: 2, migrations: actual }, null, 2));
    }
    const manifest = JSON.parse(await readFile(
      resolve("database-migration-lineage.json"),
      "utf8",
    )) as { format: number; migrations: LineageEntry[] };
    expect(manifest.format).toBe(2);
    expect(manifest.migrations).toEqual(actual);
  });

  it("folds imported helper implementations into their migration digest", async () => {
    const migration = runtimeMigrationCatalog().find(({ version }) => version === 18);
    expect(migration?.name).toBe("BackfillLegacyAgentTurns");
    if (!migration) throw new Error("The legacy backfill migration is unavailable.");
    const sources = await implementationSources(18);
    const helperPath = "src/server/persistence/migrations/runner.ts";
    const helper = sources.find(({ path }) => path === helperPath);
    expect(helper?.symbols).toContain("backfillLegacyAgentTurns");
    if (!helper) throw new Error("The legacy backfill source is unavailable.");
    const completeHelperSource = await readFile(resolve(helperPath), "utf8");
    const helperSource = selectedImplementations(
      completeHelperSource,
      helperPath,
      helper.symbols,
    );
    expect(sources.find(({ path }) => path === helperPath)?.digest)
      .toBe(sha256(helperSource));
    const tamperedCompleteHelperSource = completeHelperSource.replace(
      "export function backfillLegacyAgentTurns(",
      "export function backfillLegacyAgentTurns(\n  /* lineage tamper */",
    );
    expect(tamperedCompleteHelperSource).not.toBe(completeHelperSource);
    const tamperedHelperSource = selectedImplementations(
      tamperedCompleteHelperSource,
      helperPath,
      helper.symbols,
    );
    expect(tamperedHelperSource).not.toBe(helperSource);
    const tamperedSources = sources.map((source) => source.path === helperPath
      ? { ...source, digest: sha256(tamperedHelperSource) }
      : source);
    expect(migrationDigest(migration, tamperedSources))
      .not.toBe(migrationDigest(migration, sources));
  });

  it("ignores unrelated maintenance outside pinned migration symbols", async () => {
    const definition = IMPLEMENTATION_SOURCES.get(18)?.find(
      ({ path }) => path.endsWith("/runner.ts"),
    );
    if (!definition) throw new Error("The legacy backfill source is unavailable.");
    const source = await readFile(resolve(definition.path), "utf8");
    expect(selectedImplementations(
      `${source}\nconst unrelatedFutureRunnerMaintenance = true;\n`,
      definition.path,
      definition.symbols,
    )).toBe(selectedImplementations(source, definition.path, definition.symbols));
  });

  it("folds migration 17's closed-over legacy SQL into its digest", async () => {
    const migration = runtimeMigrationCatalog().find(({ version }) => version === 17);
    expect(migration?.name).toBe("ExplicitTurnOwnership");
    if (!migration) throw new Error("Migration 17 is unavailable.");
    const sources = await implementationSources(17);
    const sqlPath = "src/server/persistence/migrations/legacy-schema.ts";
    const sql = sources.find(({ path }) => path === sqlPath);
    if (!sql) throw new Error("The legacy schema source is unavailable.");
    const sqlSource = selectedImplementations(
      await readFile(resolve(sqlPath), "utf8"),
      sqlPath,
      sql.symbols,
    );
    expect(sources.find(({ path }) => path === sqlPath)?.digest).toBe(sha256(sqlSource));
    const tamperedSources = sources.map((source) => source.path === sqlPath
      ? { ...source, digest: sha256(`${sqlSource}\n// legacy SQL tamper`) }
      : source);
    expect(migrationDigest(migration, tamperedSources))
      .not.toBe(migrationDigest(migration, sources));
  });
});
