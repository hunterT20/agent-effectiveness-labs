import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';

import type {
  ArmAction,
  ArmDocument,
  ArmMaterialization,
  IsolationProvider,
  IsolationSession,
  SandboxedSetupCommandAction,
} from '@ael/core';
import { ArmMaterializationSchema, isInside } from '@ael/core';

import { buildAgentEnvironment } from '../process/env.js';
import { readAtomicJson, writeAtomicJson } from '../artifacts/atomicWrite.js';
import { runCommonPreparation } from '../workspace/commonPreparation.js';
import {
  collectTreeManifest,
  computePathSetFingerprint,
  diffTreeManifests,
} from '../workspace/treeManifest.js';

export interface MaterializeArmInput {
  readonly workspaceRoot: string;
  readonly trialId: string;
  readonly arm: ArmDocument;
  readonly suiteRoot: string;
  /** Destination of the full {@link ArmMaterialization} record (`arm-materialization.json`). */
  readonly overlayManifestPath: string;
  readonly isolation?: IsolationProvider;
  /** Existing isolation session to reuse for `sandboxed-setup-command`; not disposed here. */
  readonly isolationSession?: IsolationSession;
  /** Roots (absolute) in which setup commands may run. Defaults to the workspace root. */
  readonly declaredRoots?: readonly string[];
  /** Trial-private home directory root; required by `home-overlay`. Must be outside the workspace. */
  readonly isolatedHomeRoot?: string;
  /** Environment inherited by setup commands. Defaults to the current process environment. */
  readonly baseEnvironment?: Readonly<Record<string, string>>;
}

interface MaterializationState {
  readonly actionHashes: string[];
  readonly overlayPaths: string[];
  readonly homeOverlayPaths: string[];
  readonly environment: Record<string, string>;
  readonly argvAdditions: string[];
  readonly pluginDirs: string[];
  readonly setupLogs: string[];
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

function setupCommandEnvironment(
  baseEnvironment: Readonly<Record<string, string>> | undefined,
  armEnvironment: Readonly<Record<string, string>>,
): { readonly env: Record<string, string>; readonly secretValues: readonly string[] } {
  const built = buildAgentEnvironment({
    base: baseEnvironment ?? process.env,
    extra: armEnvironment,
    passthroughPrefixes: ['AEL_'],
  });
  return { env: built.env, secretValues: built.secretValues };
}

async function listFilesRecursive(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(root, fullPath)));
    } else if (entry.isFile()) {
      files.push(toPosix(relative(root, fullPath)));
    }
  }
  return files.sort();
}

/**
 * Copies an overlay source into `targetRoot`.
 *
 * - A directory source mirrors its contents onto `targetRoot` (the directory is the overlay root).
 * - A file source is placed at its suite-relative path under `targetRoot`.
 *
 * Returns the target-relative paths that were written.
 */
async function copyOverlaySource(
  sourcePath: string,
  suiteRoot: string,
  targetRoot: string,
): Promise<string[]> {
  const sourceStat = await stat(sourcePath);
  if (sourceStat.isDirectory()) {
    const files = await listFilesRecursive(sourcePath);
    for (const file of files) {
      const targetPath = join(targetRoot, file);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(join(sourcePath, file), targetPath);
    }
    return files;
  }
  const targetRelative = toPosix(relative(suiteRoot, sourcePath));
  const targetPath = join(targetRoot, targetRelative);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  return [targetRelative];
}

function resolveInsideSuite(suiteRoot: string, source: string, label: string): string {
  const resolved = resolve(suiteRoot, source);
  if (!isInside(resolved, suiteRoot)) {
    throw new Error(`${label} escapes suite root: ${source}`);
  }
  return resolved;
}

function isInDeclaredRoots(
  path: string,
  workspaceRoot: string,
  declaredRoots: readonly string[],
): boolean {
  return declaredRoots.some((root) => {
    const normalized = root.replace(/\*\*$/, '').replace(/\/$/, '');
    const resolved = resolve(workspaceRoot, normalized);
    return isInside(path, resolved);
  });
}

function isAllowedWrite(
  changedPath: string,
  workspaceRoot: string,
  allowedWritePaths: readonly string[],
): boolean {
  const absolute = resolve(workspaceRoot, changedPath);
  return allowedWritePaths.some((allowed) => {
    const normalized = allowed.replace(/\/?\*\*$/, '').replace(/\/+$/, '');
    const resolved = resolve(workspaceRoot, normalized === '' ? '.' : normalized);
    return isInside(absolute, resolved);
  });
}

async function runSandboxedSetup(
  action: SandboxedSetupCommandAction,
  input: MaterializeArmInput,
  state: MaterializationState,
): Promise<void> {
  if (input.isolation === undefined) {
    throw new Error('sandboxed-setup-command requires isolation provider');
  }
  const cwd =
    action.cwd !== undefined ? resolve(input.workspaceRoot, action.cwd) : input.workspaceRoot;
  const declaredRoots = input.declaredRoots ?? [input.workspaceRoot];
  if (!isInside(cwd, input.workspaceRoot)) {
    throw new Error(`setup cwd escapes workspace: ${action.cwd ?? '.'}`);
  }
  if (!isInDeclaredRoots(cwd, input.workspaceRoot, declaredRoots)) {
    throw new Error(`setup cwd not in declared roots: ${cwd}`);
  }
  const allowedWritePaths = action.allowedWritePaths ?? [
    toPosix(relative(input.workspaceRoot, cwd)) || '.',
  ];

  const before = await collectTreeManifest(input.workspaceRoot);

  const ownSession = input.isolationSession === undefined;
  const setupLogDir = join(dirname(input.overlayManifestPath), 'setup-logs');
  await mkdir(setupLogDir, { recursive: true });
  const session =
    input.isolationSession ??
    (await input.isolation.prepare({
      workspaceRoot: input.workspaceRoot,
      trialId: input.trialId,
      logDir: setupLogDir,
    }));
  const timeoutMs = action.timeoutMs ?? 60_000;
  const { env, secretValues } = setupCommandEnvironment(input.baseEnvironment, state.environment);
  let result: Awaited<ReturnType<IsolationProvider['run']>>;
  try {
    result = await input.isolation.run(session, {
      command: action.command,
      args: action.args,
      cwd,
      env,
      timeoutMs,
      ...(secretValues.length > 0 ? { redactLiterals: [...secretValues] } : {}),
    });
  } finally {
    if (ownSession) {
      await input.isolation.dispose(session);
    }
  }
  state.setupLogs.push(
    `setup ${action.command} exit=${String(result.exitCode)} signal=${String(result.signal)}`,
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `sandboxed setup failed with exit ${String(result.exitCode)} signal ${String(result.signal)}`,
    );
  }

  const after = await collectTreeManifest(input.workspaceRoot);
  const diff = diffTreeManifests(before, after);
  const mutated = [...diff.added, ...diff.modified, ...diff.removed];
  const undeclared = mutated.filter(
    (changedPath) => !isAllowedWrite(changedPath, input.workspaceRoot, allowedWritePaths),
  );
  state.setupLogs.push(
    `setup mutated added=${String(diff.added.length)} modified=${String(diff.modified.length)} removed=${String(diff.removed.length)}`,
  );
  if (undeclared.length > 0) {
    throw new Error(
      `sandboxed setup mutated undeclared paths: ${undeclared.slice(0, 20).join(', ')}`,
    );
  }
}

async function applyAction(
  action: ArmAction,
  input: MaterializeArmInput,
  state: MaterializationState,
): Promise<void> {
  switch (action.type) {
    case 'workspace-overlay': {
      const sourcePath = resolveInsideSuite(input.suiteRoot, action.source, 'workspace overlay');
      const written = await copyOverlaySource(sourcePath, input.suiteRoot, input.workspaceRoot);
      state.overlayPaths.push(...written);
      break;
    }
    case 'home-overlay': {
      const sourcePath = resolveInsideSuite(input.suiteRoot, action.source, 'home overlay');
      if (input.isolatedHomeRoot === undefined) {
        throw new Error('home-overlay requires isolatedHomeRoot');
      }
      if (isInside(input.isolatedHomeRoot, input.workspaceRoot)) {
        throw new Error('isolatedHomeRoot must live outside the agent workspace');
      }
      const homeDir = join(input.isolatedHomeRoot, 'home');
      await mkdir(homeDir, { recursive: true });
      const written = await copyOverlaySource(sourcePath, input.suiteRoot, homeDir);
      state.homeOverlayPaths.push(...written);
      break;
    }
    case 'environment': {
      for (const [key, value] of Object.entries(action.variables)) {
        state.environment[key] = value;
      }
      break;
    }
    case 'agent-argument': {
      state.argvAdditions.push(...action.args);
      break;
    }
    case 'plugin-directory': {
      const pluginPath = resolveInsideSuite(input.suiteRoot, action.path, 'plugin directory');
      const pluginStat = await stat(pluginPath);
      if (!pluginStat.isDirectory()) {
        throw new Error(`plugin directory is not a directory: ${action.path}`);
      }
      state.pluginDirs.push(pluginPath);
      break;
    }
    case 'sandboxed-setup-command': {
      await runSandboxedSetup(action, input, state);
      break;
    }
  }
  state.actionHashes.push(hashContent(JSON.stringify(action)));
}

export async function materializeArm(input: MaterializeArmInput): Promise<ArmMaterialization> {
  await runCommonPreparation({ workspaceRoot: input.workspaceRoot });

  const state: MaterializationState = {
    actionHashes: [],
    overlayPaths: [],
    homeOverlayPaths: [],
    environment: {},
    argvAdditions: [],
    pluginDirs: [],
    setupLogs: [],
  };

  for (const action of input.arm.actions) {
    await applyAction(action, input, state);
  }

  const overlayFingerprint = await computePathSetFingerprint(
    input.workspaceRoot,
    state.overlayPaths,
  );

  const materialization: ArmMaterialization = {
    schemaVersion: 1,
    armId: input.arm.id,
    actionHashes: state.actionHashes,
    overlayPaths: [...new Set(state.overlayPaths)].sort(),
    overlayFingerprint,
    homeOverlayPaths: [...new Set(state.homeOverlayPaths)].sort(),
    environment: state.environment,
    environmentKeys: Object.keys(state.environment).sort(),
    argvAdditions: state.argvAdditions,
    pluginDirs: state.pluginDirs,
    adapterVersion: null,
    setupLogs: state.setupLogs,
  };
  await writeAtomicJson(input.overlayManifestPath, materialization);
  return materialization;
}

export async function readArmMaterialization(manifestPath: string): Promise<ArmMaterialization> {
  return readAtomicJson(manifestPath, ArmMaterializationSchema);
}

const OverlayManifestSchema = z
  .object({
    overlayPaths: z.array(z.string()),
    fingerprint: z.string().optional(),
    overlayFingerprint: z.string().optional(),
  })
  .passthrough();

/**
 * Reads the overlay portion of an arm materialization record. Accepts both the full
 * {@link ArmMaterialization} document and the legacy `{ overlayPaths, fingerprint }` shape.
 */
export async function readOverlayManifest(
  manifestPath: string,
): Promise<{ overlayPaths: string[]; fingerprint: string }> {
  const parsed = await readAtomicJson(manifestPath, OverlayManifestSchema);
  return {
    overlayPaths: parsed.overlayPaths,
    fingerprint: parsed.overlayFingerprint ?? parsed.fingerprint ?? '',
  };
}
