import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function createMockLinkedCheckout(
  checkoutPath: string,
  identity: string,
): void {
  mkdirSync(checkoutPath, { recursive: true });
  let repositoryRoot = dirname(checkoutPath);
  while (
    dirname(repositoryRoot) !== repositoryRoot
    && !existsSync(join(repositoryRoot, ".git"))
  ) repositoryRoot = dirname(repositoryRoot);
  const commonDirectory = join(repositoryRoot, ".git");
  if (!existsSync(commonDirectory)) return;
  const adminDirectory = join(
    commonDirectory,
    "worktrees",
    `mock-${identity}`,
  );
  mkdirSync(adminDirectory, { recursive: true });
  writeFileSync(join(checkoutPath, ".git"), `gitdir: ${adminDirectory}\n`);
  writeFileSync(join(adminDirectory, "commondir"), "../..\n");
}
