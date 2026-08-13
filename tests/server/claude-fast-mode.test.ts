import { afterEach, describe, expect, it } from "vitest";

import type {
  Options as ClaudeOptions,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  continuationIdentityForSelection,
  withModelSelectionFastMode,
} from "../../src/shared/model-routing";
import { AgentHarnessRegistry, ProviderManager } from "../../src/server/providers";
import { createClaudeAgentSdkHarness } from "../../src/server/provider/claude-agent-sdk-harness";
import {
  claudeSuccessResult,
  claudeSystem,
  fixtureClaudeQuery,
} from "../helpers/claude-agent-sdk-protocol";
import {
  portableFixtureRoot,
  removePortableFixture,
} from "../helpers/portable-provider-fixture";
import { nativeProviderRunInput } from "./model-route-fixture";

describe.sequential("Claude provider-native Fast mode", () => {
  const roots: string[] = [];
  const managers: ProviderManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.disposeAll()));
    await Promise.all(roots.splice(0).map(removePortableFixture));
  });

  function managerFor(
    fastModeState: "on" | "off",
    capture: (options: ClaudeOptions | undefined) => void = () => undefined,
    disabledReason: string | null = null,
    sessionId?: string,
  ): ProviderManager {
    const harness = createClaudeAgentSdkHarness({
      createQuery: ({ options }) => {
        capture(options);
        return fixtureClaudeQuery(
          (async function* (): AsyncGenerator<SDKMessage> {
            const init = claudeSystem("init", {
              fast_mode_state: fastModeState,
              fast_mode_disabled_reason: disabledReason,
            });
            const result = claudeSuccessResult("Provider response", "completed");
            yield sessionId ? { ...init, session_id: sessionId } as SDKMessage : init;
            yield sessionId ? { ...result, session_id: sessionId } as SDKMessage : result;
          })(),
        );
      },
    });
    const manager = new ProviderManager(
      { commands: { claude: process.execPath } },
      new AgentHarnessRegistry([harness]),
    );
    managers.push(manager);
    return manager;
  }

  function input(root: string) {
    return nativeProviderRunInput({
      providerId: "claude",
      conversationId: "claude-fast",
      cwd: root,
      prompt: "Use the requested response speed",
      model: "claude-opus",
      interactionMode: "build",
      access: "supervised",
    });
  }

  it("uses the exact SDK setting and requires Fast init attestation", async () => {
    const root = portableFixtureRoot("Claude SDK Fast mode");
    roots.push(root);
    let capturedOptions: ClaudeOptions | undefined;
    const manager = managerFor("on", (options) => {
      capturedOptions = options;
    });
    const base = input(root);
    const selection = withModelSelectionFastMode(base.modelSelection, "fast");

    await expect(manager.run({
      ...base,
      supportedFastMode: "fast",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(selection),
    })).resolves.toMatchObject({ status: "completed" });
    expect(capturedOptions?.settings).toMatchObject({
      fastMode: true,
      fastModePerSessionOptIn: true,
    });
  });

  it("fails closed when Claude reports Fast mode disabled", async () => {
    const root = portableFixtureRoot("Claude SDK Fast mode disabled");
    roots.push(root);
    const manager = managerFor("off", undefined, "model_not_allowed");
    const base = input(root);
    const selection = withModelSelectionFastMode(base.modelSelection, "fast");

    await expect(manager.run({
      ...base,
      supportedFastMode: "fast",
      modelSelection: selection,
      continuationIdentity: continuationIdentityForSelection(selection),
    })).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining(
        "selected Claude model does not allow Fast mode",
      ),
    });
  });

  it("forces and attests Standard when the advertised provider default is Fast", async () => {
    const root = portableFixtureRoot("Claude SDK Standard mode");
    roots.push(root);
    let capturedOptions: ClaudeOptions | undefined;
    const manager = managerFor("off", (options) => {
      capturedOptions = options;
    });

    await expect(manager.run({
      ...input(root),
      supportedFastMode: "fast",
    })).resolves.toMatchObject({ status: "completed" });
    expect(capturedOptions?.settings).toMatchObject({
      fastMode: false,
      fastModePerSessionOptIn: true,
    });
  });

  it("fails closed when Claude keeps a Standard request on provider-default Fast", async () => {
    const root = portableFixtureRoot("Claude SDK Standard mismatch");
    roots.push(root);
    const manager = managerFor("on");

    await expect(manager.run({
      ...input(root),
      supportedFastMode: "fast",
    })).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("did not confirm Standard speed"),
    });
  });

  it("explicitly resets a resumed Claude Fast session to Standard", async () => {
    const root = portableFixtureRoot("Claude SDK Standard reset");
    roots.push(root);
    let capturedOptions: ClaudeOptions | undefined;
    const manager = managerFor("off", (options) => {
      capturedOptions = options;
    }, null, "claude-fast-session");

    await expect(manager.run({
      ...input(root),
      supportedFastMode: "fast",
      sessionId: "claude-fast-session",
      performanceModeTransition: "to-standard",
    })).resolves.toMatchObject({ status: "completed" });
    expect(capturedOptions?.settings).toMatchObject({
      fastMode: false,
      fastModePerSessionOptIn: true,
    });
  });

  it("keeps Standard explicit when resuming without a speed transition", async () => {
    const root = portableFixtureRoot("Claude SDK resumed Standard mode");
    roots.push(root);
    let capturedOptions: ClaudeOptions | undefined;
    const manager = managerFor("off", (options) => {
      capturedOptions = options;
    }, null, "claude-standard-session");

    await expect(manager.run({
      ...input(root),
      supportedFastMode: "fast",
      sessionId: "claude-standard-session",
    })).resolves.toMatchObject({ status: "completed" });
    expect(capturedOptions?.settings).toMatchObject({
      fastMode: false,
      fastModePerSessionOptIn: true,
    });
  });

  it("omits Fast settings and attestation for unsupported routes", async () => {
    const root = portableFixtureRoot("Claude SDK unsupported Fast mode");
    roots.push(root);
    let capturedOptions: ClaudeOptions | undefined;
    const manager = managerFor("on", (options) => {
      capturedOptions = options;
    });

    await expect(manager.run(input(root)))
      .resolves.toMatchObject({ status: "completed" });
    expect(capturedOptions?.settings).toBeUndefined();
  });
});
