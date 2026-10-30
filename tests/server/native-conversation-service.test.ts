// @inertia-test-suite portable
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { PI_RPC_CAPABILITIES } from "../../src/server/provider/pi-rpc-harness";
import type { NativeConversationLaunch, NativeConversationRequest, NativeConversationResult } from "../../src/server/provider/native-conversation-operations";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { providerInstanceId } from "../../src/server/orchestration-v2/provider-instance";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture() {
  const cwd=await realpath(await mkdtemp(join(tmpdir(),"inertia-native-service-")));roots.push(cwd);
  const request:NativeConversationRequest={operationId:"op-1",kind:"fork",targetConversationId:"destination",
    source:{identity:{projectId:"project",conversationId:"source",workspaceId:"workspace",repositoryId:null,providerInstanceId:"instance"},nativeConversationId:"native-source",expectedHeadId:"entry-1"},
    boundary:{kind:"turn",nativeTurnId:"entry-1"}};
  let captured:NativeConversationLaunch|undefined;
  const execute=vi.fn(async(r:NativeConversationRequest,launch:NativeConversationLaunch):Promise<NativeConversationResult>=>{
    await Promise.resolve();captured=launch;
    return {operationId:r.operationId,identity:r.source.identity,status:"completed",effect:"native-fork",backing:{nativeConversationId:"native-target",headId:"entry-1",persistedHeadId:"entry-1"}};
  });
  const privateEnvironment={PI_TEST_API_KEY:"fake-private-key"};
  const release=vi.fn(()=>{privateEnvironment.PI_TEST_API_KEY="";});const dispose=vi.fn();const gate=vi.fn();
  const registry=new AgentHarnessRegistry([{id:"pi-rpc",providerId:"pi",capabilities:PI_RPC_CAPABILITIES,supports:()=>true,
    start:()=>{throw Error("Native controls must not start an agent turn.");},nativeConversation:{capabilities:{fork:"native",rollback:"native-fork"},execute}}]);
  const manager=ProviderManager.createForTests({conversationProviderGate:gate,
    resolveBackendLaunchOptions:()=>({environment:privateEnvironment,releaseAfterStart:release,dispose})},registry);
  vi.spyOn(manager,"detect").mockResolvedValue({provider:{id:"pi",name:"Pi",command:"pi"},available:true,executable:process.execPath,
    version:"1.0.2",installState:"installed",authState:"unknown",canRun:true,cleanupConfirmed:true,protocolVerified:true});
  const selection=providerNativeModelSelection({providerId:"pi"});
  request.source.identity.providerInstanceId=providerInstanceId("pi",manager.resolveModelRoute(selection).continuationIdentity);
  return {cwd,request,manager,execute,gate,release,dispose,captured:()=>captured,selection};
}
describe("ProviderManager native conversation service",()=>{
  it("uses exact model routing and private copied launch authority without starting a turn",async()=>{
    const f=await fixture();
    expect(await f.manager.nativeConversation(f.request,f.selection,{cwd:f.cwd})).toMatchObject({status:"completed",identity:f.request.source.identity});
    expect(f.execute).toHaveBeenCalledOnce();expect(f.gate).toHaveBeenCalledWith("source","pi");
    expect(f.captured()).toMatchObject({cwd:f.cwd,executable:process.execPath,environment:{PI_TEST_API_KEY:"fake-private-key"}});
    expect(f.release).toHaveBeenCalledOnce();expect(f.dispose).toHaveBeenCalledOnce();
  });
  it("rejects active source conversations before native mutation",async()=>{
    const f=await fixture();vi.spyOn(f.manager,"isRunning").mockReturnValue(true);
    await expect(f.manager.nativeConversation(f.request,f.selection,{cwd:f.cwd})).rejects.toThrow("Stop the active");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects stale route revisions and cancelled control requests",async()=>{
    const f=await fixture();
    await expect(f.manager.nativeConversation(f.request,{...f.selection,backendConfigurationRevision:999},{cwd:f.cwd})).rejects.toThrow("changed");
    const controller=new AbortController();controller.abort();
    await expect(f.manager.nativeConversation(f.request,f.selection,{cwd:f.cwd,signal:controller.signal})).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("rejects foreign provider instances and a target that becomes active during launch setup",async()=>{
    const f=await fixture();
    await expect(f.manager.nativeConversation({...f.request,source:{...f.request.source,identity:{...f.request.source.identity,providerInstanceId:"foreign"}}},f.selection,{cwd:f.cwd})).rejects.toThrow("different provider instance");
    let checks=0;
    vi.spyOn(f.manager,"isRunning").mockImplementation(id=>id==="destination"&&++checks>1);
    await expect(f.manager.nativeConversation(f.request,f.selection,{cwd:f.cwd})).rejects.toThrow("became active");
    expect(f.execute).not.toHaveBeenCalled();expect(f.release).toHaveBeenCalledOnce();expect(f.dispose).toHaveBeenCalledOnce();
  });
});
