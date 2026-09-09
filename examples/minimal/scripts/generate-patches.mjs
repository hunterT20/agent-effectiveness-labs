#!/usr/bin/env node
/**
 * Generate solution/wrong patches for the three minimal fixtures from the seed tree.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const seedRepo = join(root, 'seed-repo');

const FIXED_DATE = '2026-01-01T00:00:00Z';
const GIT_CONFIG = [
  '-c',
  'user.name=AEL',
  '-c',
  'user.email=ael@example.com',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.filemode=false',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
];

function runGit(cwd, args) {
  const env = { ...process.env, GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
    delete env[key];
  }
  const result = spawnSync('git', [...GIT_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
    env,
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

function cloneSeed() {
  const dir = mkdtempSync(join(tmpdir(), 'ael-min-patch-'));
  const files = [
    'README.md',
    '.gitignore',
    'package.json',
    'src/discount.mjs',
    'src/temperature.mjs',
    'src/validate.mjs',
    'tests/validate.test.mjs',
  ];
  for (const file of files) {
    const contents = readFileSync(join(seedRepo, file));
    const dest = join(dir, file);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents);
  }
  runGit(dir, ['init', '--quiet']);
  runGit(dir, ['add', '--all']);
  runGit(dir, ['commit', '--quiet', '--no-verify', '--message', 'seed']);
  return dir;
}

function diffEdits(edits) {
  const dir = cloneSeed();
  try {
    for (const [relativePath, contents] of Object.entries(edits)) {
      const dest = join(dir, relativePath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, contents);
    }
    runGit(dir, ['add', '--all']);
    return runGit(dir, ['diff', '--cached', '--binary']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writePatch(fixtureId, name, contents) {
  const path = join(root, 'fixtures', fixtureId, 'reference', name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents.endsWith('\n') ? contents : `${contents}\n`);
}

const discount = readFileSync(join(seedRepo, 'src/discount.mjs'), 'utf8');
const temperature = readFileSync(join(seedRepo, 'src/temperature.mjs'), 'utf8');
const validate = readFileSync(join(seedRepo, 'src/validate.mjs'), 'utf8');
const validateTest = readFileSync(join(seedRepo, 'tests/validate.test.mjs'), 'utf8');

writePatch(
  'fix-a',
  'solution.patch',
  diffEdits({
    'src/discount.mjs': discount.replace('return price - percent;', 'return price * (1 - percent / 100);'),
  }),
);
writePatch(
  'fix-a',
  'wrong.patch',
  diffEdits({
    'src/discount.mjs': discount.replace('return price - percent;', 'return price * (1 - percent);'),
  }),
);

writePatch(
  'fix-b',
  'solution.patch',
  diffEdits({
    'src/temperature.mjs': temperature.replace(
      'return (celsius * 9) / 5 - FREEZING_POINT_F;',
      'return (celsius * 9) / 5 + FREEZING_POINT_F;',
    ),
  }),
);
writePatch(
  'fix-b',
  'wrong.patch',
  diffEdits({
    'src/temperature.mjs': temperature
      .replace('return (celsius * 9) / 5 - FREEZING_POINT_F;', 'return (celsius * 9) / 5 + FREEZING_POINT_F;')
      .replace(
        'return ((fahrenheit - FREEZING_POINT_F) * 5) / 9;',
        'return (fahrenheit * 5) / 9;',
      ),
  }),
);

const fixedValidate = validate.replace(
  'return local.length > 0 && domain.length > 0;',
  "return local.length > 0 && domain.length > 0 && domain.includes('.');",
);
const fixedTest = validateTest.replace(
  '// TODO: add a regression test for domains without a dot (e.g. "user@example").\n',
  `test('rejects a domain without a dot', () => {
  assert.equal(isValidEmail('user@example'), false);
});
`,
);

writePatch(
  'fix-c',
  'solution.patch',
  diffEdits({
    'src/validate.mjs': fixedValidate,
    'tests/validate.test.mjs': fixedTest,
  }),
);
writePatch(
  'fix-c',
  'wrong.patch',
  diffEdits({
    'src/validate.mjs': fixedValidate,
  }),
);

process.stdout.write('wrote examples/minimal fixture patches\n');
