import { spawn } from 'node:child_process';

export interface GitRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function runGit(
  args: readonly string[],
  options: { cwd: string; env?: Readonly<Record<string, string>> },
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('close', (exitCode) => {
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
    child.on('error', () => {
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: 'git spawn failed',
      });
    });
  });
}

export interface CloneRepositoryInput {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly commit: string;
}

export async function cloneDetachedRepository(input: CloneRepositoryInput): Promise<void> {
  const clone = await runGit(['clone', '--no-hardlinks', input.sourcePath, input.targetPath], {
    cwd: process.cwd(),
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
    },
  });
  if (clone.exitCode !== 0) {
    throw new Error(`git clone failed: ${clone.stderr}`);
  }

  const checkout = await runGit(['checkout', '--detach', input.commit], {
    cwd: input.targetPath,
    env: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/dev/null',
    },
  });
  if (checkout.exitCode !== 0) {
    throw new Error(`git checkout failed: ${checkout.stderr}`);
  }
}

export async function gitDiffBinary(workspaceRoot: string): Promise<string> {
  const result = await runGit(['diff', '--binary', 'HEAD'], { cwd: workspaceRoot });
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`git diff failed: ${result.stderr}`);
  }
  return result.stdout;
}

export async function gitResetClean(workspaceRoot: string): Promise<void> {
  const reset = await runGit(['reset', '--hard', 'HEAD'], { cwd: workspaceRoot });
  if (reset.exitCode !== 0) {
    throw new Error(`git reset failed: ${reset.stderr}`);
  }
  const clean = await runGit(['clean', '-fdx'], { cwd: workspaceRoot });
  if (clean.exitCode !== 0) {
    throw new Error(`git clean failed: ${clean.stderr}`);
  }
}
