import { statSync } from "node:fs";

import { expect } from "vitest";

export function expectSameExistingPath(actual: string, expected: string): void {
  const actualIdentity = statSync(actual, { bigint: true });
  const expectedIdentity = statSync(expected, { bigint: true });
  expect(actualIdentity.isDirectory()).toBe(true);
  expect(expectedIdentity.isDirectory()).toBe(true);
  expect({ device: actualIdentity.dev, inode: actualIdentity.ino }).toEqual({
    device: expectedIdentity.dev,
    inode: expectedIdentity.ino,
  });
}
