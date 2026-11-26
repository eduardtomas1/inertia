import { describe, expect, it } from "vitest";

import { agentSecretDataPath } from "../../src/main/agent-secret-data-path";

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

  it("canonicalizes junctions and symlinks so targets outside userDataPath cannot bypass containment", () => {
    const junction = `${userDataPath}\\runtime`;
    const outsideTarget = "D:\\shared\\inertia";
    const enoent = () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return error;
    };

    const realpath = (path: string): string => {
      const lower = path.toLowerCase();
      if (lower === userDataPath.toLowerCase()) return userDataPath;
      if (lower === junction.toLowerCase()) return outsideTarget;
      throw enoent();
    };

    const movedDirect = agentSecretDataPath({
      platform: "win32",
      dataDirectory: junction,
      userDataPath,
      realpath,
    });
    expect(movedDirect).toMatch(/^C:\\Users\\ana\\AppData\\Roaming\\Inertia\\private\\[0-9a-f]{16}$/u);
    expect(movedDirect).toBe(agentSecretDataPath({
      platform: "win32",
      dataDirectory: outsideTarget,
      userDataPath,
      realpath,
    }));

    // Non-existent nested leaf under a junction resolves the deepest existing ancestor.
    const movedNested = agentSecretDataPath({
      platform: "win32",
      dataDirectory: `${junction}\\nested\\leaf`,
      userDataPath,
      realpath,
    });
    expect(movedNested).toMatch(/^C:\\Users\\ana\\AppData\\Roaming\\Inertia\\private\\[0-9a-f]{16}$/u);
    expect(movedNested).not.toBe(movedDirect);
  });

  it("allows canonicalized paths inside userDataPath including extended-length prefixes and fails closed on access errors", () => {
    const inside = `${userDataPath}\\runtime\\leaf`;
    const enoent = () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      return error;
    };
    const eacces = () => {
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      return error;
    };

    expect(agentSecretDataPath({
      platform: "win32",
      dataDirectory: inside,
      userDataPath,
      realpath: (path) => {
        if (path.toLowerCase() === userDataPath.toLowerCase()) return `\\\\?\\${userDataPath}`;
        if (path.toLowerCase() === `${userDataPath}\\runtime`.toLowerCase()) return `\\\\?\\${userDataPath}\\real-runtime`;
        throw enoent();
      },
    })).toBe(inside);

    expect(agentSecretDataPath({
      platform: "win32",
      dataDirectory: `${userDataPath}\\blocked`,
      userDataPath,
      realpath: (path) => {
        if (path.toLowerCase() === userDataPath.toLowerCase()) return userDataPath;
        throw eacces();
      },
    })).toMatch(/^C:\\Users\\ana\\AppData\\Roaming\\Inertia\\private\\[0-9a-f]{16}$/u);
  });
});
