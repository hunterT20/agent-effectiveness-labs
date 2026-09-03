#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Command } from 'commander';

import {
  doctorCommand,
  planCommand,
  reportCommand,
  resumeCommand,
  runCommand,
  statusCommand,
  validateArmCommand,
  validateFixtureCommand,
  validateSuiteCommand,
} from './commands/index.js';

export const PACKAGE_NAME = '@ael/cli' as const;

function readPackageVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version: string };
  return packageJson.version;
}

const context = {
  stdout: (message: string) => process.stdout.write(message),
  stderr: (message: string) => process.stderr.write(message),
};

export function createProgram(): Command {
  const program = new Command();

  program.name('ael').description('Agent Effectiveness Labs').version(readPackageVersion());

  const suiteCmd = program.command('suite');
  suiteCmd
    .command('validate')
    .argument('<suite.yaml>')
    .action((suitePath: string) => {
      process.exitCode = validateSuiteCommand(suitePath, context);
    });

  const fixtureCmd = program.command('fixture');
  fixtureCmd
    .command('validate')
    .argument('<fixture.yaml>')
    .action((fixturePath: string) => {
      process.exitCode = validateFixtureCommand(fixturePath, context);
    });

  const armCmd = program.command('arm');
  armCmd
    .command('validate')
    .argument('<arm.yaml>')
    .action((armPath: string) => {
      process.exitCode = validateArmCommand(armPath, context);
    });

  program
    .command('doctor')
    .requiredOption('--suite <suite.yaml>')
    .action(async (options: { suite: string }) => {
      process.exitCode = await doctorCommand(options.suite, context);
    });

  program
    .command('plan')
    .requiredOption('--suite <suite.yaml>')
    .requiredOption('--output <root>')
    .option('--json')
    .action((options: { suite: string; output: string; json?: boolean }) => {
      process.exitCode = planCommand(options.suite, options.output, context, options.json === true);
    });

  program
    .command('run')
    .requiredOption('--suite <suite.yaml>')
    .requiredOption('--output <root>')
    .option('--fake-agent <path>')
    .action(async (options: { suite: string; output: string; fakeAgent?: string }) => {
      const fakeAgent =
        options.fakeAgent ??
        join(dirname(fileURLToPath(import.meta.url)), '../../../tests/fake-agent/fake-agent.mjs');
      process.exitCode = await runCommand(options.suite, options.output, fakeAgent, context);
    });

  program
    .command('resume')
    .argument('<experiment-root>')
    .requiredOption('--suite <suite.yaml>')
    .option('--fake-agent <path>')
    .action(async (experimentRoot: string, options: { suite: string; fakeAgent?: string }) => {
      const fakeAgent =
        options.fakeAgent ??
        join(dirname(fileURLToPath(import.meta.url)), '../../../tests/fake-agent/fake-agent.mjs');
      process.exitCode = await resumeCommand(options.suite, experimentRoot, fakeAgent, context);
    });

  program
    .command('status')
    .argument('<experiment-root>')
    .action((experimentRoot: string) => {
      process.exitCode = statusCommand(experimentRoot, context);
    });

  program
    .command('report')
    .argument('<experiment-root>')
    .requiredOption('--suite <suite.yaml>')
    .option('--fail-on-verdict')
    .action((experimentRoot: string, options: { suite: string; failOnVerdict?: boolean }) => {
      process.exitCode = reportCommand(
        experimentRoot,
        options.suite,
        context,
        options.failOnVerdict === true,
      );
    });

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
