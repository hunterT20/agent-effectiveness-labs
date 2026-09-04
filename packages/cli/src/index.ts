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
  fixtureSelfTestCommand,
} from './commands/index.js';
import { gradeExportCommand, gradeImportCommand } from './commands/grade.js';

export const PACKAGE_NAME = '@ael/cli' as const;

function readPackageVersion(): string {
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const raw: unknown = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  if (typeof raw !== 'object' || raw === null || !('version' in raw)) {
    throw new Error(`invalid package.json at ${packageJsonPath}`);
  }
  const version = raw.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error(`package.json missing version at ${packageJsonPath}`);
  }
  return version;
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
  fixtureCmd
    .command('self-test')
    .argument('<fixture.yaml>')
    .action(async (fixturePath: string) => {
      process.exitCode = await fixtureSelfTestCommand(fixturePath, context);
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
    .option('--out <directory>')
    .action(async (options: { suite: string; out?: string }) => {
      process.exitCode = await doctorCommand(
        options.suite,
        context,
        options.out !== undefined ? { out: options.out } : {},
      );
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
    .option('--approve-live-run')
    .action(
      async (options: {
        suite: string;
        output: string;
        fakeAgent?: string;
        approveLiveRun?: boolean;
      }) => {
        const fakeAgent =
          options.fakeAgent ??
          join(dirname(fileURLToPath(import.meta.url)), '../../../tests/fake-agent/fake-agent.mjs');
        process.exitCode = await runCommand(
          options.suite,
          options.output,
          fakeAgent,
          context,
          options.approveLiveRun === true ? { approveLiveRun: true } : {},
        );
      },
    );

  program
    .command('resume')
    .argument('<experiment-root>')
    .requiredOption('--suite <suite.yaml>')
    .option('--fake-agent <path>')
    .option('--approve-live-run')
    .action(
      async (
        experimentRoot: string,
        options: { suite: string; fakeAgent?: string; approveLiveRun?: boolean },
      ) => {
        const fakeAgent =
          options.fakeAgent ??
          join(dirname(fileURLToPath(import.meta.url)), '../../../tests/fake-agent/fake-agent.mjs');
        process.exitCode = await resumeCommand(
          options.suite,
          experimentRoot,
          fakeAgent,
          context,
          options.approveLiveRun === true ? { approveLiveRun: true } : {},
        );
      },
    );

  program
    .command('status')
    .argument('<experiment-root>')
    .option('--json')
    .action((experimentRoot: string, options: { json?: boolean }) => {
      process.exitCode = statusCommand(experimentRoot, context, options.json === true);
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

  const gradeCmd = program.command('grade');
  gradeCmd
    .command('export')
    .argument('<experiment-root>')
    .requiredOption('--out <directory>')
    .option('--seed <seed>')
    .action(async (experimentRoot: string, options: { out: string; seed?: string }) => {
      process.exitCode = await gradeExportCommand(
        experimentRoot,
        options.out,
        context,
        options.seed,
      );
    });
  gradeCmd
    .command('import')
    .argument('<experiment-root>')
    .requiredOption('--ratings <ratings.json>')
    .requiredOption('--rater-ids <ids>')
    .option('--minimum-agreement <rate>')
    .action(
      async (
        experimentRoot: string,
        options: { ratings: string; raterIds: string; minimumAgreement?: string },
      ) => {
        process.exitCode = await gradeImportCommand(experimentRoot, options.ratings, context, {
          raterIds: options.raterIds,
          ...(options.minimumAgreement !== undefined
            ? { minimumAgreement: Number(options.minimumAgreement) }
            : {}),
        });
      },
    );

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
