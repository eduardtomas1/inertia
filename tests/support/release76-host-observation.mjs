// Diagnostic branch only. Retain aggregate process/resource counts, never
// command lines, executable paths, environment values, identities or output.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import os from "node:os";

const phase = process.argv[2];
if (!/^[a-z-]{1,60}$/u.test(phase ?? "")) throw new Error("Invalid observation phase.");
const groups = {};
let processObservation = "unavailable";
let processCount = 0;
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const add = (name, memoryBytes, cpu, handles) => {
  processCount += 1;
  const short = basename(name).toLowerCase().replace(/\.exe$/u, "");
  const role = short.includes("electron") ? "electron"
    : short === "node" ? "node"
      : /^git(?:-|$)/u.test(short) ? "git"
        : /(?:^|[-_.])(?:runtime-process-guardian|windows-runtime-job)(?:[-_.]|$)|^inertia.*(?:runtime|guardian|job)/u.test(short) ? "runtime-guardian"
          : "other";
  const group = groups[role] ??= { count: 0, memoryBytes: 0, cpu: 0, handles: 0 };
  group.count += 1;
  group.memoryBytes += finite(memoryBytes);
  group.cpu += finite(cpu);
  group.handles += finite(handles);
};
try {
  const options = { encoding: "utf8", timeout: 5_000, maxBuffer: 2 * 1024 * 1024,
    windowsHide: true, stdio: ["ignore", "pipe", "ignore"] };
  if (process.platform === "win32") {
    const rows = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-Process | Select-Object ProcessName,CPU,WorkingSet64,Handles | ConvertTo-Json -Compress",
    ], options).replace(/^\uFEFF/u, ""));
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      add(String(row.ProcessName ?? ""), row.WorkingSet64, row.CPU, row.Handles);
    }
    processObservation = "completed-cpu-seconds";
  } else if (process.platform === "darwin") {
    const rows = execFileSync("/bin/ps", ["-axo", "%cpu=,rss=,comm="], options);
    for (const line of rows.split("\n")) {
      const row = /^\s*([\d.]+)\s+(\d+)\s+(.+)$/u.exec(line);
      if (row) add(row[3], Number(row[2]) * 1024, row[1], 0);
    }
    processObservation = "completed-cpu-percent";
  }
} catch { /* diagnostics cannot replace the actual test result */ }
const cpuTimes = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
for (const cpu of os.cpus()) {
  for (const key of Object.keys(cpuTimes)) cpuTimes[key] += cpu.times[key];
}
const report = { phase, at: Date.now(), uptimeSeconds: os.uptime(),
  freeMemoryBytes: os.freemem(), totalMemoryBytes: os.totalmem(), load: os.loadavg(),
  availableParallelism: os.availableParallelism(), cpuTimes, processObservation, processCount, groups };
const directory = resolve("test-results", "host");
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, `${phase}.json`), `${JSON.stringify(report)}\n`);
console.log(JSON.stringify(report));
