import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TurnFailureNotice } from "../../src/renderer/src/components/composer/TurnFailureNotice";
import { UsageLimitsPanel } from "../../src/renderer/src/components/UsageLimitsPanel";
import { ProviderAccountRow } from "../../src/renderer/src/components/backend-settings/ProviderAccountRow";
import { modelChooserRowFromRoute, modelChooserSecondaryIdentity } from "../../src/renderer/src/components/ModelChooserRow";
import { buildComposerModelRoutes } from "../../src/renderer/src/utils/modelChooserRoutes";
import { turnFailure, turnFailureGuidance, type TurnFailureRoute } from "../../src/renderer/src/utils/turnFailureGuidance";
import type { ProviderInfo, ServerEvent } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { usageAccount } from "../helpers/usage-limits";

function provider(id: ProviderInfo["id"], overrides: Partial<ProviderInfo> & { accountKind?: string } = {}): ProviderInfo {
  const metadata = { freshness: "fresh" as const, provenance: "provider" as const, updatedAt: null, lastAttemptedAt: null, refreshing: false };
  return {
    id,
    label: id === "claude" ? "Claude" : "Codex",
    command: id,
    available: true,
    version: "1.0.0",
    executable: `/usr/local/bin/${id}`,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
    ...overrides,
  } as ProviderInfo;
}

const keyRoute = (protocol: string): TurnFailureRoute => ({
  routeKind: "api-key",
  protocol,
  backendProfileId: "custom:key",
  displayName: "Personal key",
});

describe("account kind", () => {
  it("names the kind of sign-in on the account row and the chooser's account route", () => {
    const claude = provider("claude", { accountKind: "Console API key" });
    render(
      <ProviderAccountRow
        providerId="claude"
        providerName="Claude Code"
        provider={claude}
        identityLabel="Work"
        disabled={false}
        onConnect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText("Signed in as Work · Console API key")).toBeInTheDocument();
    const route = buildComposerModelRoutes([claude], [], providerNativeModelSelection({ providerId: "claude" }), { claude: "Work" })[0]!;
    expect(route.routeLabel).toBe("Work · Console API key");
    expect(modelChooserSecondaryIdentity(modelChooserRowFromRoute(route, { active: false, favorite: false })))
      .toBe("Claude · Work · Console API key");
  });

  it("leaves the account route label alone when the status has no account kind", () => {
    const route = buildComposerModelRoutes([provider("codex")], [], providerNativeModelSelection({ providerId: "codex" }))[0]!;
    expect(route.routeLabel).toBeUndefined();
  });
});

describe("usage that an agent does not report", () => {
  it("says so on the Limits row instead of a blank quota", async () => {
    const now = new Date().toISOString();
    const cursor = usageAccount({
      id: "native:cursor", providerId: "cursor", providerLabel: "Cursor", label: "Cursor account", identityKey: null,
      status: "unavailable", detail: "Usage is not reported by this agent.", windows: [], credits: null, canReset: false, updatedAt: now,
    });
    const result: ServerEvent = {
      type: "request.result",
      requestId: crypto.randomUUID(),
      result: { kind: "usage.limits", snapshot: { accounts: [cursor], sources: [], checkedAt: now } },
    } as ServerEvent;
    render(<UsageLimitsPanel status="online" request={vi.fn(async () => result)} />);
    const region = await screen.findByRole("region", { name: "Cursor limits" });
    expect(within(region).getAllByText("Usage is not reported by this agent.")[0]).toBeInTheDocument();
    expect(within(region).queryByText("Quota not reported")).not.toBeInTheDocument();
  });
});

describe("turn failure guidance", () => {
  it("reads only the known failure kinds", () => {
    expect(turnFailure({ failureKind: "billing" })).toEqual({ kind: "billing", resetsAt: null });
    expect(turnFailure({ failureKind: "something-else" })).toBeNull();
    expect(turnFailure({})).toBeNull();
  });

  it("tells the person where to add credits for an official API key route", () => {
    expect(turnFailureGuidance({ kind: "billing", resetsAt: null }, { ...keyRoute("anthropic-messages"), preset: "anthropic-api-key" })?.detail)
      .toBe("Add credits in the Anthropic Console, then send again.");
    expect(turnFailureGuidance({ kind: "billing", resetsAt: null }, { ...keyRoute("openai-responses"), preset: "openai-api-key" })?.detail)
      .toBe("Add credits at platform.openai.com, then send again.");
    expect(turnFailureGuidance({ kind: "billing", resetsAt: null }, { ...keyRoute("anthropic-messages"), preset: "custom", endpointHost: "api.anthropic.com" })?.detail)
      .toBe("Add credits in the Anthropic Console, then send again.");
  });

  it("gives gateways generic credit advice", () => {
    for (const protocol of ["anthropic-messages", "openai-responses"]) {
      expect(turnFailureGuidance({ kind: "billing", resetsAt: null }, { ...keyRoute(protocol), preset: "custom", endpointHost: "gateway.example.test" })?.detail)
        .toBe("Check your credits with this backend's provider, then send again.");
    }
  });

  it("offers Replace key for a rejected key and Edit models for a missing model", () => {
    expect(turnFailureGuidance({ kind: "authentication", resetsAt: null }, keyRoute("anthropic-messages"))?.action)
      .toEqual({ kind: "replace-key", label: "Replace key" });
    expect(turnFailureGuidance({ kind: "model-not-found", resetsAt: null }, keyRoute("anthropic-messages"))?.action)
      .toEqual({ kind: "edit-models", label: "Edit models" });
  });

  it("names the reset time for a rate limit", () => {
    const now = new Date("2026-10-24T10:00:00").getTime();
    const guidance = turnFailureGuidance({ kind: "rate-limited", resetsAt: "2026-10-24T10:30:00" }, keyRoute("anthropic-messages"), now);
    expect(guidance?.detail).toMatch(/^The provider limits how often this key can be used\. Try again at 10:30/u);
  });

  it("keeps the usage-limit copy for subscription routes", () => {
    expect(turnFailureGuidance({ kind: "billing", resetsAt: null }, { ...keyRoute("anthropic-messages"), routeKind: "account" })).toBeNull();
  });

  it("runs the route action from the composer notice", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    const guidance = turnFailureGuidance({ kind: "authentication", resetsAt: null }, keyRoute("anthropic-messages"))!;
    render(<TurnFailureNotice guidance={guidance} disabled={false} onAction={onAction} />);
    const notice = screen.getByRole("group", { name: "Route problem" });
    expect(notice).toHaveTextContent("Personal key was rejected");
    await user.click(within(notice).getByRole("button", { name: "Replace key" }));
    expect(onAction).toHaveBeenCalledWith({ kind: "replace-key", label: "Replace key" });
  });
});
