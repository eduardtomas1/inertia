import { lstat, readFile, readdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const DEFAULT_LIMITS = Object.freeze({
  maxArtifactBytes: 24 * 1024 * 1024,
  maxFiles: 128,
  maxPackageJsonBytes: 64 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
});
const SOURCE_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".ts", ".tsx"]);
const ARTIFACT_ROOTS = [
  ["bundle"],
  ["dist", "src", "acp"],
  ["dist", "acp"],
  ["src", "acp"],
];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function withinRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

function positiveInteger(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Gemini CLI artifact limit ${name} must be a positive integer.`);
  }
  return value;
}

function resolveLimits(overrides = {}) {
  return {
    maxArtifactBytes: positiveInteger(
      overrides.maxArtifactBytes,
      DEFAULT_LIMITS.maxArtifactBytes,
      "maxArtifactBytes",
    ),
    maxFiles: positiveInteger(overrides.maxFiles, DEFAULT_LIMITS.maxFiles, "maxFiles"),
    maxPackageJsonBytes: positiveInteger(
      overrides.maxPackageJsonBytes,
      DEFAULT_LIMITS.maxPackageJsonBytes,
      "maxPackageJsonBytes",
    ),
    maxTotalBytes: positiveInteger(
      overrides.maxTotalBytes,
      DEFAULT_LIMITS.maxTotalBytes,
      "maxTotalBytes",
    ),
  };
}

async function regularFileSize(path, label) {
  const metadata = await lstat(path);
  if (!metadata.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  return metadata.size;
}

function packageBin(packageJson) {
  if (typeof packageJson.bin === "string") return packageJson.bin;
  if (packageJson.bin && typeof packageJson.bin === "object" && !Array.isArray(packageJson.bin)) {
    if (typeof packageJson.bin.gemini === "string") return packageJson.bin.gemini;
    const values = Object.values(packageJson.bin).filter((value) => typeof value === "string");
    if (values.length === 1) return values[0];
  }
  throw new Error("@google/gemini-cli does not expose one unambiguous Gemini executable.");
}

function executablePath(packageRoot, bin) {
  if (isAbsolute(bin)) {
    throw new Error("@google/gemini-cli executable escapes its package root.");
  }
  const candidate = resolve(packageRoot, bin);
  if (!withinRoot(packageRoot, candidate)) {
    throw new Error("@google/gemini-cli executable escapes its package root.");
  }
  return candidate;
}

function isSourceArtifact(path) {
  if (path.endsWith(".d.ts")) return false;
  return SOURCE_EXTENSIONS.has(extname(path));
}

async function collectTree(root, directory, output, limits, depth = 0) {
  if (depth > 4) {
    throw new Error("@google/gemini-cli artifact layout exceeds the inspection depth limit.");
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const candidate = resolve(directory, entry.name);
    if (!withinRoot(root, candidate)) {
      throw new Error("@google/gemini-cli artifact layout escapes its package root.");
    }
    if (entry.isSymbolicLink()) {
      throw new Error("@google/gemini-cli shipped source contains an unsupported symbolic link.");
    }
    if (entry.isDirectory()) {
      await collectTree(root, candidate, output, limits, depth + 1);
      continue;
    }
    if (!entry.isFile() || !isSourceArtifact(candidate)) continue;
    output.add(candidate);
    if (output.size > limits.maxFiles) {
      throw new Error(
        `@google/gemini-cli exposes more than ${limits.maxFiles} inspectable source artifacts.`,
      );
    }
  }
}

function nearby(text, anchor, distance, predicate) {
  let offset = 0;
  while (offset < text.length) {
    const found = text.indexOf(anchor, offset);
    if (found < 0) return false;
    if (predicate(text.slice(found, found + distance))) return true;
    offset = found + anchor.length;
  }
  return false;
}

function sessionNewState(text) {
  return nearby(text, "buildAvailableModels", 8_000, (window) => (
    /\bsessionId\b/u.test(window)
    && /\bmodes\s*:/u.test(window)
    && /\bavailableModes\b/u.test(window)
    && /\bcurrentModeId\b/u.test(window)
    && /\bmodels\s*:/u.test(window)
    && /\bavailableModels\b/u.test(window)
    && /\bcurrentModelId\b/u.test(window)
  ));
}

function modeBuilder(text) {
  return nearby(text, "buildAvailableModes", 4_000, (window) => (
    /\bid\s*:\s*(?:ApprovalMode\.)?DEFAULT\b|\bid\s*:\s*["']default["']/u.test(window)
    && /\bname\s*:\s*["']Default["']/u.test(window)
    && /\bid\s*:\s*(?:ApprovalMode\.)?PLAN\b|\bid\s*:\s*["']plan["']/u.test(window)
    && /\bname\s*:\s*["']Plan["']/u.test(window)
  ));
}

function modeId(text, symbolicName, value) {
  const quotedSymbol = `["']${symbolicName}["']`;
  return new RegExp(
    `(?:\\[\\s*${quotedSymbol}\\s*\\]|\\b${symbolicName})\\s*=\\s*["']${value}["']`,
    "u",
  ).test(text);
}

function modelSetterImplementation(text) {
  return nearby(text, "unstable_setSessionModel", 2_000, (window) => (
    /\bsessionManager\b/u.test(window)
    && /\bgetSession\s*\(/u.test(window)
    && /\bsetModel\s*\(/u.test(window)
  ));
}

function quotaMetadata(text) {
  return nearby(text, "_meta", 1_500, (window) => (
    /\bquota\b/u.test(window)
    && /\btoken_count\b/u.test(window)
    && /\binput_tokens\b/u.test(window)
    && /\boutput_tokens\b/u.test(window)
  ));
}

function updateVariant(text, variant) {
  return new RegExp(
    `\\bsessionUpdate\\s*:\\s*(?:[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\.literal\\(\\s*)?["']${variant}["']`,
    "u",
  ).test(text);
}

function stringLiteral(text, value) {
  return text.includes(`"${value}"`) || text.includes(`'${value}'`);
}

function oauthScopeSet(text) {
  return [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ].every((scope) => stringLiteral(text, scope));
}

function geminiHomeOverride(text) {
  return nearby(text, "GEMINI_CLI_HOME", 2_000, (window) => (
    /\bprocess\w*\.env\b/u.test(window)
    && /\bos\w*\.homedir\s*\(/u.test(window)
  ));
}

function dotenvParserGrammar(text) {
  return nearby(text, "LINE =", 2_500, (window) => (
    window.includes(String.raw`(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)`)
    && /\bLINE\.exec\s*\(/u.test(window)
    && /\bvalue\s*=\s*value\.trim\s*\(\)/u.test(window)
    && /\bmaybeQuote\b/u.test(window)
    && window.includes(String.raw`value.replace(/\\n/g`)
    && window.includes(String.raw`value.replace(/\\r/g`)
  ));
}

function dotenvDiscovery(text) {
  return nearby(text, "function findEnvFile", 5_000, (window) => (
    /\bcurrentDir\b/u.test(window)
    && /\bcurrentDir\s*,\s*GEMINI_DIR\s*,\s*["']\.env["']/u.test(window)
    && /\bcurrentDir\s*,\s*["']\.env["']/u.test(window)
    && /\bhomedir\s*\(\)/u.test(window)
    && /\bdirname\s*\(/u.test(window)
  ));
}

function dotenvEnvironmentPolicy(text) {
  return nearby(text, "function loadEnvironment", 5_000, (window) => (
    /\bdotenv\.parse\s*\(/u.test(window)
    && /\bAUTH_ENV_VAR_WHITELIST\.includes\s*\(\s*key\s*\)/u.test(window)
    && /\bsanitizeEnvVar\s*\(\s*value\s*\)/u.test(window)
    && /\bObject\.hasOwn\s*\(\s*process\w*\.env\s*,\s*key\s*\)/u.test(window)
  ));
}

function contractState() {
  return [
    {
      label: "session/new modes and models response",
      matched: false,
      match: sessionNewState,
    },
    {
      label: "Default and Plan mode descriptors",
      matched: false,
      match: modeBuilder,
    },
    {
      label: 'Default mode id "default"',
      matched: false,
      match: (text) => modeId(text, "DEFAULT", "default"),
    },
    {
      label: 'Plan mode id "plan"',
      matched: false,
      match: (text) => modeId(text, "PLAN", "plan"),
    },
    {
      label: "session/set_model protocol route",
      matched: false,
      match: (text) => /["']session\/set_model["']/u.test(text),
    },
    {
      label: "Gemini session model setter",
      matched: false,
      match: modelSetterImplementation,
    },
    {
      label: "prompt quota token metadata",
      matched: false,
      match: quotaMetadata,
    },
    {
      label: 'legacy "plan" session update variant',
      matched: false,
      match: (text) => updateVariant(text, "plan"),
    },
    {
      label: '"usage_update" session update variant',
      matched: false,
      match: (text) => updateVariant(text, "usage_update"),
    },
    {
      label: "Google OAuth authorization endpoint",
      matched: false,
      match: (text) => stringLiteral(
        text,
        "https://accounts.google.com/o/oauth2/v2/auth",
      ),
    },
    {
      label: "Gemini OAuth client ID",
      matched: false,
      match: (text) => stringLiteral(
        text,
        "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com",
      ),
    },
    {
      label: "Gemini manual OAuth redirect",
      matched: false,
      match: (text) => stringLiteral(text, "https://codeassist.google.com/authcode"),
    },
    {
      label: "Gemini OAuth scope set",
      matched: false,
      match: oauthScopeSet,
    },
    {
      label: "Gemini CLI home override",
      matched: false,
      match: geminiHomeOverride,
    },
    {
      label: "dotenv 16 parser grammar",
      matched: false,
      match: dotenvParserGrammar,
    },
    {
      label: "Gemini dotenv file discovery",
      matched: false,
      match: dotenvDiscovery,
    },
    {
      label: "Gemini dotenv environment policy",
      matched: false,
      match: dotenvEnvironmentPolicy,
    },
  ];
}

function artifactPriority(path, executable) {
  if (path === executable) return 0;
  if (/(?:^|[/\\])gemini(?:[-.][^/\\]+)?\.(?:[cm]?js|tsx?)$/iu.test(path)) return 1;
  if (/acp/iu.test(path)) return 2;
  return 3;
}

/**
 * Statically attest the unstable Gemini ACP surfaces Inertia consumes. This
 * deliberately reads only files shipped in the installed npm package: the
 * canary must not require credentials or execute an authenticated session.
 */
export async function inspectGeminiCliAcpSurface(packageDirectory, overrides = {}) {
  const limits = resolveLimits(overrides);
  const packageRoot = resolve(packageDirectory);
  const manifestPath = join(packageRoot, "package.json");
  let manifestSize;
  try {
    manifestSize = await regularFileSize(manifestPath, "@google/gemini-cli package.json");
  } catch (error) {
    throw new Error(`Cannot inspect @google/gemini-cli package.json: ${errorMessage(error)}`);
  }
  if (manifestSize > limits.maxPackageJsonBytes) {
    throw new Error("@google/gemini-cli package.json exceeds the inspection size limit.");
  }
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse @google/gemini-cli package.json: ${errorMessage(error)}`);
  }
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)
    || packageJson.name !== "@google/gemini-cli") {
    throw new Error("Gemini artifact inspection received a different npm package.");
  }
  const executable = executablePath(packageRoot, packageBin(packageJson));
  const artifacts = new Set();
  if (!isSourceArtifact(executable)) {
    throw new Error("@google/gemini-cli executable is not an inspectable source artifact.");
  }
  artifacts.add(executable);
  for (const segments of ARTIFACT_ROOTS) {
    await collectTree(packageRoot, join(packageRoot, ...segments), artifacts, limits);
  }
  if (artifacts.size > limits.maxFiles) {
    throw new Error(
      `@google/gemini-cli exposes more than ${limits.maxFiles} inspectable source artifacts.`,
    );
  }

  const contracts = contractState();
  const orderedArtifacts = [...artifacts].sort((left, right) => (
    artifactPriority(left, executable) - artifactPriority(right, executable)
    || left.localeCompare(right)
  ));
  let filesInspected = 0;
  let totalBytes = 0;
  for (const artifact of orderedArtifacts) {
    let artifactSize;
    try {
      artifactSize = await regularFileSize(artifact, "Gemini shipped source artifact");
    } catch (error) {
      throw new Error(`Cannot inspect a Gemini shipped source artifact: ${errorMessage(error)}`);
    }
    if (artifactSize > limits.maxArtifactBytes) {
      throw new Error(
        `A Gemini shipped source artifact exceeds the ${limits.maxArtifactBytes}-byte inspection limit.`,
      );
    }
    totalBytes += artifactSize;
    if (totalBytes > limits.maxTotalBytes) {
      throw new Error(
        `Gemini shipped source exceeds the ${limits.maxTotalBytes}-byte aggregate inspection limit.`,
      );
    }
    const source = await readFile(artifact, "utf8");
    filesInspected += 1;
    for (const contract of contracts) {
      if (!contract.matched && contract.match(source)) contract.matched = true;
    }
    if (contracts.every((contract) => contract.matched)) break;
  }

  const missing = contracts.filter((contract) => !contract.matched).map((contract) => contract.label);
  if (missing.length > 0) {
    throw new Error(
      `Gemini CLI shipped ACP surface drifted. Missing: ${missing.join("; ")}. `
      + `Inspected ${filesInspected} bounded source artifact(s) (${totalBytes} bytes).`,
    );
  }
  return { filesInspected, totalBytes };
}
