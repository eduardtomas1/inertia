import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  auditAdvisories,
  evaluateDependencyAudit,
  validateExceptions,
} from "../../scripts/check-dependency-audit.mjs";

const PICOMATCH = "GHSA-fc5q-39xc-vjpf";
const OTHER = "GHSA-4m76-xfj5-7975";

function advisory(name: string, id: string, severity = "high") {
  return { source: 1, name, title: `${name} issue`, url: `https://github.com/advisories/${id}`, severity, range: "<=1.0.0" };
}

function report(...vias: ReturnType<typeof advisory>[]) {
  const vulnerabilities: Record<string, unknown> = {};
  for (const via of vias) {
    vulnerabilities[via.name] = { name: via.name, severity: via.severity, via: [via] };
    vulnerabilities[`${via.name}-consumer`] = { name: `${via.name}-consumer`, severity: via.severity, via: [via.name] };
  }
  return { auditReportVersion: 2, vulnerabilities };
}

const clean = report();

function exceptions(...entries: Partial<Record<"advisory" | "package" | "reason" | "expires", string>>[]) {
  return {
    exceptions: (entries.length > 0 ? entries : [{}]).map((entry) => ({
      advisory: PICOMATCH,
      package: "picomatch",
      reason: "Build tooling only; globs come from repository configuration.",
      expires: "2026-12-31",
      ...entry,
    })),
  };
}

describe("dependency audit gate", () => {
  it("fails on an unreviewed high or critical advisory and ignores moderate ones", () => {
    const result = evaluateDependencyAudit({
      fullReport: report(advisory("picomatch", PICOMATCH), advisory("hono", OTHER, "critical"), advisory("minimatch", "GHSA-g3hv-75wg-m249", "moderate")),
      productionReport: clean,
      exceptions: exceptions(),
      today: "2026-11-17",
    });
    expect(result.failures).toEqual([`Unreviewed critical ${OTHER} in hono: hono issue`]);
    expect(result.accepted).toEqual([`picomatch ${PICOMATCH}`]);
    expect(result.unused).toEqual([]);
  });

  it("passes when every blocking advisory has a current reviewed exception", () => {
    expect(evaluateDependencyAudit({
      fullReport: report(advisory("picomatch", PICOMATCH)),
      productionReport: clean,
      exceptions: exceptions(),
      today: "2026-12-31",
    })).toEqual({ failures: [], accepted: [`picomatch ${PICOMATCH}`], unused: [] });
  });

  it("fails once the exception has expired", () => {
    expect(evaluateDependencyAudit({
      fullReport: report(advisory("picomatch", PICOMATCH)),
      productionReport: clean,
      exceptions: exceptions(),
      today: "2027-01-01",
    }).failures).toEqual([`Expired exception (2026-12-31) for high ${PICOMATCH} in picomatch: picomatch issue`]);
  });

  it("never lets an exception cover an advisory in shipped dependencies", () => {
    expect(evaluateDependencyAudit({
      fullReport: report(advisory("picomatch", PICOMATCH)),
      productionReport: report(advisory("picomatch", PICOMATCH)),
      exceptions: exceptions(),
      today: "2026-11-17",
    }).failures).toEqual([`Exception for high ${PICOMATCH} in picomatch: picomatch issue cannot cover a shipped dependency`]);
  });

  it("does not let an exception for one package cover the same advisory elsewhere", () => {
    expect(evaluateDependencyAudit({
      fullReport: report(advisory("micromatch", PICOMATCH)),
      productionReport: clean,
      exceptions: exceptions(),
      today: "2026-11-17",
    })).toEqual({
      failures: [`Unreviewed high ${PICOMATCH} in micromatch: micromatch issue`],
      accepted: [],
      unused: [`${PICOMATCH} in picomatch`],
    });
  });

  it("reports exceptions that no longer match so they can be removed", () => {
    expect(evaluateDependencyAudit({
      fullReport: clean,
      productionReport: clean,
      exceptions: exceptions(),
      today: "2026-11-17",
    })).toEqual({ failures: [], accepted: [], unused: [`${PICOMATCH} in picomatch`] });
  });

  it.each([
    [{ advisory: "CVE-2026-1234" }, "needs a GHSA advisory id"],
    [{ package: " " }, "needs a package name"],
    [{ reason: "dev only" }, "needs a written reason"],
    [{ expires: "2026-02-30" }, "needs an expires date"],
    [{ expires: "2027-03-01" }, "expires more than 92 days"],
  ])("rejects an exception with %j", (entry, message) => {
    expect(() => validateExceptions(exceptions(entry), "2026-11-17")).toThrow(message);
  });

  it("rejects duplicate exceptions and unknown fields", () => {
    expect(() => validateExceptions(exceptions({}, {}), "2026-11-17")).toThrow("duplicates");
    expect(() => validateExceptions({ exceptions: [{ ...exceptions().exceptions[0], scope: "dev" }] }, "2026-11-17"))
      .toThrow("exactly advisory, package, reason and expires");
  });

  it("refuses a report npm could not produce", () => {
    expect(() => auditAdvisories({ error: { code: "ENOAUDIT", summary: "registry unavailable" } }))
      .toThrow("npm audit failed: registry unavailable");
    expect(() => auditAdvisories(null)).toThrow("did not return a vulnerability report");
  });

  it("keeps the committed exception file valid for its own expiry window", () => {
    const committed = JSON.parse(readFileSync("scripts/dependency-audit-exceptions.json", "utf8"));
    expect(() => validateExceptions(committed, "2026-11-17")).not.toThrow();
    const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
    expect(scripts["check:dependency-audit"]).toBe("node scripts/check-dependency-audit.mjs");
  });
});
