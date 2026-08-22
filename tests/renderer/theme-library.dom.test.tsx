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
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeVisible();
    expect(screen.getByRole("radio", { name: "Inertia theme" })).toBeChecked();
    for (const option of COLOR_THEME_OPTIONS) {
      expect(screen.getByRole("radio", { name: `${option.label} theme` }))
        .toHaveAttribute("aria-checked", String(option.id === "inertia"));
    }
    expect(screen.getAllByText(/tuned light and dark palette/iu)).toHaveLength(1);

    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(onUpdate).toHaveBeenCalledWith({ theme: "dark" });
    fireEvent.click(screen.getByRole("radio", { name: "Ocean theme" }));
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

    for (const choice of screen.getAllByRole("radio")) {
      expect(choice).toBeDisabled();
    }
  });
});
