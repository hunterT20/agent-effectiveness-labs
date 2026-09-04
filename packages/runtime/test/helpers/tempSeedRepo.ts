import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempSeedRepoOptions {
  readonly directory?: string;
  readonly files?: Readonly<Record<string, string | Buffer>>;
}

export interface TempSeedRepo {
  readonly repoPath: string;
  readonly commit: string;
}

const DEFAULT_FILES: Readonly<Record<string, string>> = {
  'README.md': 'seed\n',
  'src/answer.txt': 'pending\n',
};

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'AEL',
        GIT_AUTHOR_EMAIL: 'ael@example.com',
        GIT_COMMITTER_NAME: 'AEL',
        GIT_COMMITTER_EMAIL: 'ael@example.com',
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
    });
    child.on('error', (error: Error) => {
      reject(error);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(`git ${args.join(' ')} failed: ${Buffer.concat(stderr).toString('utf8')}`),
        );
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8').trim());
    });
  });
}

export async function createTempSeedRepo(
  options: TempSeedRepoOptions = {},
): Promise<TempSeedRepo> {
  const repoPath = options.directory ?? mkdtempSync(join(tmpdir(), 'ael-seed-'));
  mkdirSync(repoPath, { recursive: true });
  const files = options.files ?? DEFAULT_FILES;
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(repoPath, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
  await runGit(repoPath, ['init']);
  await runGit(repoPath, ['add', '.']);
  await runGit(repoPath, [
    '-c',
    'user.email=ael@example.com',
    '-c',
    'user.name=AEL',
    'commit',
    '-m',
    'seed',
  ]);
  const commit = await runGit(repoPath, ['rev-parse', 'HEAD']);
  return { repoPath, commit };
}

export async function runGitIn(cwd: string, args: readonly string[]): Promise<string> {
  return runGit(cwd, args);
}
