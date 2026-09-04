import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const CHANGE_DOMAINS = Object.freeze([
  "quality_shared",
  "runtime_supervisor",
  "process_containment",
  "startup_recovery",
  "provider_common",
  "provider_codex",
  "provider_claude",
  "provider_cursor",
  "provider_kimi",
  "provider_opencode",
  "turn_session",
  "agent_management",
  "database_migrations",
  "terminal_native",
  "updater",
  "windows_packaging",
  "linux_appimage",
  "macos_packaging",
  "renderer_ui",
  "performance",
  "ci_test_infrastructure",
]);

const ALL_DOMAIN_SET = new Set(CHANGE_DOMAINS);
const PROVIDER_DOMAINS = new Set([
  "provider_common",
  "provider_codex",
  "provider_claude",
  "provider_cursor",
  "provider_kimi",
  "provider_opencode",
  "turn_session",
  "agent_management",
]);
const FULL_CERTIFICATION_DOMAINS = new Set([
  "runtime_supervisor",
  "process_containment",
  "startup_recovery",
  "terminal_native",
  "updater",
  "windows_packaging",
  "linux_appimage",
  "macos_packaging",
  "renderer_ui",
  "performance",
]);

function normalizedRepositoryPath(input) {
  if (typeof input !== "string") return null;
  const path = input.replaceAll("\\", "/");
  if (
    path.length === 0
    || path.length > 512
    || path.startsWith("/")
    || path.endsWith("/")
    || path.includes("\0")
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return null;
  }
  return path;
}

function isDocumentation(path) {
  return (path.startsWith("docs/") && /\.(?:md|png)$/u.test(path))
    || path === "README.md"
    || path === "CONTRIBUTING.md"
    || path === "SECURITY.md"
    || (!path.includes("/") && path.endsWith(".md"));
}

function providerDomains(path) {
  const domains = new Set(["provider_common", "turn_session", "agent_management"]);
  const providerMatchers = [
    ["codex", "provider_codex"],
    ["claude", "provider_claude"],
    ["cursor", "provider_cursor"],
    ["kimi", "provider_kimi"],
    ["opencode", "provider_opencode"],
  ];
  let specific = false;
  for (const [needle, domain] of providerMatchers) {
    if (path.toLowerCase().includes(needle)) {
      domains.add(domain);
      specific = true;
    }
  }
  if (!specific) {
    for (const domain of PROVIDER_DOMAINS) domains.add(domain);
  }
  return domains;
}

function domainsForTestPath(path) {
  // Shared fixtures, runners, architecture assertions, and CI discovery can
  // change the meaning or execution of unrelated suites. Keep those broad.
  if (
    path.startsWith("tests/helpers/")
    || path.startsWith("tests/support/")
    || path.startsWith("tests/fixtures/")
    || path === "tests/architecture-checker.test.ts"
    || path === "tests/contracts-boundary.test.ts"
    || path.startsWith("tests/shared/")
    || path.startsWith("tests/scripts/ci-")
    || path.startsWith("tests/scripts/portable-")
    || path.startsWith("tests/scripts/windows-test-")
  ) return { domains: new Set(ALL_DOMAIN_SET), broad: true };

  if (path.startsWith("tests/performance/") || path.startsWith("benchmarks/")) {
    return { domains: new Set(["performance"]) };
  }
  if (path.startsWith("tests/renderer/") || path.startsWith("tests/e2e/")) {
    return { domains: new Set(["renderer_ui"]) };
  }
  if (
    path.startsWith("tests/main/app-update")
    || path.startsWith("tests/main/appimage-")
    || path.startsWith("tests/main/electron-app-updater")
    || path.startsWith("tests/main/canary-")
  ) {
    return {
      domains: new Set([
        "startup_recovery",
        "updater",
        "windows_packaging",
        "linux_appimage",
        "macos_packaging",
      ]),
    };
  }
  if (
    path.startsWith("tests/main/runtime-")
    || path.startsWith("tests/main/windows-runtime-")
    || path.startsWith("tests/main/terminal-")
    || path.startsWith("tests/scripts/runtime-process-")
  ) {
    return {
      domains: new Set([
        "runtime_supervisor",
        "process_containment",
        "startup_recovery",
        "terminal_native",
      ]),
    };
  }
  if (
    path.startsWith("tests/server/process-lifecycle")
    || path.startsWith("tests/server/terminal")
  ) {
    return { domains: new Set(["process_containment", "terminal_native"]) };
  }
  if (
    path.startsWith("tests/server/database")
    || path.startsWith("tests/server/persistence")
    || path.includes("database-migration")
  ) return { domains: new Set(["database_migrations"]) };

  if (
    path.startsWith("tests/server/")
    && /(?:codex|claude|cursor|kimi|opencode|provider|agent-harness|acp-)/iu
      .test(path)
  ) return { domains: providerDomains(path) };
  if (
    path.startsWith("tests/scripts/provider-")
    || path === "tests/model-routing.test.ts"
  ) return { domains: providerDomains(path) };
  if (
    path === "tests/continuation-policy.test.ts"
    || path.startsWith("tests/server/turn-")
    || path.startsWith("tests/server/runtime")
    || path.startsWith("tests/server/conversation-")
    || path.startsWith("tests/server/duo-")
  ) return { domains: new Set(PROVIDER_DOMAINS) };

  // An unmodeled test remains broad rather than silently losing evidence.
  return null;
}

function domainsForKnownPath(path) {
  if (isDocumentation(path)) return { domains: new Set(), documentation: true };

  if (path.startsWith("tests/") || path.startsWith("benchmarks/")) {
    return domainsForTestPath(path);
  }

  // CI definitions, test discovery, dependency graphs, shared contracts, and
  // architecture/build configuration can change every evidence path. They are
  // intentionally broad; saving a runner is never worth a false negative.
  if (
    path.startsWith(".github/")
    || path.startsWith("scripts/ci/")
    || path === "package.json"
    || path === "package-lock.json"
    || /^(?:vitest|playwright|electron\.vite|vite|eslint|tsconfig)/u.test(path)
    || path === "electron-builder.yml"
    || path.startsWith("src/shared/")
  ) {
    return { domains: new Set(ALL_DOMAIN_SET), broad: true };
  }

  if (path.startsWith("src/server/provider/")) {
    return { domains: providerDomains(path) };
  }

  // Server-side turn/session and child-agent orchestration are portable
  // lifecycle domains. They require every provider contract and the compact
  // desktop sentinels, but do not by themselves justify six native package
  // builds. Keep these rules before the broader server-runtime rule below.
  if (
    path.startsWith("src/server/runtime/turns/")
    || path === "src/server/runtime/run-state-engine.ts"
    || path.startsWith("src/server/runtime/commands/conversation")
    || path.startsWith("src/server/runtime/commands/turn-")
  ) {
    return { domains: new Set(PROVIDER_DOMAINS) };
  }

  if (
    path.startsWith("src/server/runtime/agent-")
    || path.startsWith("src/server/runtime/commands/agent-")
  ) {
    return { domains: new Set(PROVIDER_DOMAINS) };
  }

  if (
    path.startsWith("src/server/conversation")
    || path.startsWith("src/server/agent")
    || path.startsWith("src/server/turn")
  ) {
    return { domains: new Set(["turn_session", "agent_management", ...PROVIDER_DOMAINS]) };
  }

  if (
    path.startsWith("src/main/runtime")
    || path.startsWith("src/server/runtime")
    || path.startsWith("scripts/runtime-process-guardian")
    || path.startsWith("resources/runtime/")
  ) {
    return {
      domains: new Set([
        "runtime_supervisor",
        "process_containment",
        "startup_recovery",
        "terminal_native",
      ]),
    };
  }

  if (
    path.startsWith("src/main/terminal")
    || path.startsWith("src/server/terminal")
    || path.includes("node-pty")
    || path.includes("native-pty")
  ) {
    return { domains: new Set(["process_containment", "terminal_native"]) };
  }

  if (
    path.startsWith("src/main/app-update")
    || path.startsWith("src/main/update")
    || path.startsWith("scripts/prepare-canary-feed")
  ) {
    return {
      domains: new Set([
        "startup_recovery",
        "updater",
        "windows_packaging",
        "linux_appimage",
        "macos_packaging",
      ]),
    };
  }

  if (path.startsWith("src/renderer/")) {
    return { domains: new Set(["renderer_ui"]) };
  }

  if (
    path.startsWith("src/server/database")
    || path.startsWith("src/server/persistence/")
    || path.startsWith("resources/migrations/")
  ) {
    return { domains: new Set(["database_migrations"]) };
  }

  if (path.startsWith("benchmarks/") || path.startsWith("tests/performance/")) {
    return { domains: new Set(["performance"]) };
  }

  if (path.startsWith("build/") || path.startsWith("scripts/run-electron-builder")) {
    return {
      domains: new Set([
        "windows_packaging",
        "linux_appimage",
        "macos_packaging",
      ]),
    };
  }

  // A path which has not been explicitly modeled is never treated as safe.
  return null;
}

export function classifyChangedPaths(inputPaths) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    return {
      allEvidence: true,
      fullCertification: true,
      documentationOnly: false,
      domains: [...CHANGE_DOMAINS],
      reasons: ["empty-or-unavailable-diff"],
    };
  }

  const domains = new Set();
  const reasons = new Set();
  let broad = false;
  let documentationOnly = true;

  for (const input of inputPaths) {
    const path = normalizedRepositoryPath(input);
    if (path === null) {
      broad = true;
      documentationOnly = false;
      reasons.add("unsafe-path");
      continue;
    }
    const result = domainsForKnownPath(path);
    if (result === null) {
      broad = true;
      documentationOnly = false;
      reasons.add(`unclassified:${path}`);
      continue;
    }
    if (!result.documentation) {
      documentationOnly = false;
      domains.add("quality_shared");
    }
    if (result.broad) broad = true;
    for (const domain of result.domains) domains.add(domain);
  }

  if (broad) {
    for (const domain of CHANGE_DOMAINS) domains.add(domain);
    reasons.add("all-evidence-fail-open");
  }

  return {
    allEvidence: broad,
    fullCertification: broad || [...domains].some(
      (domain) => FULL_CERTIFICATION_DOMAINS.has(domain),
    ),
    documentationOnly,
    domains: CHANGE_DOMAINS.filter((domain) => domains.has(domain)),
    reasons: [...reasons].sort(),
  };
}

export function githubOutputsForClassification(classification) {
  const selected = new Set(classification.domains);
  const outputs = {
    all_evidence: classification.allEvidence,
    full_certification: classification.fullCertification,
    documentation_only: classification.documentationOnly,
    domains_json: JSON.stringify(classification.domains),
  };
  for (const domain of CHANGE_DOMAINS) outputs[domain] = selected.has(domain);
  return Object.entries(outputs)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\n") + "\n";
}

function parseCliArguments(args) {
  const parsed = { base: "", head: "HEAD" };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base") parsed.base = args[++index] ?? "";
    else if (argument === "--head") parsed.head = args[++index] ?? "";
    else throw new Error(`Unknown change-classifier argument '${argument}'.`);
  }
  return parsed;
}

async function changedPathsFromCli(args, repositoryRoot) {
  if (!/^[0-9a-f]{40}$/u.test(args.base) || !/^[0-9a-f]{40}$/u.test(args.head)) {
    return [];
  }
  const result = spawnSync("git", ["diff", "--name-only", "-z", `${args.base}...${args.head}`], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error) return [];
  return result.stdout.split("\0").filter(Boolean);
}

async function main() {
  const repositoryRoot = process.cwd();
  const args = parseCliArguments(process.argv.slice(2));
  const paths = await changedPathsFromCli(args, repositoryRoot);
  const classification = classifyChangedPaths(paths);
  const output = githubOutputsForClassification(classification);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, output, "utf8");
  process.stdout.write(`${JSON.stringify({ paths, ...classification }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
