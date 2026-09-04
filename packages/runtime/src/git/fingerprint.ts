import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * One entry of the tree manifest that is hashed by {@link computeTreeFingerprint}.
 *
 * - `file`: regular file; `content` is the raw file bytes.
 * - `symlink`: symbolic link; `target` is the literal link text (not resolved), so a link pointing
 *   at a different target changes the fingerprint even if both targets have identical content.
 *
 * Empty directories, sockets, FIFOs and devices are not part of the manifest (git ignores them
 * too). The `.git` directory is skipped.
 */
export type TreeManifestEntry =
  | { readonly kind: 'file'; readonly path: string; readonly mode: number }
  | {
      readonly kind: 'symlink';
      readonly path: string;
      readonly mode: number;
      readonly target: string;
    };

function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function walkTree(root: string, current: string, out: TreeManifestEntry[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') {
        continue;
      }
      await walkTree(root, fullPath, out);
      continue;
    }
    const path = toPosixPath(relative(root, fullPath));
    if (entry.isSymbolicLink()) {
      const [stats, target] = await Promise.all([lstat(fullPath), readlink(fullPath)]);
      out.push({ kind: 'symlink', path, mode: stats.mode, target });
      continue;
    }
    if (entry.isFile()) {
      const stats = await lstat(fullPath);
      out.push({ kind: 'file', path, mode: stats.mode });
    }
  }
}

/**
 * Manifest of the working tree, sorted by POSIX-style relative path (UTF-16 code-unit order,
 * which for ASCII paths equals byte order). Exposed for callers that want to diff two trees.
 */
export async function readTreeManifest(
  workspaceRoot: string,
): Promise<readonly TreeManifestEntry[]> {
  const entries: TreeManifestEntry[] = [];
  await walkTree(workspaceRoot, workspaceRoot, entries);
  return entries.sort((a, b) => compareCodeUnits(a.path, b.path));
}

/**
 * SHA-256 over the sorted tree manifest.
 *
 * Hash layout, per entry, with `\0` separators:
 *
 * - file:    `<path>\0<mode>\0<content>\0`
 * - symlink: `<path>\0symlink\0<mode>\0<target>\0`
 *
 * `mode` is the decimal `st_mode` from `lstat`, so executable-bit changes alter the fingerprint.
 * The file layout is byte-for-byte identical to earlier runtime versions, so fingerprints of trees
 * without symlinks are unchanged.
 */
export async function computeTreeFingerprint(workspaceRoot: string): Promise<string> {
  const manifest = await readTreeManifest(workspaceRoot);
  const hash = createHash('sha256');
  for (const entry of manifest) {
    hash.update(entry.path);
    hash.update('\0');
    if (entry.kind === 'symlink') {
      hash.update('symlink');
      hash.update('\0');
      hash.update(String(entry.mode));
      hash.update('\0');
      hash.update(entry.target);
      hash.update('\0');
      continue;
    }
    const content = await readFile(join(workspaceRoot, entry.path));
    hash.update(String(entry.mode));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}
