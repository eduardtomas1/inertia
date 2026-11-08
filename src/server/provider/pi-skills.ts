import { basename, dirname, join } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { objectValue } from "../codex/protocol";
import { isOwnAttachmentPath } from "./attachment-read-grant";
import { piLaunchConfiguration, piRpcArguments } from "./pi-launch";
import { openPiRpcConnection } from "./pi-rpc";
import type { ProviderSkillInput } from "../../shared/contracts";
import { AcpSecretRedactor } from "./acp-redaction";

export interface PiSkill { name: string; description: string; path: string; scope: "user" | "repo"; argumentHint: string }

export function piSkillRoots(environment: NodeJS.ProcessEnv, cwd: string): string[] {
  return [join(dirname(piLaunchConfiguration(environment).sessionDirectory), "skills"), join(cwd, ".pi", "skills")];
}

export async function validatePiSkills(skills: readonly ProviderSkillInput[], environment: NodeJS.ProcessEnv, cwd: string): Promise<string[]> {
  const roots = piSkillRoots(environment, cwd);
  const paths: string[] = [];
  for (const skill of skills) {
    if (skill.source !== "pi-native" || !isOwnAttachmentPath(skill.path, roots) || basename(skill.path) !== "SKILL.md") throw new Error("Pi skill is outside its authorized native roots.");
    const stat = await lstat(skill.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 || await realpath(skill.path) !== skill.path) throw new Error("Pi skill is not a bounded canonical file.");
    paths.push(skill.path);
  }
  return paths;
}

export async function readPiSkills(executable: string, environment: NodeJS.ProcessEnv, cwd: string, signal?: AbortSignal): Promise<PiSkill[]> {
  const config = piLaunchConfiguration(environment, executable);
  const connection = openPiRpcConnection({ executable: config.executable, environment, cwd, signal,
    args: piRpcArguments({ ...config, args: [] }, { ephemeral: true }), timeoutMs: 10_000 });
  try {
    const commands = objectValue(await connection.request("get_commands"))?.commands;
    if (!Array.isArray(commands) || commands.length > 2_000) throw new Error("Pi skill catalog exceeded its limit.");
    const roots = piSkillRoots(environment, cwd); const skills: PiSkill[] = [];
    const redact = new AcpSecretRedactor(environment);
    for (const command of commands) {
      const entry = objectValue(command); const source = objectValue(entry?.sourceInfo);
      if (entry?.source !== "skill" || typeof entry.name !== "string" || !/^skill:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/u.test(entry.name)
        || typeof source?.path !== "string" || typeof entry.description !== "string") continue;
      const name = entry.name.slice(6);
      if (redact.payload(name) !== name) continue;
      try { await validatePiSkills([{ source: "pi-native", name, path: source.path }], environment, cwd); }
      catch { continue; }
      skills.push({ name, description: redact.payload(entry.description.slice(0, 1000)), path: source.path, argumentHint: "",
        scope: isOwnAttachmentPath(source.path, [roots[1]!]) ? "repo" : "user" });
    }
    return skills.filter((skill) => skills.filter((other) => other.name === skill.name).length === 1).slice(0, 256);
  } finally { await connection.close(); }
}
