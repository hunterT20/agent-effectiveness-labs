import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '../packages/runtime');
const destDir = join(packageRoot, 'dist/isolation');
mkdirSync(destDir, { recursive: true });
copyFileSync(
  join(packageRoot, 'src/isolation/dockerProbe.mjs'),
  join(destDir, 'dockerProbe.mjs'),
);
