import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderBrandIcon } from "../../src/renderer/src/components/ProviderBrandIcon";
import {
  providerIconDefinition,
  supportedProviderIconDefinitions,
} from "../../src/renderer/src/utils/providerIcons";

describe("ProviderBrandIcon", () => {
  it("bundles every supported provider mark locally", () => {
    for (const definition of supportedProviderIconDefinitions()) {
      expect(definition.lightSrc).toMatch(
        /^(?:data:image\/svg\+xml|.*\.svg(?:\?|$))/u,
      );
      expect(definition.lightSrc).not.toMatch(/^https?:/u);
      if (definition.darkSrc) {
        expect(definition.darkSrc).not.toMatch(/^https?:/u);
      }
      expect(providerIconDefinition(definition.providerId)).toBe(definition);
    }
  });

  it("renders official marks at the requested size with accessible names", () => {
    render(
      <>
        <ProviderBrandIcon providerId="codex" size={18} />
        <ProviderBrandIcon providerId="claude" />
        <ProviderBrandIcon providerId="cursor" />
        <ProviderBrandIcon providerId="kimi" size={13} />
        <ProviderBrandIcon providerId="opencode" />
        <ProviderBrandIcon providerId="antigravity" size={16} />
      </>,
    );

    const openai = screen.getByRole("img", { name: "OpenAI icon" });
    expect(openai).toHaveAttribute("data-provider-icon-kind", "official");
    expect(openai).toHaveAttribute("data-provider-brand", "openai");
    expect(openai).toHaveStyle("--provider-icon-size: 18px");
    expect(openai.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "Anthropic icon" }))
      .toHaveAttribute("data-provider-brand", "anthropic");
    expect(screen.getByRole("img", { name: "Cursor icon" }).querySelectorAll("img"))
      .toHaveLength(2);
    const kimi = screen.getByRole("img", { name: "Kimi Code icon" });
    expect(kimi).toHaveAttribute("data-provider-brand", "kimi");
    expect(kimi).toHaveAttribute("data-provider-icon-kind", "official");
    expect(kimi).toHaveStyle("--provider-icon-size: 13px");
    expect(kimi).toHaveClass("has-dark-source");
    expect(kimi).not.toHaveClass("is-dark-invert");
    const kimiSources = kimi.querySelectorAll("img");
    expect(kimiSources).toHaveLength(2);
    expect(kimiSources[0])
      .toHaveAttribute("src", expect.stringMatching(/kimi-light\.svg(?:\?|$)/u));
    expect(kimiSources[1])
      .toHaveAttribute("src", expect.stringMatching(/kimi-dark\.svg(?:\?|$)/u));
    expect(screen.getByRole("img", { name: "OpenCode icon" }).querySelectorAll("img"))
      .toHaveLength(2);
    const antigravity = screen.getByRole("img", { name: "Antigravity icon" });
    expect(antigravity).toHaveAttribute("data-provider-icon-kind", "official");
    expect(antigravity).toHaveAttribute("data-provider-brand", "antigravity");
    expect(antigravity).toHaveStyle("--provider-icon-size: 16px");
    expect(antigravity).toHaveClass("is-dark-invert");
    expect(antigravity).not.toHaveClass("has-dark-source");
    const sources = antigravity.querySelectorAll("img");
    expect(sources).toHaveLength(1);
    expect(sources[0]).toHaveClass("is-light");
  });

  it("uses an intentional neutral fallback for unknown and custom providers", () => {
    expect(providerIconDefinition("custom:team")).toBeNull();
    expect(providerIconDefinition(null)).toBeNull();

    render(
      <ProviderBrandIcon
        providerId="custom:team"
        label="Team gateway provider"
      />,
    );
    const fallback = screen.getByRole("img", { name: "Team gateway provider" });
    expect(fallback).toHaveAttribute("data-provider-brand", "custom");
    expect(fallback).toHaveAttribute("data-provider-icon-kind", "fallback");
    expect(fallback.querySelector("[data-provider-icon-fallback]"))
      .not.toBeNull();
    expect(fallback.querySelector("img")).toBeNull();
  });

  it.each(["codex", "kimi"])("keeps decorative %s row icons out of the accessibility tree", (providerId) => {
    render(<ProviderBrandIcon providerId={providerId} decorative />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    const icon = document.querySelector(`[data-provider-id="${providerId}"]`);
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });
});
