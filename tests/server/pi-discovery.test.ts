// @inertia-test-suite portable
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probePiProtocol } from "../../src/server/provider/pi-discovery";
import { readPiModels } from "../../src/server/provider/pi-models";
import { readPiSkills } from "../../src/server/provider/pi-skills";
import { portableFixtureRoot, removePortableFixture, writeNodeFlagExecutable } from "../helpers/portable-provider-fixture";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(removePortableFixture));});
function fixture() {
  const root=realpathSync(portableFixtureRoot("pi-discovery"));roots.push(root);
  const home=join(root,"native-home");mkdirSync(home);
  const skill=join(root,".pi","skills","example","SKILL.md");mkdirSync(join(root,".pi","skills","example"),{recursive:true});writeFileSync(skill,"# Example\nRead-only instructions.");
  const outside=join(root,"outside","SKILL.md");mkdirSync(join(root,"outside"));writeFileSync(outside,"unrelated");
  const capture=join(root,"capture.json");
  const executable=writeNodeFlagExecutable(root,"pi",`
const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),home:process.env.PI_CODING_AGENT_DIR,token:process.env.TEST_API_KEY}));
const model={provider:"test",id:"model",name:"Model",input:["text","image"],reasoning:true,thinkingLevelMap:{max:"max",xhigh:null}};
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);let data;
if(r.type==="get_state")data={model,isStreaming:false,isCompacting:false};
if(r.type==="get_available_thinking_levels")data={levels:["off","high","max"]};
if(r.type==="get_available_models")data={models:[model]};
if(r.type==="get_commands")data={commands:[{name:"skill:example",description:"Useful skill",source:"skill",sourceInfo:{path:${JSON.stringify(skill)}}},{name:"skill:escape",description:"Unrelated",source:"skill",sourceInfo:{path:${JSON.stringify(outside)}}}]};
process.stdout.write(JSON.stringify({type:"response",id:r.id,command:r.type,success:true,data})+"\\n");});
`);
  return {root,home,skill,executable,capture,environment:{...process.env,PI_CODING_AGENT_DIR:home,TEST_API_KEY:"fake-native-api-key",INERTIA_PI_ARGS:JSON.stringify(["--extension","/unloaded/extension.mjs"])}};
}
describe("Pi discovery",()=>{
  it("proves RPC support with an isolated empty configuration and no provider credentials",async()=>{
    const f=fixture();expect(await probePiProtocol({executable:f.executable,environment:f.environment,cwd:f.root})).toEqual({ready:true,cleanupConfirmed:true});
    const capture=JSON.parse(readFileSync(f.capture,"utf8")) as {home:string;token?:string;args:string[]};
    expect(capture.home).not.toBe(f.home);expect(capture.token).toBeUndefined();
    expect(capture.args).toEqual(expect.arrayContaining(["--no-session","--no-extensions","--no-tools","--offline"]));
    expect(capture.args).not.toContain("/unloaded/extension.mjs");
  });
  it("reads the native model catalog without executing configured extensions",async()=>{
    const f=fixture();const models=await readPiModels(f.executable,f.environment,f.root);
    expect(models[0]).toMatchObject({id:"test/model",isDefault:true,inputModalities:["text","image"]});
    expect(models[0]!.reasoningOptions.map(option=>option.value)).toContain("max");
    expect(models[0]!.reasoningOptions.map(option=>option.value)).not.toContain("xhigh");
    expect(readFileSync(f.capture,"utf8")).not.toContain("/unloaded/extension.mjs");
  });
  it("returns only bounded canonical skills within the selected native roots",async()=>{
    const f=fixture();expect(await readPiSkills(f.executable,f.environment,f.root)).toEqual([
      {name:"example",description:"Useful skill",path:f.skill,scope:"repo",argumentHint:""},
    ]);
  });
});
