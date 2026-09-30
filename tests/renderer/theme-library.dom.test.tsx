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

    for (const choice of [...screen.getAllByRole("radio"), ...screen.getAllByRole("button"), ...screen.getAllByRole("textbox"), screen.getByLabelText("Light color picker"), screen.getByLabelText("Dark color picker")]) {
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
  it("validates keyboard hex input and changes only the requested appearance", () => {
    const onUpdate = vi.fn();
    render(<ThemeLibrary settings={{ theme: "light", colorTheme: "inertia", lightCustomColor: "#3a86ff" }} disabled={false} onUpdate={onUpdate} />);
    expect(screen.getByRole("button", { name: "Use custom color for light" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Use Inertia for light" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Use Inertia for dark" })).toHaveAttribute("aria-pressed", "true");
    const hex = screen.getByRole("textbox", { name: "Dark color" });
    fireEvent.change(hex, { target: { value: "oops" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(hex).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a hex color");
    fireEvent.keyDown(hex, { key: "Escape" });
    expect(hex).toHaveValue("#a3a3fa");
    fireEvent.change(hex, { target: { value: "F80" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(onUpdate).toHaveBeenLastCalledWith({ darkCustomColor: "#ff8800" });
    onUpdate.mockClear();
    fireEvent.input(screen.getByLabelText("Light color picker"), { target: { value: "#009688" } });
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Light color picker"), { target: { value: "#009688" } });
    expect(onUpdate).toHaveBeenLastCalledWith({ lightCustomColor: "#009688" });
    fireEvent.click(screen.getByRole("button", { name: "Reset light custom color" }));
    expect(onUpdate).toHaveBeenLastCalledWith({ lightCustomColor: null });
  });

  it("names each hex field by its visible label", () => {
    render(<ThemeLibrary settings={{ theme: "light", colorTheme: "inertia" }} disabled={false} onUpdate={vi.fn()} />);
    for (const label of ["Light color", "Dark color"]) {
      const hex = screen.getByRole("textbox", { name: label });
      expect(document.querySelector(`label[for="${hex.id}"]`)?.textContent).toBe(label);
      expect(hex).not.toHaveAttribute("aria-label");
    }
    expect(screen.queryByRole("textbox", { name: "Light hex color" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Dark hex color" })).toBeNull();
  });

  it("reports an invalid hex color only after a failed commit", () => {
    const onUpdate = vi.fn();
    render(<ThemeLibrary settings={{ theme: "light", colorTheme: "inertia" }} disabled={false} onUpdate={onUpdate} />);
    const hex = screen.getByRole("textbox", { name: "Light color" });
    for (const typed of ["#", "#3", "#3a", "#3a8", "#3a86", "#3a86f"]) {
      fireEvent.change(hex, { target: { value: typed } });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(hex).toHaveAttribute("aria-invalid", "false");
    }
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(onUpdate).not.toHaveBeenCalled();
    expect(hex).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a hex color");
    fireEvent.change(hex, { target: { value: "#3a86ff" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(hex).toHaveAttribute("aria-invalid", "false");
    fireEvent.change(hex, { target: { value: "#3a86f" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.blur(hex);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a hex color");
    fireEvent.keyDown(hex, { key: "Escape" });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(hex, { target: { value: "#3a86ff" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ lightCustomColor: "#3a86ff" });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
