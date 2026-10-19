/**
 * Applications App control never reads or acts on, even when they run inside
 * the launched app's process tree: password managers, credential, askpass,
 * PIN and consent prompts, keyrings and wallets, system settings and the
 * login session. There is no override.
 * Inertia's own process tree is always denied by pid, separately.
 *
 * Matching is done on a normalized key (lowercase letters and digits only) of
 * the application name, the bundle id (and each of its dot-separated parts)
 * and the executable's base name without its extension.
 */

/** Exact normalized keys. */
const DENIED_KEYS: ReadonlySet<string> = new Set([
  "1password",
  "bitwarden",
  "dashlane",
  "lastpass",
  "keychainaccess",
  "keychainaccessapp",
  "passwords",
  "systemsettings",
  "systempreferences",
  "securityagent",
  "usernotificationcenter",
  "loginwindow",
  "credentialmanager",
  "windowscredentialmanager",
  "credentialuibroker",
  "consent",
  "logonui",
  "seahorse",
  "ksecretd",
  "secrettool",
  // The 1Password CLI, which shows its own unlock prompt.
  "op",
  // Git Credential Manager's sign-in helpers.
  "githubui",
  "atlassianbitbucketui",
]);

/**
 * Normalized key prefixes: every KeePass variant, keyring and wallet daemons,
 * polkit agents, PIN entry prompts and Git Credential Manager.
 */
const DENIED_PREFIXES = ["keepass", "gnomekeyring", "polkit", "1password", "pinentry", "kwallet", "gitcredentialmanager"] as const;

/**
 * Normalized keys that deny when they appear anywhere in the key, such as
 * every `SSH_ASKPASS` and `SUDO_ASKPASS` helper (`ssh-askpass`,
 * `ksshaskpass`, `x11-ssh-askpass`, `lxqt-openssh-askpass`, `gnome-ssh-askpass`).
 */
const DENIED_FRAGMENTS = ["polkitagent", "polkitgnome", "polkitkde", "polkitmate", "authenticationagent", "askpass"] as const;

/** Bundle ids (lowercase) whose prefix is denied. */
const DENIED_BUNDLE_PREFIXES = [
  "com.1password.",
  "com.agilebits.",
  "com.bitwarden.",
  "com.lastpass.",
  "com.dashlane.",
  "org.keepassxc.",
  "com.apple.keychainaccess",
  "com.apple.passwords",
  "com.apple.systempreferences",
  "com.apple.systemsettings",
  "com.apple.securityagent",
  "com.apple.usernotificationcenter",
  "com.apple.loginwindow",
] as const;

const MAX_INPUT_CHARS = 1_024;

export interface AppControlTargetDescriptor {
  appName?: string | null;
  bundleId?: string | null;
  executablePath?: string | null;
  pid?: number | null;
}

function normalizedKey(value: string): string {
  return value.slice(0, MAX_INPUT_CHARS).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function deniedKey(key: string): boolean {
  if (!key) return false;
  return DENIED_KEYS.has(key)
    || DENIED_PREFIXES.some((prefix) => key.startsWith(prefix))
    || DENIED_FRAGMENTS.some((fragment) => key.includes(fragment));
}

/** The executable's base name without directories or a Windows or macOS extension. */
export function appControlExecutableName(path: string): string {
  const base = path.slice(0, MAX_INPUT_CHARS).split(/[\\/]/u).filter(Boolean).at(-1) ?? "";
  return base.replace(/\.(?:exe|app|bin|appimage)$/iu, "");
}

/** True when an application name, bundle id or executable path names a denied app. */
export function appControlNameDenied(target: Omit<AppControlTargetDescriptor, "pid">): boolean {
  if (typeof target.appName === "string" && deniedKey(normalizedKey(target.appName))) return true;
  if (typeof target.bundleId === "string" && target.bundleId) {
    const bundle = target.bundleId.slice(0, MAX_INPUT_CHARS).toLowerCase();
    if (DENIED_BUNDLE_PREFIXES.some((prefix) => bundle === prefix.replace(/\.$/u, "") || bundle.startsWith(prefix))) return true;
    if (bundle.split(".").some((part) => DENIED_KEYS.has(normalizedKey(part)) && part.length > 3)) return true;
  }
  if (typeof target.executablePath === "string" && target.executablePath) {
    if (deniedKey(normalizedKey(appControlExecutableName(target.executablePath)))) return true;
  }
  return false;
}

/**
 * True when App control must refuse this target: a denied pid (Inertia's own
 * process tree, or a process the caller already classified) or a denied name.
 */
export function appControlTargetDenied(
  target: AppControlTargetDescriptor,
  deniedPids: ReadonlySet<number> = new Set(),
): boolean {
  if (typeof target.pid === "number" && deniedPids.has(target.pid)) return true;
  return appControlNameDenied(target);
}
