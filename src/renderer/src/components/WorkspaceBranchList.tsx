import { useEffect, useRef, useState } from "react";
import { Check, GitBranch, Search, RefreshCw } from "lucide-react";
import type { GitBranchInfo } from "@shared/contracts";
import "./workspace-git-menus.css";

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
  return <>
    <label className="git-branch-search"><Search size={14} /><input ref={searchRef} type="search" aria-label="Search branches" placeholder="Search branches…" value={query} maxLength={255} onChange={(event) => { queued.current = null; setQuery(event.target.value); }} onBlur={() => { queued.current = null; }} onCompositionStart={() => { queued.current = null; }} onKeyDown={(event) => {
      if (event.key === "Enter") {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) { queued.current = null; return; }
        event.preventDefault();
        const branch = visible.find((choice) => choice.current || !choice.checkedOut);
        if (!branch || busy || error) return;
        if (loading) queued.current = branch;
        else if (branch.current) onClose?.();
        else onSwitch(branch.name, branch.remote);
        return;
      }
      queued.current = null;
      if (!["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) event.stopPropagation();
    }} /></label>
    <div className="git-branch-load-status">
      <span role="status">{loading ? "Refreshing branches…" : error ?? `${branches.length} branches`}</span>
      {onRefresh && <button type="button" aria-label="Refresh branches" disabled={loading || busy} onClick={onRefresh}><RefreshCw size={13} /></button>}
    </div>
    <div className="git-branch-results" aria-busy={loading}>
      {[false, true].map((remote) => {
        const group = visible.filter((branch) => branch.remote === remote);
        if (group.length === 0) return null;
        return <div role="group" aria-label={remote ? "Remote branches" : "Local branches"} key={String(remote)}>
          <div className="git-menu-section-label">{remote ? "Remote branches" : "Local branches"}<span>{group.length}</span></div>
          {group.map((branch) => <button type="button" role="menuitemradio" aria-checked={branch.current} disabled={busy || loading || Boolean(error) || (!branch.current && Boolean(branch.checkedOut))} key={branch.name} title={`${branch.name}${branch.checkedOut && !branch.current ? " · Checked out in another worktree" : branch.remote ? " · Create a local tracking branch" : ""}`} onClick={() => { if (branch.current) onClose?.(); else onSwitch(branch.name, branch.remote); }}>
            <GitBranch size={13} /><span className="git-branch-name">{branch.name}</span>
            {branch.current ? <Check size={13} aria-label="Current" /> : branch.checkedOut ? <small>In worktree</small> : remote ? <small>Track</small> : null}
          </button>)}
        </div>;
      })}
      {visible.length === 0 && !loading && !error && <p className="git-branch-empty" role="status">{branches.length === 0 ? "No branches loaded. Refresh the branch list to try again." : "No matching branches."}</p>}
    </div>
    <form className="new-branch-form" onSubmit={(event) => {
      event.preventDefault();
      const name = new FormData(event.currentTarget).get("branch");
      if (!busy && !loading && typeof name === "string" && name.trim()) onCreate(name.trim());
    }}>
      <input name="branch" placeholder="New branch name" aria-label="New branch name" maxLength={255} required disabled={busy || loading} />
      <button type="submit" disabled={busy || loading}>Create</button>
    </form>
  </>;
}
