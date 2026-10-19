import { describe, expect, it } from "vitest";

import {
  appControlExecutableName,
  appControlNameDenied,
  appControlTargetDenied,
} from "../../src/shared/app-control-denylist";

describe("App control denylist", () => {
  it.each([
    "1Password", "1Password 8", "Bitwarden", "Dashlane", "LastPass", "KeePass", "KeePassXC", "KeePassX", "Keychain Access",
    "Passwords", "System Settings", "System Preferences", "SecurityAgent", "UserNotificationCenter", "loginwindow",
    "Windows Credential Manager", "CredentialUIBroker", "consent", "gnome-keyring-daemon", "Seahorse",
    "polkit-gnome-authentication-agent-1", "polkit-kde-authentication-agent-1", "ＫｅｅＰａｓｓ",
    "ssh-askpass", "ksshaskpass", "x11-ssh-askpass", "lxqt-openssh-askpass", "gnome-ssh-askpass", "Git Credential Manager",
    "pinentry-qt", "KWalletManager", "kwalletd6", "ksecretd", "gnome-keyring", "secret-tool", "op", "LogonUI",
  ])("denies the app named %s", (appName) => {
    expect(appControlNameDenied({ appName })).toBe(true);
  });

  it.each([
    "com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop", "com.lastpass.lastpassmacdesktop",
    "com.dashlane.dashlanephonefinal", "org.keepassxc.keepassxc", "com.apple.keychainaccess", "com.apple.Passwords",
    "com.apple.systempreferences", "com.apple.SecurityAgent", "com.apple.UserNotificationCenter", "com.apple.loginwindow",
  ])("denies the bundle id %s", (bundleId) => {
    expect(appControlNameDenied({ appName: "Renamed", bundleId })).toBe(true);
  });

  it.each([
    "C:\\Windows\\System32\\consent.exe",
    "C:\\Windows\\System32\\CredentialUIBroker.exe",
    "/usr/bin/gnome-keyring-daemon",
    "/usr/lib/policykit-1-gnome/polkit-gnome-authentication-agent-1",
    "/usr/bin/seahorse",
    "/Applications/1Password.app",
    "/usr/bin/keepassxc",
    "/usr/lib/ssh/ssh-askpass",
    "/usr/bin/ksshaskpass",
    "/usr/lib/ssh/x11-ssh-askpass",
    "/usr/bin/lxqt-openssh-askpass",
    "/usr/libexec/openssh/gnome-ssh-askpass",
    "/usr/local/bin/git-credential-manager",
    "C:\\Program Files\\Git\\mingw64\\bin\\git-credential-manager.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\GitHub.UI.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\Atlassian.Bitbucket.UI.exe",
    "/usr/bin/pinentry",
    "/usr/bin/pinentry-gnome3",
    "/opt/homebrew/bin/pinentry-mac",
    "/usr/bin/kwalletmanager5",
    "/usr/bin/kwalletd5",
    "/usr/bin/ksecretd",
    "/usr/bin/gnome-keyring",
    "/usr/bin/secret-tool",
    "/usr/local/bin/op",
    "C:\\Windows\\System32\\LogonUI.exe",
  ])("denies the executable %s", (executablePath) => {
    expect(appControlNameDenied({ executablePath })).toBe(true);
  });

  it.each([
    ["My App", "com.example.myapp", "/home/dev/project/out/my-app"],
    ["Notes", "com.example.notes", "C:\\Users\\dev\\project\\notes.exe"],
    ["Password Strength Demo", null, "/home/dev/password-strength-demo"],
    ["Settings demo", "dev.example.settings", "/opt/demo/settings"],
    ["Operator", "dev.example.operator", "/opt/demo/operator"],
    ["Git client", "dev.example.git", "/usr/bin/git"],
    ["", null, null],
  ])("allows the app under test %s", (appName, bundleId, executablePath) => {
    expect(appControlNameDenied({ appName, bundleId, executablePath })).toBe(false);
  });

  it("always denies Inertia's own process tree by pid", () => {
    expect(appControlTargetDenied({ appName: "My App", pid: 42 }, new Set([42]))).toBe(true);
    expect(appControlTargetDenied({ appName: "My App", pid: 43 }, new Set([42]))).toBe(false);
    expect(appControlTargetDenied({ appName: "Bitwarden", pid: 43 }, new Set())).toBe(true);
  });

  it("reads the executable's base name without its extension", () => {
    expect(appControlExecutableName("C:\\Program Files\\App\\App.exe")).toBe("App");
    expect(appControlExecutableName("/Applications/Thing.app/")).toBe("Thing");
    expect(appControlExecutableName("/usr/bin/tool")).toBe("tool");
  });
});
