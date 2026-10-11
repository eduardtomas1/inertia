import { useEffect, useRef, useState } from "react";
import { Check, GitBranch, Search, RefreshCw } from "lucide-react";
import type { GitBranchInfo } from "@shared/contracts";
import "./workspace-git-menus.css";
import { IconButton } from "./ui";

export default function WorkspaceBranchList({ branches, busy, loading = false, error, onRefresh, onSwitch, onCreate, onClose }: {
  branches: GitBranchInfo[];
  busy: boolean;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  onSwitch: (name: string, remote?: boolean) => void;
  onCreate: (name: string) => void;
  onClose?: () => void;
}): React.JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { searchRef.current?.focus(); }, []);
  const [query, setQuery] = useState("");
  const queued = useRef<GitBranchInfo | null>(null);
  useEffect(() => {
    if (loading && !busy && !error) return;
    const choice = queued.current;
    queued.current = null;
    const branch = choice && branches.find(({ name, remote }) => name === choice.name && remote === choice.remote);
    if (loading || busy || error || !branch || (!branch.current && branch.checkedOut)) return;
    if (branch.current) onClose?.();
    else onSwitch(branch.name, branch.remote);
  }, [branches, busy, error, loading, onClose, onSwitch]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = branches.filter((branch) => branch.name.toLocaleLowerCase().includes(needle));
  const select = (branch: GitBranchInfo) => {
    if (busy || error || (!branch.current && branch.checkedOut)) return;
    if (loading) queued.current = branch;
    else if (branch.current) onClose?.();
    else onSwitch(branch.name, branch.remote);
  };
  return <>
    <div className="git-branch-search"><Search size={14} aria-hidden="true" /><input ref={searchRef} type="search" aria-label="Search branches" placeholder="Search branches…" value={query} maxLength={255} onChange={(event) => { queued.current = null; setQuery(event.target.value); }} onBlur={() => { queued.current = null; }} onCompositionStart={() => { queued.current = null; }} onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) { queued.current = null; return; }
        event.preventDefault();
        const branch = visible.find((choice) => choice.current || !choice.checkedOut);
        if (branch) select(branch);
        return;
      }
      queued.current = null;
      if (!["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) event.stopPropagation();
    }} />{onRefresh && <IconButton label="Refresh branches" disabled={loading || busy} onClick={() => onRefresh()}><RefreshCw size={14} /></IconButton>}</div>
    <p className="git-branch-load-status" role="status">{loading ? "Refreshing branches…" : error ?? ""}</p>
    <div className="git-branch-results" aria-busy={loading} onBlur={() => { queued.current = null; }}>
      {[false, true].map((remote) => {
        const group = visible.filter((branch) => branch.remote === remote);
        if (group.length === 0) return null;
        const labelled = visible.some((branch) => branch.remote !== remote);
        return <div role="group" aria-label={remote ? "Remote branches" : "Local branches"} key={String(remote)}>
          {labelled && <div className="git-menu-section-label">{remote ? "Remote" : "Local"}</div>}
          {group.map((branch) => <button type="button" role="menuitemradio" aria-checked={branch.current} disabled={busy || Boolean(error) || (!branch.current && Boolean(branch.checkedOut))} key={branch.name} title={branch.name} onClick={() => select(branch)}>
            <GitBranch size={14} /><span className="git-branch-name">{branch.name}</span>
            {branch.current ? <Check size={14} aria-label="Current" /> : branch.checkedOut ? <small>In worktree</small> : remote ? <small>Track</small> : null}
          </button>)}
        </div>;
      })}
      {visible.length === 0 && !loading && !error && <p className="git-branch-empty" role="status">{branches.length === 0 ? "No branches loaded." : "No matching branches."}</p>}
    </div>
    <form className="new-branch-form" onSubmit={(event) => {
      event.preventDefault();
      const name = new FormData(event.currentTarget).get("branch");
      if (!busy && !loading && typeof name === "string" && name.trim()) onCreate(name.trim());
    }}>
      <input name="branch" placeholder="New branch name" aria-label="New branch name" maxLength={255} required disabled={busy} />
      <button type="submit" disabled={busy || loading}>Create</button>
    </form>
  </>;
}
