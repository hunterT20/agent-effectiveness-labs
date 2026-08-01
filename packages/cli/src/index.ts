#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Command } from 'commander';

export const PACKAGE_NAME = '@ael/cli' as const;

function readPackageVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
  return packageJson.version;
}

export function createProgram(): Command {
  const program = new Command();

  program.name('ael').description('Agent Effectiveness Labs').version(readPackageVersion());

  return program;
}

export function run(argv: readonly string[] = process.argv): void {
  createProgram().parse(argv);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }

  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  run();
}
