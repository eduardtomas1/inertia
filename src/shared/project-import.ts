/** Project sources contain repository identity only, never embedded credentials. */
export function validProjectCloneUrl(value: string): boolean {
  if (value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value))
    return false;
  if (/^git@[a-z0-9.-]+:[a-z0-9_./-]+$/iu.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "ssh:") &&
      Boolean(url.hostname) &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "ssh:"
        ? !url.username || url.username === "git"
        : !url.username) &&
      url.pathname !== "/"
    );
  } catch {
    return false;
  }
}

export function validProjectDirectoryName(value: string): boolean {
  return (
    /^[a-z0-9][a-z0-9._-]{0,79}$/iu.test(value) &&
    !/[. ]$/u.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  );
}

export interface ProjectImportInput {
  path: string;
  clone?: { url: string; directoryName: string };
}
