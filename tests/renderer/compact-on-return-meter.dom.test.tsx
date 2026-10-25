import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UsageIndicator } from "../../src/renderer/src/components/UsageIndicator";
import { Composer } from "../../src/renderer/src/components/Composer";
import type { ProviderInfo, ThreadUsageSnapshot } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { composerProps, conversation, provider } from "./composer-fixtures";

const unavailable = {
  freshness: "unavailable" as const,
  provenance: null,
  updatedAt: null,
  lastAttemptedAt: null,
  refreshing: false,
};

function usage(minutesIdle: number): ThreadUsageSnapshot {
  return {
    conversationId: "88888888-8888-4888-8888-888888888888",
    turnId: null,
    usedTokens: 252_000,
    totalProcessedTokens: null,
    totalProcessedScope: null,
    maxTokens: 1_000_000,
    inputTokens: null,
    cachedInputTokens: null,
    cacheWriteInputTokens: null,
    outputTokens: null,
    reasoningOutputTokens: null,
    compactsAutomatically: null,
    promptCache: {
      lastRequestStartedAt: new Date(Date.now() - minutesIdle * 60_000).toISOString(),
      lifetimeMs: 300_000,
      source: "configured",
    },
    updatedAt: new Date().toISOString(),
  };
}

function openMeter(): HTMLElement {
  fireEvent.click(screen.getByRole("button", { name: /Open usage and context/u }));
  return screen.getByRole("dialog", { name: "Usage & context" });
}

describe("prompt cache in the usage meter", () => {
  it.each([
    [20, "Prompt cache expired 15 min ago"],
    [2, "Prompt cache warm, expires in 3 min"],
  ])("describes a cache last used %i minutes ago", (minutes, text) => {
    const snapshot = usage(minutes);
    render(
      <UsageIndicator
        usage={snapshot}
        promptCache={{ lastRequestStartedAt: snapshot.promptCache!.lastRequestStartedAt, lifetimeMs: 300_000, source: "configured" }}
        rateLimits={[]}
        rateLimitState={unavailable}
        quotaSource="api-key"
        mode="compact"
        providerLabel="Claude · Anthropic API key"
        onModeChange={() => undefined}
      />,
    );
    expect(within(openMeter()).getByText(text)).toBeInTheDocument();
  });

  it("stays quiet without the route's prompt cache", () => {
    render(
      <UsageIndicator
        usage={usage(20)}
        rateLimits={[]}
        rateLimitState={unavailable}
        quotaSource="selected-route"
        mode="compact"
        providerLabel="Claude · Claude account"
        onModeChange={() => undefined}
      />,
    );
    expect(within(openMeter()).queryByText(/^Prompt cache /u)).toBeNull();
  });

  it.each([
    ["Console API key" as const, true],
    ["Claude account" as const, false],
  ])("shows the cache line in the composer meter for a %s only when it is an API-key route", (accountKind, shown) => {
    const claude: ProviderInfo = { ...provider, id: "claude", label: "Claude", command: "claude", accountKind };
    const chat = {
      ...conversation("88888888-8888-4888-8888-888888888888"),
      providerId: "claude" as const,
      modelSelection: providerNativeModelSelection({ providerId: "claude", modelId: "provider-default", reasoningEffort: null }),
    };
    render(<Composer {...composerProps(chat, { providers: [claude], usage: usage(20) })} />);
    const meter = openMeter();
    if (shown) expect(within(meter).getByText("Prompt cache expired 15 min ago")).toBeInTheDocument();
    else expect(within(meter).queryByText(/^Prompt cache /u)).toBeNull();
  });
});
