import { ArrowLeft, FolderOpen, GitBranch, Search, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import {
  validProjectCloneUrl,
  validProjectDirectoryName,
  type ProjectImportInput,
} from "../../../shared/project-import";
import { useNativePreviewSuspension } from "../hooks/useNativePreviewSuspension";
import { captureModalFocus, trapModalFocus } from "../utils/modalFocus";
import { IconButton } from "./ui";
import "./AddProjectDialog.css";

export function AddProjectDialog({
  onClose,
  onImport,
}: {
  onClose: () => void;
  onImport: (input: ProjectImportInput) => Promise<void>;
}): React.JSX.Element {
  const [source, setSource] = useState<"local" | "clone" | null>(null);
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [directoryName, setDirectoryName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  const pathId = useId();
  const submitting = useRef(false);
  useNativePreviewSuspension(true);
  useLayoutEffect(() => captureModalFocus(), []);
  useLayoutEffect(() => {
    root.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [source]);
  const sources = [
    {
      id: "local" as const,
      title: "Local folder",
      detail: "Open a project from your computer",
      icon: FolderOpen,
    },
    {
      id: "clone" as const,
      title: "Clone repository",
      detail: "GitHub, GitLab, Bitbucket, Azure DevOps, or a Git URL",
      icon: GitBranch,
    },
  ].filter((item) =>
    `${item.title} ${item.detail}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const chooseFolder = async (): Promise<void> => {
    try {
      const selected = await window.inertia.selectDirectory();
      if (selected) setPath(selected);
    } catch {
      setError(
        "The folder picker could not be opened. You can enter a folder path instead.",
      );
    }
  };
  const submit = async (): Promise<void> => {
    if (submitting.current || !path.trim()) return;
    if (
      source === "clone" &&
      (!validProjectCloneUrl(url.trim()) ||
        !validProjectDirectoryName(directoryName.trim()))
    ) {
      setError(
        "Use an HTTPS or SSH repository URL without embedded credentials and a valid new folder name.",
      );
      return;
    }
    submitting.current = true;
    setError(null);
    setBusy(true);
    try {
      await onImport({
        path: path.trim(),
        ...(source === "clone"
          ? { clone: { url: url.trim(), directoryName: directoryName.trim() } }
          : {}),
      });
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The project could not be added.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={root}
        className="add-project-dialog"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Add project"
        aria-busy={busy}
        onKeyDown={(event) => {
          trapModalFocus(event, event.currentTarget);
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header>
          {source && (
            <IconButton
              label="Back to project sources"
              disabled={busy}
              onClick={() => {
                setSource(null);
                setError(null);
              }}
            >
              <ArrowLeft size={16} />
            </IconButton>
          )}
          <h2>
            {source === "clone"
              ? "Clone repository"
              : source === "local"
                ? "Open local folder"
                : "Add project"}
          </h2>
          <IconButton
            label="Close add project"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </IconButton>
        </header>
        {!source ? (
          <>
            <div className="add-project-search">
              <Search size={17} />
              <input
                aria-label="Search project sources"
                placeholder="Search project sources…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && sources[0])
                    setSource(sources[0].id);
                }}
              />
            </div>
            <div className="add-project-sources">
              {sources.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSource(item.id)}
                >
                  <item.icon size={20} />
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                  </span>
                </button>
              ))}
              {!sources.length && <p>No matching sources</p>}
            </div>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {source === "clone" && (
              <label>
                Repository URL
                <input
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  value={url}
                  placeholder="https://github.com/owner/repository.git"
                  onChange={(event) => {
                    setUrl(event.target.value);
                    const name =
                      event.target.value
                        .split(/[/:]/u)
                        .filter(Boolean)
                        .at(-1)
                        ?.replace(/\.git$/u, "") ?? "";
                    if (
                      !directoryName ||
                      directoryName ===
                        url
                          .split(/[/:]/u)
                          .filter(Boolean)
                          .at(-1)
                          ?.replace(/\.git$/u, "")
                    )
                      setDirectoryName(name);
                  }}
                />
              </label>
            )}
            <div className="add-project-field">
              <label htmlFor={pathId}>
                {source === "clone" ? "Destination folder" : "Folder path"}
              </label>
              <div className="add-project-path">
                <input
                  id={pathId}
                  disabled={busy}
                  value={path}
                  placeholder="Choose a folder or paste its full path"
                  onChange={(event) => setPath(event.target.value)}
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void chooseFolder()}
                >
                  <FolderOpen size={15} />
                  Browse
                </button>
              </div>
            </div>
            {source === "clone" && (
              <>
                <label>
                  New folder name
                  <input
                    disabled={busy}
                    value={directoryName}
                    onChange={(event) => setDirectoryName(event.target.value)}
                  />
                </label>
                <p className="add-project-hint">
                  Uses your existing Git authentication. The repository opens in
                  a new folder inside the destination.
                </p>
              </>
            )}
            {error && (
              <p role="alert" className="add-project-error">
                {error}
              </p>
            )}
            <footer>
              <span role="status">
                {busy
                  ? source === "clone"
                    ? "Cloning repository…"
                    : "Opening project…"
                  : ""}
              </span>
              <button
                type="submit"
                className="primary-button"
                disabled={busy || !path.trim()}
              >
                {busy
                  ? "Adding…"
                  : source === "clone"
                    ? "Clone and open"
                    : "Open project"}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}
