import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git') {
        continue;
      }
      files.push(...(await walkFiles(root, fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(relative(root, fullPath));
    }
  }
  return files.sort();
}

export async function computeTreeFingerprint(workspaceRoot: string): Promise<string> {
  const files = await walkFiles(workspaceRoot);
  const hash = createHash('sha256');
  for (const filePath of files) {
    const fullPath = join(workspaceRoot, filePath);
    const fileStat = await stat(fullPath);
    const content = await readFile(fullPath);
    hash.update(filePath);
    hash.update('\0');
    hash.update(String(fileStat.mode));
    hash.update('\0');
    hash.update(content);
    hash.update('\0');
  }
  return hash.digest('hex');
}
