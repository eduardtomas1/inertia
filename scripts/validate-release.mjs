import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tag = process.env.RELEASE_TAG ?? "";
const releaseRef = process.env.RELEASE_REF ?? "";
const eventSha = (process.env.RELEASE_EVENT_SHA ?? "").toLowerCase();
const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const gitObjectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function fail(message) {
  throw new Error(`Release integrity check failed: ${message}`);
}

function git(...arguments_) {
  return execFileSync("git", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().toLowerCase();
}

if (!stableTagPattern.test(tag)) fail("the event tag is not a strict stable vMAJOR.MINOR.PATCH tag");
if (releaseRef !== `refs/tags/${tag}`) fail("GITHUB_REF does not identify the validated tag");
if (!gitObjectPattern.test(eventSha)) fail("the event SHA is not a Git object ID");

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (typeof packageJson.version !== "string" || tag !== `v${packageJson.version}`) {
  fail(`tag ${tag} does not equal v<package.version>`);
}
if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) {
  fail("package.json and package-lock.json root versions do not match");
}

const headCommit = git("rev-parse", "--verify", "HEAD^{commit}");
const tagObject = git("rev-parse", "--verify", `refs/tags/${tag}`);
const tagCommit = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
if (headCommit !== tagCommit) fail("checked-out HEAD is not the commit peeled from the release tag");
if (eventSha !== tagObject && eventSha !== tagCommit) fail("the event SHA identifies neither the tag object nor its peeled commit");
if (git("status", "--porcelain") !== "") fail("the exact-tag checkout is not clean");

console.log(`Release integrity verified: ${tag} -> ${tagCommit}.`);
