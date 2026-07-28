import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(
  process.env.INERTIA_NOTICES_OUTPUT
    ?? join(repositoryRoot, "resources", "generated", "THIRD_PARTY_NOTICES.txt"),
);
const fixtureTreePath = process.env.INERTIA_NOTICES_TREE_PATH;
const packageManager = process.platform === "win32" ? "npm.cmd" : "npm";

function fail(message) {
  throw new Error(`Third-party notice generation failed: ${message}`);
}

function productionTree() {
  if (fixtureTreePath) {
    return JSON.parse(readFileSync(resolve(fixtureTreePath), "utf8"));
  }
  const output = execFileSync(
    packageManager,
    ["ls", "--omit=dev", "--all", "--json", "--long"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(output);
}

function packageEntries(tree) {
  const entriesByPath = new Map();
  const visit = (dependencies) => {
    for (const [dependencyName, dependency] of Object.entries(dependencies ?? {})) {
      if (dependency.path && dependency.version) {
        entriesByPath.set(resolve(dependency.path), {
          dependencyName,
          version: dependency.version,
          path: resolve(dependency.path),
        });
      }
      visit(dependency.dependencies);
    }
  };
  visit(tree.dependencies);
  return [...entriesByPath.values()];
}

function packageManifest(entry) {
  const manifestPath = join(entry.path, "package.json");
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`${entry.dependencyName}@${entry.version} has no readable package.json (${error.message})`);
  }
}

function declaredLicense(manifest) {
  if (typeof manifest.license === "string" && manifest.license.trim()) {
    return manifest.license.trim();
  }
  if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
    return manifest.licenses
      .map((license) => typeof license === "string" ? license : license?.type)
      .filter(Boolean)
      .join(" OR ");
  }
  return null;
}

function noticeFiles(entry, manifest, license) {
  let packageRoot;
  try {
    packageRoot = realpathSync(entry.path);
  } catch (error) {
    fail(`${entry.dependencyName}@${entry.version} has no readable package directory (${error.message})`);
  }
  const names = new Set(
    readdirSync(entry.path)
      .filter((name) => /^(licen[cs]e|copying|notice)(\.|$)/iu.test(name)),
  );
  const referenced = license?.match(/^SEE LICEN[CS]E IN\s+(.+)$/iu)?.[1]?.trim();
  if (referenced) names.add(referenced);

  const documents = [...names]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((name) => {
      const path = resolve(entry.path, name);
      const relativePath = relative(entry.path, path);
      if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
        fail(`${entry.dependencyName}@${entry.version} references a license outside its package`);
      }
      let actualPath;
      try {
        const metadata = lstatSync(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          fail(`${entry.dependencyName}@${entry.version} references non-regular ${name}`);
        }
        actualPath = realpathSync(path);
      } catch (error) {
        if (
          error instanceof Error
          && error.message.startsWith("Third-party notice generation failed:")
        ) {
          throw error;
        }
        fail(`${entry.dependencyName}@${entry.version} references unreadable ${name} (${error.message})`);
      }
      const actualRelativePath = relative(packageRoot, actualPath);
      if (
        actualRelativePath.startsWith("..")
        || isAbsolute(actualRelativePath)
      ) {
        fail(`${entry.dependencyName}@${entry.version} references a license outside its package`);
      }
      let text;
      try {
        text = readFileSync(actualPath, "utf8").replace(/\r\n?/gu, "\n").trim();
      } catch (error) {
        fail(`${entry.dependencyName}@${entry.version} references unreadable ${name} (${error.message})`);
      }
      if (!text) fail(`${entry.dependencyName}@${entry.version} contains an empty ${name}`);
      return {
        name: basename(name),
        hash: createHash("sha256").update(text).digest("hex"),
        text,
      };
    });

  if (!license && documents.length === 0) {
    fail(`${entry.dependencyName}@${entry.version} declares no license and ships no notice text`);
  }
  if (referenced && !documents.some((document) => document.name === basename(referenced))) {
    fail(`${entry.dependencyName}@${entry.version} references missing ${referenced}`);
  }
  return documents;
}

function collectPackages(tree) {
  const identities = new Map();
  for (const entry of packageEntries(tree)) {
    const manifest = packageManifest(entry);
    const name = typeof manifest.name === "string" ? manifest.name : entry.dependencyName;
    const version = typeof manifest.version === "string" ? manifest.version : entry.version;
    const identity = `${name}@${version}`;
    const license = declaredLicense(manifest);
    const documents = noticeFiles(entry, manifest, license);
    const signature = JSON.stringify({
      license,
      documents: documents.map(({ name: documentName, hash }) => ({ name: documentName, hash })),
    });
    const existing = identities.get(identity);
    if (existing && existing.signature !== signature) {
      fail(`${identity} resolves to inconsistent license material`);
    }
    if (!existing) {
      identities.set(identity, { identity, license, documents, signature });
    }
  }
  return [...identities.values()].sort((left, right) => left.identity.localeCompare(right.identity, "en"));
}

function render(packages) {
  const documentsByHash = new Map();
  for (const pkg of packages) {
    for (const document of pkg.documents) {
      const record = documentsByHash.get(document.hash) ?? {
        hash: document.hash,
        text: document.text,
        users: [],
      };
      record.users.push(`${pkg.identity} (${document.name})`);
      documentsByHash.set(document.hash, record);
    }
  }
  const documentIds = new Map(
    [...documentsByHash.keys()]
      .sort()
      .map((hash, index) => [hash, `L${index + 1}`]),
  );

  const lines = [
    "INERTIA THIRD-PARTY NOTICES",
    "",
    "This file lists production dependencies present in this packaged build.",
    "License text is reproduced from each installed package when supplied by that package.",
    "",
    "PACKAGES",
    "",
  ];
  for (const pkg of packages) {
    const references = pkg.documents.map((document) => documentIds.get(document.hash)).join(", ");
    lines.push(
      `- ${pkg.identity}`,
      `  Declared license: ${pkg.license ?? "Not declared"}`,
      `  Included text: ${references || "Package supplied no license text"}`,
    );
  }

  lines.push("", "LICENSE AND NOTICE TEXTS", "");
  for (const [hash, record] of [...documentsByHash.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(
      `${documentIds.get(hash)} · SHA-256 ${hash}`,
      `Used by: ${record.users.sort((left, right) => left.localeCompare(right, "en")).join(", ")}`,
      "",
      record.text,
      "",
      "--------------------------------------------------------------------------------",
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

try {
  const output = render(collectPackages(productionTree()));
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output, "utf8");
  console.log(`Generated ${outputPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
