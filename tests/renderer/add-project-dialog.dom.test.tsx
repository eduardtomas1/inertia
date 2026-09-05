import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddProjectDialog } from "../../src/renderer/src/components/AddProjectDialog";

afterEach(() => vi.unstubAllGlobals());

describe("add project dialog", () => {
  it("searches sources, uses the native folder picker, and imports the chosen path", async () => {
    const onImport = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const selectDirectory = vi.fn().mockResolvedValue("/work/website");
    vi.stubGlobal("inertia", { selectDirectory });
    render(<AddProjectDialog onImport={onImport} onClose={onClose} />);
    const search = screen.getByRole("textbox", {
      name: "Search project sources",
    });
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: "local" } });
    expect(
      screen.queryByRole("button", { name: /Clone repository/u }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(search, { key: "Enter" });
    const path = screen.getByRole("textbox", { name: "Folder path" });
    expect(path).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await waitFor(() => expect(path).toHaveValue("/work/website"));
    fireEvent.click(screen.getByRole("button", { name: "Open project" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onImport).toHaveBeenCalledExactlyOnceWith({ path: "/work/website" });
  });

  it("keeps a clone request owned while pending and allows a failed request to retry", async () => {
    let rejectImport!: (error: Error) => void;
    const onImport = vi.fn().mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectImport = reject;
        }),
    );
    const onClose = vi.fn();
    render(<AddProjectDialog onImport={onImport} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Clone repository/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Repository URL" }), {
      target: { value: "https://github.com/example/website.git" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Destination folder" }),
      { target: { value: "/work" } },
    );
    expect(
      screen.getByRole("textbox", { name: "New folder name" }),
    ).toHaveValue("website");
    const form = screen
      .getByRole("button", { name: "Clone and open" })
      .closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onImport).toHaveBeenCalledExactlyOnceWith({
      path: "/work",
      clone: {
        url: "https://github.com/example/website.git",
        directoryName: "website",
      },
    });
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: "Close add project" }),
    ).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      rejectImport(new Error("Choose a new folder name."));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Choose a new folder name.",
    );
    expect(
      screen.getByRole("button", { name: "Clone and open" }),
    ).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox", { name: "New folder name" }), {
      target: { value: "website-copy" },
    });
    onImport.mockResolvedValueOnce(undefined);
    fireEvent.submit(form);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onImport).toHaveBeenCalledTimes(2);
  });

  it("blocks embedded credentials and unsafe folder names before sending a request", () => {
    const onImport = vi.fn();
    render(<AddProjectDialog onImport={onImport} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Clone repository/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Repository URL" }), {
      target: { value: "https://user:password@example.com/repo.git" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Destination folder" }),
      { target: { value: "/work" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Clone and open" }));
    expect(onImport).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).not.toHaveTextContent("password");
    fireEvent.change(screen.getByRole("textbox", { name: "Repository URL" }), {
      target: { value: "git@example.com:owner/repo.git" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "New folder name" }), {
      target: { value: "../outside" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clone and open" }));
    expect(onImport).not.toHaveBeenCalled();
  });

  it("restores focus on close and keeps the path editable if browsing fails", async () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    vi.stubGlobal("inertia", {
      selectDirectory: vi.fn().mockRejectedValue(new Error("unavailable")),
    });
    const onClose = vi.fn();
    const view = render(
      <AddProjectDialog onImport={vi.fn()} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Local folder/u }));
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox", { name: "Folder path" })).toBeEnabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
