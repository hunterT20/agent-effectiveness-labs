import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Map of workspace-relative POSIX path to `mode:sha256(content)`. `.git` is skipped. */
export type TreeManifest = ReadonlyMap<string, string>;

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

async function hashEntry(fullPath: string): Promise<string | null> {
  const entryStat = await lstat(fullPath);
  const hash = createHash('sha256');
  if (entryStat.isSymbolicLink()) {
    hash.update('symlink\0');
    hash.update(await readlink(fullPath));
  } else if (entryStat.isFile()) {
    hash.update(await readFile(fullPath));
  } else {
    return null;
  }
  return `${String(entryStat.mode)}:${hash.digest('hex')}`;
}

async function walk(root: string, current: string, output: Map<string, string>): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') {
        continue;
      }
      await walk(root, fullPath, output);
      continue;
    }
    const digest = await hashEntry(fullPath);
    if (digest !== null) {
      output.set(toPosix(relative(root, fullPath)), digest);
    }
  }
}

export async function collectTreeManifest(root: string): Promise<TreeManifest> {
  const output = new Map<string, string>();
  await walk(root, root, output);
  return output;
}

export interface TreeManifestDiff {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly removed: readonly string[];
}

export function diffTreeManifests(before: TreeManifest, after: TreeManifest): TreeManifestDiff {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [path, digest] of after) {
    const previous = before.get(path);
    if (previous === undefined) {
      added.push(path);
    } else if (previous !== digest) {
      modified.push(path);
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path)) {
      removed.push(path);
    }
  }
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() };
}

/**
 * Fingerprint of a fixed list of workspace-relative paths. Missing paths are recorded as such so
 * deletion is detected. Used for overlay integrity: only arm-owned files are compared.
 */
export async function computePathSetFingerprint(
  root: string,
  paths: readonly string[],
): Promise<string> {
  const hash = createHash('sha256');
  for (const path of [...new Set(paths)].sort()) {
    hash.update(path);
    hash.update('\0');
    let digest: string | null;
    try {
      digest = await hashEntry(join(root, path));
    } catch {
      digest = null;
    }
    hash.update(digest ?? 'missing');
    hash.update('\0');
  }
  return hash.digest('hex');
}
