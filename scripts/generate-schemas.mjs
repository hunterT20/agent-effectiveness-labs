#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const schemasDir = join(repoRoot, 'schemas');
const coreDistSchemas = join(repoRoot, 'packages/core/dist/config/schemas.js');
const checkMode = process.argv.includes('--check');

function buildCorePackage() {
  const result = spawnSync('pnpm', ['--filter', '@ael/core', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: false,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function loadSchemaModule() {
  if (!existsSync(coreDistSchemas)) {
    buildCorePackage();
  }

  return import(pathToFileURL(coreDistSchemas).href);
}

async function main() {
  const schemaModule = await loadSchemaModule();

  if (checkMode) {
    const expected = {};
    for (const name of Object.keys(schemaModule.JSON_SCHEMA_REGISTRY)) {
      expected[name] = schemaModule.readGeneratedSchema(name, schemasDir);
    }

    schemaModule.generateJsonSchemas(schemasDir);

    for (const [name, previousContent] of Object.entries(expected)) {
      const nextContent = schemaModule.readGeneratedSchema(name, schemasDir);
      if (sha256(previousContent) !== sha256(nextContent)) {
        console.error(`Schema drift detected for ${name}.schema.json`);
        process.exit(1);
      }
    }

    console.log('All checked-in JSON schemas are up to date.');
    return;
  }

  const outputs = schemaModule.generateJsonSchemas(schemasDir);
  for (const [name, outputPath] of Object.entries(outputs)) {
    console.log(`Wrote ${outputPath} (${name})`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
