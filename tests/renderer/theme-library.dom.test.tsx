import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ThemeLibrary } from "../../src/renderer/src/components/ThemeLibrary";
import { COLOR_THEME_OPTIONS } from "../../src/renderer/src/utils/colorThemes";

describe("Theme library", () => {
  it("keeps appearance and color family as independent accessible choices", () => {
    const onUpdate = vi.fn();
    render(
      <ThemeLibrary
        settings={{ theme: "system", colorTheme: "inertia" }}
        disabled={false}
        onUpdate={onUpdate}
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    expect(screen.getByRole("group", { name: "Color theme" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Inertia theme" })).toHaveAttribute("aria-pressed", "true");
    for (const option of COLOR_THEME_OPTIONS) {
      expect(screen.getByRole("button", { name: `${option.label} theme` }))
        .toHaveAttribute("aria-pressed", String(option.id === "inertia"));
    }
    expect(screen.getByText(/circle for one appearance/u)).toBeVisible();

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(onUpdate).toHaveBeenCalledWith({ theme: "dark" });
    fireEvent.click(screen.getByRole("button", { name: "Ocean theme" }));
    expect(onUpdate).toHaveBeenCalledWith({ colorTheme: "ocean" });
  });

  it("disables every appearance and family choice together", () => {
    render(
      <ThemeLibrary
        settings={{ theme: "light", colorTheme: "ember" }}
        disabled
        onUpdate={vi.fn()}
      />,
    );

    for (const choice of [...screen.getAllByRole("radio"), ...screen.getAllByRole("button")]) {
      expect(choice).toBeDisabled();
    }
  });

  it("selects each appearance independently without also activating the card", () => {
    const onUpdate = vi.fn();
    render(<ThemeLibrary settings={{ theme: "system", colorTheme: "inertia", lightColorTheme: "grove", darkColorTheme: "iris" }} disabled={false} onUpdate={onUpdate} />);
    expect(screen.getByRole("button", { name: "Use Grove for light" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Use Iris for dark" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Grove theme" })).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Use Ocean for light" }));
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ lightColorTheme: "ocean" });
    onUpdate.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Use Ember for dark" }));
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ darkColorTheme: "ember" });
  });
});
