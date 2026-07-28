import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeSourceArchitecture,
  isTestCaseFile,
  lineCeilingFailures,
} from "./architecture/analyzer.mjs";

const defaultWorkspaceRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const rootArgument = process.argv.indexOf("--root");
const workspaceRoot = rootArgument >= 0
  ? resolve(process.argv[rootArgument + 1] ?? "")
  : defaultWorkspaceRoot;
const productionTypeScriptLineCeiling = 1_000;
const e2eScenarioTypeScriptLineCeiling = 800;
const testCaseTypeScriptLineCeiling = 2_500;
const testSupportTypeScriptLineCeiling = 1_000;
const isE2eScenarioFile = (file) => {
  const portablePath = file.replaceAll("\\", "/");
  return portablePath.includes("/tests/e2e/")
    && /\.spec\.[cm]?[jt]sx?$/u.test(portablePath);
};

const graph = analyzeSourceArchitecture({ workspaceRoot });
const failures = [
  ...graph.failures,
  ...lineCeilingFailures({
    workspaceRoot,
    directory: "src",
    ceiling: productionTypeScriptLineCeiling,
    label: "production TypeScript ceiling",
  }),
  ...lineCeilingFailures({
    workspaceRoot,
    directory: "tests",
    ceiling: e2eScenarioTypeScriptLineCeiling,
    include: isE2eScenarioFile,
    label: "E2E scenario TypeScript ceiling",
  }),
  ...lineCeilingFailures({
    workspaceRoot,
    directory: "tests",
    ceiling: testCaseTypeScriptLineCeiling,
    include: (file) => isTestCaseFile(file) && !isE2eScenarioFile(file),
    label: "test case TypeScript ceiling",
  }),
  ...lineCeilingFailures({
    workspaceRoot,
    directory: "tests",
    ceiling: testSupportTypeScriptLineCeiling,
    include: (file) => !isTestCaseFile(file),
    label: "test support TypeScript ceiling",
  }),
];

if (failures.length > 0) {
  console.error("Architecture checks failed:\n");
  for (const failure of [...new Set(failures)].sort()) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Architecture checks passed (${graph.files.length} source files, `
    + `${graph.edges.length} internal edges, `
    + `${graph.facades.length} derived compatibility facades).`,
  );
}
