// @inertia-test-suite portable
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminateProcessTreeAndWait } from "../../src/server/process-lifecycle";
import { probeOpenCodePureIsolation } from "../../src/server/provider/opencode-pure-isolation";
import { portableFixtureRoot, removePortableFixture, writeNodeFlagExecutable, loopbackPortIsOpen } from "../helpers/portable-provider-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(removePortableFixture)); });
function fixture(mode = "") {
  const cwd = realpathSync(portableFixtureRoot("opencode2-proof")); roots.push(cwd);
  const capture = join(cwd, "starts.jsonl");
  const executable = writeNodeFlagExecutable(cwd, "opencode2", `
const http=require("node:http"),fs=require("node:fs"),path=require("node:path");const mode=${JSON.stringify(mode)};
if(process.argv.includes("--pure"))process.exit(2);
const protectedMode=process.env.OPENCODE_CONFIG_PROJECT_DISABLE==="1";
const project=path.join(process.cwd(),".opencode/plugins/inertia-isolation-proof.js");
const globalPlugin=path.join(process.env.OPENCODE_CONFIG_DIR,"plugins/inertia-global-proof.js");
const load=file=>{const text=fs.readFileSync(file,"utf8");const name=JSON.parse(text.match(/writeFileSync\\(("(?:[^"\\\\]|\\\\.)*")/)[1]);fs.writeFileSync(name,"executed");};
const server=http.createServer((req,res)=>{res.writeHead(200,{"content-type":"application/json"});if(req.url.startsWith("/api/model")){
if(!protectedMode&&mode!=="skip-baseline")load(project);
if(!protectedMode||mode==="ignore-policy")load(globalPlugin);
if(protectedMode&&mode==="ignore-project")load(project);
return res.end(JSON.stringify({data:[]}));}
res.end(JSON.stringify({version:mode==="wrong-version"?"2.1.0":"2.0.28",pid:process.pid}));});
server.listen(0,"127.0.0.1",()=>{fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify({cwd:process.cwd(),port:server.address().port,protectedMode,home:process.env.HOME,db:process.env.OPENCODE_DB,secretPresent:!!process.env.TEST_API_KEY})+"\\n");process.stdout.write("server listening on http://127.0.0.1:"+server.address().port+"\\n");});
`);
  return { executable, starts: () => readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { cwd: string; port: number; protectedMode: boolean; home: string; db: string; secretPresent: boolean }) };
}
const prove = (executable: string) => probeOpenCodePureIsolation(executable, "2.0.28", { env: { ...process.env, TEST_API_KEY: "no-real-credentials" }, pathEntries: [] }, terminateProcessTreeAndWait, { pluginObservationMs: 1, requestTimeoutMs: 1000 });

describe("OpenCode 2 discovery isolation", () => {
  it("requires positive project/global sentinels then suppresses both under the production policy", async () => {
    const f = fixture(); expect(await prove(f.executable)).toEqual({ outcome: "verified", cleanupConfirmed: true });
    expect(await prove(f.executable)).toEqual({ outcome: "verified", cleanupConfirmed: true });
    const starts = f.starts(); expect(starts.map((start) => start.protectedMode)).toEqual([false, true]);
    for (const start of starts) {
      expect(start.secretPresent).toBe(false); expect(start.db).toBe(join(start.cwd, "proof.db"));
      expect(start.home).toBe(join(start.cwd, "home")); expect(existsSync(start.cwd)).toBe(false);
      expect(await loopbackPortIsOpen(start.port)).toBe(false);
    }
  });
  it("refuses ignored project isolation, ignored plugin policy, and vacuous control proofs", async () => {
    for (const mode of ["ignore-policy", "ignore-project", "skip-baseline"]) {
      const f = fixture(mode); expect(await prove(f.executable), mode).toEqual({ outcome: "incompatible", cleanupConfirmed: true });
      for (const start of f.starts()) expect(await loopbackPortIsOpen(start.port)).toBe(false);
    }
  });
  it("rejects executable version drift before accepting a semantic proof", async () => {
    const f = fixture("wrong-version"); expect(await prove(f.executable)).toEqual({ outcome: "incompatible", cleanupConfirmed: true });
  });
});
