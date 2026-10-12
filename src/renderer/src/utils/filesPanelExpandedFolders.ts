const expandedFoldersByWorkspace = new Map<string, ReadonlySet<string>>();

export function rememberedExpandedFolders(key: string): Set<string> {
  return new Set(expandedFoldersByWorkspace.get(key));
}

export function rememberExpandedFolders(key: string, paths: ReadonlySet<string>): void {
  expandedFoldersByWorkspace.set(key, paths);
}

export function forgetExpandedFolders(): void {
  expandedFoldersByWorkspace.clear();
}
