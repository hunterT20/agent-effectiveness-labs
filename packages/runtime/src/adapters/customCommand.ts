import { isAbsolute, join } from 'node:path';

import type {
  AgentAdapter,
  AgentAdapterCapabilities,
  AgentDoctorInput,
  AgentDoctorResult,
  AgentInvocationInput,
  AgentOutcome,
  AgentOutcomeInput,
  AgentTelemetry,
  AgentTelemetryInput,
  ProcessInvocation,
} from '@ael/core';

import { buildAgentEnvironment } from '../process/env.js';
import { buildIsolatedHomeEnv, ensureIsolatedHome } from './cursorSupport.js';

export interface CustomCommandAdapterOptions {
  readonly command: string;
  readonly extraArgs?: readonly string[];
  readonly timeoutMs: number;
  /**
   * Capabilities declared by the wrapped command. Defaults to `resume: true` for the built-in
   * `fake-agent` id (the fake agent accepts `--session resume`) and to undefined otherwise.
   */
  readonly capabilities?: AgentAdapterCapabilities;
}

export const FAKE_AGENT_ADAPTER_ID = 'fake-agent';

const FAKE_AGENT_CAPABILITIES: AgentAdapterCapabilities = {
  resume: true,
  streamJsonTelemetry: false,
  sandboxProbe: false,
};

function resolveCapabilities(
  id: string,
  options: CustomCommandAdapterOptions,
): AgentAdapterCapabilities | undefined {
  if (options.capabilities !== undefined) {
    return options.capabilities;
  }
  return id === FAKE_AGENT_ADAPTER_ID ? FAKE_AGENT_CAPABILITIES : undefined;
}

export function createCustomCommandAdapter(
  id: string,
  options: CustomCommandAdapterOptions,
): AgentAdapter {
  const capabilities = resolveCapabilities(id, options);
  return {
    id,
    contractVersion: 1,
    ...(capabilities !== undefined ? { capabilities } : {}),
    doctor(input: AgentDoctorInput): Promise<AgentDoctorResult> {
      void input;
      return Promise.resolve({
        ready: true,
        messages: [`custom-command adapter ${id} ready`],
        ...(capabilities !== undefined ? { capabilities } : {}),
      });
    },
    async buildInvocation(input: AgentInvocationInput): Promise<ProcessInvocation> {
      const promptPath = isAbsolute(input.promptFile)
        ? input.promptFile
        : join(input.workspaceRoot, input.promptFile);
      const isolatedExtras: Record<string, string> = {};
      if (input.isolatedHomeRoot !== undefined) {
        await ensureIsolatedHome(input.isolatedHomeRoot);
        Object.assign(isolatedExtras, buildIsolatedHomeEnv(input.isolatedHomeRoot));
        isolatedExtras.AEL_ISOLATED_HOME_ROOT = input.isolatedHomeRoot;
      }
      const { env, secretValues } = buildAgentEnvironment({
        extra: {
          ...isolatedExtras,
          ...(input.environment ?? {}),
          AEL_PHASE_ID: input.phaseId,
          AEL_SESSION_MODE: input.sessionMode,
          ...(input.trialId !== undefined ? { AEL_TRIAL_ID: input.trialId } : {}),
        },
        passthroughPrefixes: ['AEL_'],
      });
      const args = [
        ...(options.extraArgs ?? []),
        ...(input.argvAdditions ?? []),
        '--workspace',
        input.workspaceRoot,
        '--prompt',
        promptPath,
        '--phase',
        input.phaseId,
        '--session',
        input.sessionMode,
      ];
      if (input.sessionMode === 'resume' && input.resumeChatId !== undefined) {
        args.push('--resume', input.resumeChatId);
      }
      for (const pluginDir of input.pluginDirs ?? []) {
        args.push('--plugin-dir', pluginDir);
      }
      return {
        command: options.command,
        args,
        cwd: input.workspaceRoot,
        env,
        timeoutMs: input.timeoutMs ?? options.timeoutMs,
        ...(secretValues.length > 0 ? { redactLiterals: secretValues } : {}),
      };
    },
    parseOutcome(input: AgentOutcomeInput): Promise<AgentOutcome> {
      return Promise.resolve({
        completed: input.processResult.exitCode === 0,
        responseArtifactPaths: [],
      });
    },
    collectTelemetry(input: AgentTelemetryInput): Promise<AgentTelemetry> {
      void input;
      const unavailable = {
        value: null,
        quality: 'unavailable' as const,
        source: 'custom-command',
        coverageReason: 'telemetry not declared by adapter',
      };
      return Promise.resolve({
        inputTokens: unavailable,
        outputTokens: unavailable,
        cachedInputTokens: unavailable,
        reasoningTokens: unavailable,
        subagentTokens: unavailable,
        toolCalls: unavailable,
      });
    },
  };
}
