import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import type { ArmAction, ArmDocument, ArmMaterialization } from '@ael/core';
import { isInside } from '@ael/core';

import { computeTreeFingerprint } from '../git/index.js';
import { runCommonPreparation } from '../workspace/commonPreparation.js';

export interface MaterializeArmInput {
  readonly workspaceRoot: string;
  readonly trialId: string;
  readonly arm: ArmDocument;
  readonly suiteRoot: string;
  readonly overlayManifestPath: string;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function copyOverlay(
  sourcePath: string,
  workspaceRoot: string,
  targetRelativePath: string,
): Promise<string> {
  const targetPath = join(workspaceRoot, targetRelativePath);
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  return targetRelativePath;
}

async function applyAction(
  action: ArmAction,
  input: MaterializeArmInput,
  state: {
    actionHashes: string[];
    overlayPaths: string[];
    environmentKeys: string[];
    argvAdditions: string[];
    setupLogs: string[];
  },
): Promise<void> {
  switch (action.type) {
    case 'workspace-overlay': {
      const sourcePath = resolve(input.suiteRoot, action.source);
      if (!isInside(sourcePath, input.suiteRoot)) {
        throw new Error(`workspace overlay escapes suite root: ${action.source}`);
      }
      const targetRelative = relative(input.suiteRoot, sourcePath);
      const overlayPath = await copyOverlay(sourcePath, input.workspaceRoot, targetRelative);
      state.overlayPaths.push(overlayPath);
      state.actionHashes.push(hashContent(JSON.stringify(action)));
      break;
    }
    case 'environment': {
      state.environmentKeys.push(...Object.keys(action.variables));
      state.actionHashes.push(hashContent(JSON.stringify(action)));
      break;
    }
    case 'agent-argument': {
      state.argvAdditions.push(...action.args);
      state.actionHashes.push(hashContent(JSON.stringify(action)));
      break;
    }
    case 'plugin-directory': {
      const pluginPath = resolve(input.suiteRoot, action.path);
      if (!isInside(pluginPath, input.suiteRoot)) {
        throw new Error(`plugin directory escapes suite root: ${action.path}`);
      }
      state.overlayPaths.push(relative(input.suiteRoot, pluginPath));
      state.actionHashes.push(hashContent(JSON.stringify(action)));
      break;
    }
    default:
      throw new Error(`unsupported arm action for M1: ${action.type}`);
  }
}

export async function materializeArm(input: MaterializeArmInput): Promise<ArmMaterialization> {
  await runCommonPreparation({ workspaceRoot: input.workspaceRoot });

  const state = {
    actionHashes: [] as string[],
    overlayPaths: [] as string[],
    environmentKeys: [] as string[],
    argvAdditions: [] as string[],
    setupLogs: [] as string[],
  };

  for (const action of input.arm.actions) {
    await applyAction(action, input, state);
  }

  const overlayFingerprint = await computeTreeFingerprint(input.workspaceRoot);
  await writeFile(
    input.overlayManifestPath,
    `${JSON.stringify({ overlayPaths: state.overlayPaths, fingerprint: overlayFingerprint }, null, 2)}\n`,
    'utf8',
  );

  return {
    armId: input.arm.id,
    actionHashes: state.actionHashes,
    overlayPaths: state.overlayPaths,
    environmentKeys: state.environmentKeys,
    argvAdditions: state.argvAdditions,
    adapterVersion: null,
    setupLogs: state.setupLogs,
  };
}

export async function readOverlayManifest(
  manifestPath: string,
): Promise<{ overlayPaths: string[]; fingerprint: string }> {
  const raw = await readFile(manifestPath, 'utf8');
  return JSON.parse(raw) as { overlayPaths: string[]; fingerprint: string };
}
