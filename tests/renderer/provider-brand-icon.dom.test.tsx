import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderBrandIcon } from "../../src/renderer/src/components/ProviderBrandIcon";
import {
  providerIconDefinition,
  supportedProviderIconDefinitions,
} from "../../src/renderer/src/utils/providerIcons";

describe("ProviderBrandIcon", () => {
  it("maps every supported provider to a bundled official brand asset", () => {
    expect(supportedProviderIconDefinitions().map((definition) => ({
      providerId: definition.providerId,
      brand: definition.brand,
      label: definition.label,
      hasDarkAsset: Boolean(definition.darkSrc),
      invertInDark: Boolean(definition.invertInDark),
    }))).toEqual([
      {
        providerId: "codex",
        brand: "openai",
        label: "OpenAI",
        hasDarkAsset: false,
        invertInDark: true,
      },
      {
        providerId: "claude",
        brand: "anthropic",
        label: "Anthropic",
        hasDarkAsset: false,
        invertInDark: false,
      },
      {
        providerId: "cursor",
        brand: "cursor",
        label: "Cursor",
        hasDarkAsset: true,
        invertInDark: false,
      },
      {
        providerId: "gemini",
        brand: "gemini",
        label: "Gemini CLI",
        hasDarkAsset: false,
        invertInDark: false,
      },
      {
        providerId: "kimi",
        brand: "kimi",
        label: "Kimi Code",
        hasDarkAsset: false,
        invertInDark: true,
      },
      {
        providerId: "opencode",
        brand: "opencode",
        label: "OpenCode",
        hasDarkAsset: true,
        invertInDark: false,
      },
    ]);

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
        <ProviderBrandIcon providerId="gemini" />
        <ProviderBrandIcon providerId="kimi" />
        <ProviderBrandIcon providerId="opencode" />
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
    expect(screen.getByRole("img", { name: "Gemini CLI icon" }))
      .toHaveAttribute("data-provider-brand", "gemini");
    expect(screen.getByRole("img", { name: "Kimi Code icon" }))
      .toHaveAttribute("data-provider-brand", "kimi");
    expect(screen.getByRole("img", { name: "OpenCode icon" }).querySelectorAll("img"))
      .toHaveLength(2);
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

  it("keeps decorative row icons out of the accessibility tree", () => {
    render(<ProviderBrandIcon providerId="codex" decorative />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    const icon = document.querySelector('[data-provider-brand="openai"]');
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });
});
