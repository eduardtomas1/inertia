import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, win32 } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = join(
  root,
  "resources",
  "generated",
  "runtime-process-guardian",
);
const output = join(outputDirectory, "runtime-process-guardian");
const windowsOutput = join(outputDirectory, "windows-runtime-job.dll");
const windowsIntegrityOutput = join(
  root,
  "resources",
  "generated",
  "windows-runtime-job-integrity.json",
);

mkdirSync(outputDirectory, { recursive: true, mode: 0o755 });
rmSync(output, { force: true });
rmSync(windowsOutput, { force: true });
writeFileSync(
  windowsIntegrityOutput,
  `${JSON.stringify({ sha256: null }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o644 },
);

if (process.platform === "win32") {
  const environmentValue = (name) => Object.entries(process.env).find(
    ([key, value]) => key.toLowerCase() === name.toLowerCase()
      && typeof value === "string",
  )?.[1]?.trim();
  const systemRoot = environmentValue("SystemRoot");
  const temporary = environmentValue("TEMP") ?? environmentValue("TMP");
  if (
    !systemRoot
    || !win32.isAbsolute(systemRoot)
    || !/^[a-z]:\\/iu.test(systemRoot)
    || !temporary
    || !win32.isAbsolute(temporary)
    || !/^[a-z]:\\/iu.test(temporary)
  ) {
    throw new Error("The trusted Windows PowerShell build environment is unavailable.");
  }
  const encodePath = (path) => Buffer.from(path, "utf8").toString("base64");
  const sourcePath = join(root, "native", "runtime-process-guardian", "windows.cs");
  const script = `$ErrorActionPreference = 'Stop'
$sourcePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodePath(sourcePath)}'))
$outputPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodePath(windowsOutput)}'))
$sourceInfo = [IO.FileInfo]::new($sourcePath)
if (-not $sourceInfo.Exists -or $sourceInfo.Length -le 0 -or $sourceInfo.Length -gt 1048576) {
  throw 'The Windows runtime Job Object source is missing or invalid.'
}
$source = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
$provider = [Microsoft.CSharp.CSharpCodeProvider]::new()
$parameters = [System.CodeDom.Compiler.CompilerParameters]::new()
$parameters.GenerateExecutable = $false
$parameters.GenerateInMemory = $false
$parameters.OutputAssembly = $outputPath
$parameters.CompilerOptions = '/platform:anycpu /optimize+'
try {
  $results = $provider.CompileAssemblyFromSource($parameters, [string[]]@($source))
  if ($results.Errors.HasErrors) {
    $errors = @($results.Errors | Where-Object { -not $_.IsWarning } | ForEach-Object { $_.ToString() })
    throw "The Windows runtime Job Object assembly failed to compile: $($errors -join '; ')"
  }
} finally {
  $provider.Dispose()
}`;
  const result = spawnSync(
    win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ComSpec: win32.join(systemRoot, "System32", "cmd.exe"),
        PATH: win32.join(systemRoot, "System32"),
        SystemRoot: systemRoot,
        SYSTEMROOT: systemRoot,
        WINDIR: systemRoot,
        TEMP: win32.normalize(temporary),
        TMP: win32.normalize(temporary),
      },
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 60_000,
      windowsHide: true,
    },
  );
  const metadata = lstatSync(windowsOutput, { throwIfNoEntry: false });
  if (
    result.error
    || result.status !== 0
    || !metadata
    || metadata.isSymbolicLink()
    || !metadata.isFile()
    || metadata.size <= 0
    || metadata.size > 1024 * 1024
  ) {
    rmSync(windowsOutput, { force: true });
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    throw new Error(detail || "The Windows runtime Job Object assembly could not be built.");
  }
  const sha256 = createHash("sha256")
    .update(readFileSync(windowsOutput))
    .digest("hex");
  writeFileSync(
    windowsIntegrityOutput,
    `${JSON.stringify({ sha256 }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  process.exit(0);
}

if (process.platform !== "darwin" && process.platform !== "linux") process.exit(0);

const linuxGnuTriplet = process.arch === "x64"
  ? "x86_64-linux-gnu"
  : process.arch === "arm64"
    ? "aarch64-linux-gnu"
    : null;
if (process.platform === "linux" && !linuxGnuTriplet) {
  throw new Error(`The Linux runtime process guardian does not support ${process.arch}.`);
}

const compiler = process.platform === "darwin" ? "/usr/bin/xcrun" : "/usr/bin/musl-gcc";
const compilerArgs = process.platform === "darwin"
  ? ["clang"]
  : [
      "-static-pie",
      "-s",
      "-idirafter",
      "/usr/include",
      "-idirafter",
      `/usr/include/${linuxGnuTriplet}`,
    ];

const result = spawnSync(
  compiler,
  [
    ...compilerArgs,
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    join(root, "native", "runtime-process-guardian", `${process.platform}.c`),
    "-o",
    output,
  ],
  {
    cwd: root,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 64 * 1024,
    shell: false,
    timeout: 30_000,
  },
);
if (result.error || result.status !== 0) {
  if (process.platform === "linux" && result.error?.code === "ENOENT") {
    throw new Error(
      "The Linux runtime process guardian requires musl-tools, linux-libc-dev, and binutils.",
    );
  }
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  throw new Error(detail || `The ${process.platform} runtime process guardian could not be built.`);
}
chmodSync(output, 0o755);
