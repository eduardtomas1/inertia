import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";

const LEGAL_RESOURCES = [
  {
    path: "THIRD_PARTY_NOTICES.txt", maximumBytes: 16 * 1024 * 1024,
    markers: [/INERTIA THIRD-PARTY NOTICES/u, /\bPACKAGES\b/u,
      /VENDORED COMPONENT LICENSE AND NOTICE TEXTS/u, /PACKAGE LICENSE AND NOTICE TEXTS/u],
  },
  {
    path: "LICENSE.txt", maximumBytes: 64 * 1024,
    markers: [/Apache\s+License/u, /Version\s+2\.0,\s+January\s+2004/u,
      /END OF TERMS AND CONDITIONS/u],
  },
  {
    path: "electron/LICENSE.txt", maximumBytes: 64 * 1024,
    markers: [/Copyright[^\r\n]*Electron contributors/u,
      /Permission is hereby granted, free of charge/u, /THE SOFTWARE IS PROVIDED "AS IS"/u],
  },
  {
    path: "electron/LICENSES.chromium.html", maximumBytes: 64 * 1024 * 1024,
    markers: [/<html\b/iu, /<title>\s*Credits\s*<\/title>/iu,
      /class=["']license["']/u, /<pre>\s*Copyright/iu],
  },
];

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function directDirectory(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("The packaged legal resources require direct directories.");
  }
  return metadata;
}

async function readLegalResource(directory, resource) {
  const path = join(directory, resource.path);
  let handle;
  try {
    const parent = await directDirectory(dirname(path));
    const initial = await lstat(path);
    if (initial.isSymbolicLink() || !initial.isFile()
      || initial.size <= 0 || initial.size > resource.maximumBytes) throw new Error();
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(initial, opened)) throw new Error();
    // A checked size followed by readFile would permit an unbounded growing file.
    // Read at most the observed size plus one byte and reject any replacement.
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== opened.size || !sameFile(opened, await handle.stat())
      || !sameFile(opened, await lstat(path))
      || !sameFile(parent, await directDirectory(dirname(path)))) throw new Error();
    const bytes = buffer.subarray(0, length);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0") || resource.markers.some((marker) => !marker.test(text))) throw new Error();
    return { path: resource.path, bytes: length, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch {
    throw new Error(`The packaged legal resource ${resource.path} is missing or invalid.`);
  } finally {
    await handle?.close();
  }
}

// This also runs against historical installed builds and extracted containers.
// Current-checkout source or node_modules bytes are not those artifacts' authority.
// Validate each artifact's actual files; hashes are evidence, not source attestation.
export async function verifyPackagedLegalResources(resourcesDirectory) {
  const initial = await directDirectory(resourcesDirectory);
  const evidence = [];
  for (const resource of LEGAL_RESOURCES) {
    evidence.push(await readLegalResource(resourcesDirectory, resource));
  }
  if (!sameFile(initial, await directDirectory(resourcesDirectory))) {
    throw new Error("The packaged legal resources directory changed during verification.");
  }
  return evidence;
}
