import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const spec = "tests/e2e/visual-evidence.spec.ts";
const largeCaptureBytes = 400 * 1024;

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write([
    "Usage: node scripts/visual-evidence.mjs --out <dir> [--replace] [--surfaces <a,b>]",
    "",
    "Captures the visual evidence set from this worktree's built bundle (run `npm run build:bundle` first).",
    "  --out <dir>       Folder for the PNG files; created when missing.",
    "  --replace         Delete the PNG files already in that folder before capturing.",
    "  --surfaces <a,b>  Capture only these surfaces (names as in the README).",
    "",
  ].join("\n"));
  process.exit(2);
}

function parseArguments(argv) {
  const options = { out: null, replace: false, surfaces: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") options.out = argv[++index] ?? usage("--out needs a folder.");
    else if (argument === "--replace") options.replace = true;
    else if (argument === "--surfaces") options.surfaces = argv[++index] ?? usage("--surfaces needs a list.");
    else if (argument === "--help" || argument === "-h") usage();
    else usage(`Unknown argument: ${argument}`);
  }
  if (!options.out) usage("--out is required.");
  return options;
}

const options = parseArguments(process.argv.slice(2));
const outDirectory = resolve(process.cwd(), options.out);

for (const built of ["out/main/index.js", "out/preload", "out/renderer/index.html"]) {
  if (!existsSync(join(repositoryRoot, built))) {
    process.stderr.write(`The built bundle is missing (${built}). Run \`npm run build:bundle\` in ${repositoryRoot} first.\n`);
    process.exit(1);
  }
}

await mkdir(outDirectory, { recursive: true });
const selected = options.surfaces?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
const captureName = /^(?<surface>.+)-(?:light|dark)-\d+x\d+\.png$/u;
const owned = (name) => name.endsWith(".png")
  && (selected.length === 0 || selected.includes(captureName.exec(name)?.groups?.surface ?? ""));
const existing = (await readdir(outDirectory)).filter(owned);
if (existing.length > 0) {
  if (!options.replace) {
    process.stderr.write(`${outDirectory} already holds ${existing.length} PNG files this run would write. Pass --replace to delete them first.\n`);
    process.exit(1);
  }
  await Promise.all(existing.map((name) => rm(join(outDirectory, name))));
}

const require = createRequire(join(repositoryRoot, "package.json"));
const playwrightCli = join(dirname(require.resolve("@playwright/test/package.json")), "cli.js");
const playwrightArguments = [playwrightCli, "test", spec, "--project", "isolated", "--workers", "1", "--reporter", "line"];

const exitCode = await new Promise((resolveExit, rejectExit) => {
  const child = spawn(process.execPath, playwrightArguments, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      INERTIA_VISUAL_EVIDENCE_DIR: outDirectory,
      INERTIA_VISUAL_EVIDENCE_SURFACES: selected.join(","),
    },
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", rejectExit);
  child.once("exit", (code, signal) => resolveExit(signal ? 1 : code ?? 1));
});

const captures = (await readdir(outDirectory)).filter((name) => name.endsWith(".png")).sort();
let totalBytes = 0;
const large = [];
for (const name of captures) {
  const { size } = await stat(join(outDirectory, name));
  totalBytes += size;
  if (size > largeCaptureBytes) large.push(`${name} (${Math.round(size / 1024)} KB)`);
}
process.stdout.write(`\n${captures.length} captures, ${(totalBytes / 1024 / 1024).toFixed(1)} MB, in ${outDirectory}\n`);
if (large.length > 0) process.stdout.write(`Over 400 KB: ${large.join(", ")}\n`);
process.exit(exitCode);
