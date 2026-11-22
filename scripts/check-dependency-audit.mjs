import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const MAX_EXCEPTION_DAYS = 92;
const DAY_MS = 86_400_000;
const ADVISORY_ID = /^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function advisoryId(url) {
  const id = typeof url === "string" ? url.split("/").pop() : "";
  return ADVISORY_ID.test(id) ? id : null;
}

function utcDay(value) {
  if (!ISO_DATE.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value ? null : time;
}

export function auditAdvisories(report) {
  if (!record(report) || !record(report.vulnerabilities)) {
    throw new Error(record(report) && record(report.error)
      ? `npm audit failed: ${report.error.summary ?? report.error.code ?? "unknown error"}`
      : "npm audit did not return a vulnerability report.");
  }
  const advisories = new Map();
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    for (const via of Array.isArray(vulnerability?.via) ? vulnerability.via : []) {
      if (!record(via)) continue;
      const id = advisoryId(via.url) ?? String(via.source ?? via.url ?? "unknown");
      const key = `${via.name}\u0000${id}`;
      if (!advisories.has(key)) {
        advisories.set(key, { id, package: String(via.name), severity: String(via.severity), title: String(via.title ?? "") });
      }
    }
  }
  return [...advisories.values()];
}

export function validateExceptions(document, today) {
  const todayTime = utcDay(today);
  if (todayTime === null) throw new Error(`Invalid audit date ${today}.`);
  if (!record(document) || !Array.isArray(document.exceptions)) {
    throw new Error("The dependency audit exception file must hold an exceptions array.");
  }
  const seen = new Set();
  return document.exceptions.map((exception, index) => {
    const label = `Exception ${index + 1}`;
    if (!record(exception)) throw new Error(`${label} must be an object.`);
    const { advisory, package: name, reason, expires } = exception;
    if (Object.keys(exception).sort().join() !== "advisory,expires,package,reason") {
      throw new Error(`${label} must have exactly advisory, package, reason and expires.`);
    }
    if (typeof advisory !== "string" || !ADVISORY_ID.test(advisory)) throw new Error(`${label} needs a GHSA advisory id.`);
    if (typeof name !== "string" || name.trim() === "") throw new Error(`${label} needs a package name.`);
    if (typeof reason !== "string" || reason.trim().length < 20) throw new Error(`${label} needs a written reason.`);
    const expiry = typeof expires === "string" ? utcDay(expires) : null;
    if (expiry === null) throw new Error(`${label} needs an expires date as YYYY-MM-DD.`);
    if (expiry - todayTime > MAX_EXCEPTION_DAYS * DAY_MS) {
      throw new Error(`${label} for ${advisory} expires more than ${MAX_EXCEPTION_DAYS} days from ${today}.`);
    }
    const key = `${name}\u0000${advisory}`;
    if (seen.has(key)) throw new Error(`${label} duplicates ${advisory} for ${name}.`);
    seen.add(key);
    return { advisory, package: name, reason, expires, expired: expiry < todayTime };
  });
}

export function evaluateDependencyAudit({ fullReport, productionReport, exceptions, today }) {
  const accepted = validateExceptions(exceptions, today);
  const failures = [];
  const used = new Set();
  const production = new Set(auditAdvisories(productionReport).map((entry) => `${entry.package}\u0000${entry.id}`));
  for (const advisory of auditAdvisories(fullReport)) {
    if (!BLOCKING_SEVERITIES.has(advisory.severity)) continue;
    const key = `${advisory.package}\u0000${advisory.id}`;
    const exception = accepted.find((entry) => `${entry.package}\u0000${entry.advisory}` === key);
    const description = `${advisory.severity} ${advisory.id} in ${advisory.package}${advisory.title ? `: ${advisory.title}` : ""}`;
    if (!exception) {
      failures.push(`Unreviewed ${description}`);
    } else if (exception.expired) {
      failures.push(`Expired exception (${exception.expires}) for ${description}`);
    } else if (production.has(key)) {
      failures.push(`Exception for ${description} cannot cover a shipped dependency`);
    } else {
      used.add(key);
    }
  }
  const unused = accepted
    .filter((entry) => !used.has(`${entry.package}\u0000${entry.advisory}`))
    .map((entry) => `${entry.advisory} in ${entry.package}`);
  return { failures, accepted: [...used].map((key) => key.replace("\u0000", " ")), unused };
}

function runAudit(npmCli, args) {
  const result = spawnSync(process.execPath, [npmCli, "audit", "--json", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
    shell: false,
  });
  if (result.error) throw result.error;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm audit ${args.join(" ")} did not print JSON (exit ${result.status}).`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("Run this check through npm run check:dependency-audit.");
  const { failures, accepted, unused } = evaluateDependencyAudit({
    fullReport: runAudit(npmCli, []),
    productionReport: runAudit(npmCli, ["--omit=dev"]),
    exceptions: JSON.parse(readFileSync(new URL("./dependency-audit-exceptions.json", import.meta.url), "utf8")),
    today: new Date().toISOString().slice(0, 10),
  });
  for (const entry of accepted) console.log(`Accepted reviewed exception: ${entry}`);
  for (const entry of unused) console.warn(`Unused dependency audit exception, remove it: ${entry}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure);
    process.exitCode = 1;
  } else {
    console.log("No unreviewed high or critical advisories in the full dependency tree.");
  }
}
