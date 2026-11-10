import { describe, expect, it } from "vitest";

import { agentSecretDataPath } from "../../src/main/runtime-bootstrap-safety";

const userDataPath = "C:\\Users\\ana\\AppData\\Roaming\\Inertia";

describe("agent secret data path", () => {
  it.each(["linux", "darwin"] as const)("keeps secrets in the data directory on %s", (platform) => {
    expect(agentSecretDataPath({ platform, dataDirectory: "/srv/shared/inertia", userDataPath: "/home/ana/.config/Inertia" }))
      .toBe("/srv/shared/inertia");
  });

  it("keeps secrets in the default Windows data directory inside the profile", () => {
    const dataDirectory = `${userDataPath}\\runtime`;
    expect(agentSecretDataPath({ platform: "win32", dataDirectory, userDataPath })).toBe(dataDirectory);
    expect(agentSecretDataPath({ platform: "win32", dataDirectory: userDataPath, userDataPath })).toBe(userDataPath);
  });

  it("moves secrets into the profile when a Windows data directory lives elsewhere", () => {
    const moved = agentSecretDataPath({ platform: "win32", dataDirectory: "D:\\shared\\inertia", userDataPath });
    expect(moved).toMatch(/^C:\\Users\\ana\\AppData\\Roaming\\Inertia\\private\\[0-9a-f]{16}$/u);
    expect(agentSecretDataPath({ platform: "win32", dataDirectory: "d:\\Shared\\Inertia", userDataPath })).toBe(moved);
    expect(agentSecretDataPath({ platform: "win32", dataDirectory: "D:\\shared\\other", userDataPath })).not.toBe(moved);
    expect(agentSecretDataPath({ platform: "win32", dataDirectory: `${userDataPath}-copy`, userDataPath }))
      .toMatch(/\\private\\[0-9a-f]{16}$/u);
  });
});
