import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tag = process.env.RELEASE_TAG ?? "";
const releaseRef = process.env.RELEASE_REF ?? "";
const eventSha = (process.env.RELEASE_EVENT_SHA ?? "").toLowerCase();
const expectedCommit = process.env.RELEASE_EXPECTED_COMMIT ?? "";
const verifyRemote = process.env.RELEASE_VERIFY_REMOTE ?? "";
const releaseTagPattern = /^(canary-)?v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const gitObjectPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const REMOTE_TAG_TIMEOUT_MS = 30_000;
const MAX_REMOTE_TAG_RESPONSE_BYTES = 64 * 1_024;

function fail(message) {
  throw new Error(`Release integrity check failed: ${message}`);
}

function git(...arguments_) {
  return execFileSync("git", arguments_, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim().toLowerCase();
}

function remoteGit(...arguments_) {
  return execFileSync("git", arguments_, {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    killSignal: "SIGKILL",
    maxBuffer: MAX_REMOTE_TAG_RESPONSE_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: REMOTE_TAG_TIMEOUT_MS,
  }).trim().toLowerCase();
}

function resolveRemoteTag(output) {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  const references = new Map();

  for (const line of output.split("\n")) {
    if (line === "") continue;
    const fields = line.split(/\s+/u);
    if (fields.length !== 2 || !gitObjectPattern.test(fields[0])) {
      fail("the remote release tag response is malformed");
    }
    const [object, reference] = fields;
    if (reference !== directRef && reference !== peeledRef) {
      fail("the remote release tag response contains an unexpected ref");
    }
    if (references.has(reference)) fail("the remote release tag response contains a duplicate ref");
    references.set(reference, object);
  }

  const directObject = references.get(directRef);
  const peeledCommit = references.get(peeledRef);
  if (directObject === undefined || references.size !== (peeledCommit === undefined ? 1 : 2)) {
    fail("the remote release tag does not resolve uniquely");
  }
  return { directObject, commit: peeledCommit ?? directObject };
}

if (!releaseTagPattern.test(tag)) fail("the event tag is not a strict stable or Canary version tag");
if (releaseRef !== `refs/tags/${tag}`) fail("RELEASE_REF does not identify the validated tag");
if (!gitObjectPattern.test(eventSha)) fail("the event SHA is not a Git object ID");
if (!commitPattern.test(expectedCommit)) fail("the frozen release commit is not a canonical 40-hex SHA");
if (verifyRemote !== "" && verifyRemote !== "1") fail("RELEASE_VERIFY_REMOTE must be empty or 1");

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const expectedTag = `${tag.startsWith("canary-") ? "canary-v" : "v"}${packageJson.version}`;
if (typeof packageJson.version !== "string" || tag !== expectedTag) {
  fail(`tag ${tag} does not equal the channel prefix plus package.version`);
}
if (packageLock.version !== packageJson.version || packageLock.packages?.[""]?.version !== packageJson.version) {
  fail("package.json and package-lock.json root versions do not match");
}

const headCommit = git("rev-parse", "--verify", "HEAD^{commit}");
const tagObject = git("rev-parse", "--verify", `refs/tags/${tag}`);
const tagCommit = git("rev-parse", "--verify", `refs/tags/${tag}^{commit}`);
if (headCommit !== expectedCommit) fail("checked-out HEAD does not equal the frozen release commit");
if (tagCommit !== expectedCommit) fail("the release tag no longer points to the frozen release commit");
if (eventSha !== tagObject && eventSha !== tagCommit) fail("the event SHA identifies neither the tag object nor its peeled commit");
if (git("status", "--porcelain") !== "") fail("the exact-tag checkout is not clean");

if (verifyRemote === "1") {
  let remoteOutput;
  try {
    remoteOutput = remoteGit("ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
  } catch {
    fail("the remote release tag could not be read");
  }
  const remoteTag = resolveRemoteTag(remoteOutput);
  if (remoteTag.commit !== expectedCommit) {
    fail("the remote release tag no longer points to the frozen release commit");
  }
  if (eventSha !== remoteTag.directObject && eventSha !== remoteTag.commit) {
    fail("the event SHA identifies neither the remote tag object nor its peeled commit");
  }
}

console.log(`Release integrity verified${verifyRemote === "1" ? " locally and remotely" : ""}: ${tag} -> ${tagCommit}.`);
