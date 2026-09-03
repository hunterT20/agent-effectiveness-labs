import { join } from 'node:path';

import type {
  AgentAdapter,
  AgentDoctorInput,
  AgentDoctorResult,
  AgentInvocationInput,
  AgentOutcome,
  AgentOutcomeInput,
  AgentTelemetry,
  AgentTelemetryInput,
  ProcessInvocation,
} from '@ael/core';

export interface CustomCommandAdapterOptions {
  readonly command: string;
  readonly extraArgs?: readonly string[];
  readonly timeoutMs: number;
}

export function createCustomCommandAdapter(
  id: string,
  options: CustomCommandAdapterOptions,
): AgentAdapter {
  return {
    id,
    contractVersion: 1,
    doctor(input: AgentDoctorInput): Promise<AgentDoctorResult> {
      void input;
      return Promise.resolve({
        ready: true,
        messages: [`custom-command adapter ${id} ready`],
      });
    },
    buildInvocation(input: AgentInvocationInput): Promise<ProcessInvocation> {
      const promptPath = join(input.workspaceRoot, input.promptFile);
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      env.AEL_PHASE_ID = input.phaseId;
      env.AEL_SESSION_MODE = input.sessionMode;
      const args = [
        ...(options.extraArgs ?? []),
        '--workspace',
        input.workspaceRoot,
        '--prompt',
        promptPath,
        '--phase',
        input.phaseId,
        '--session',
        input.sessionMode,
      ];
      return Promise.resolve({
        command: options.command,
        args,
        cwd: input.workspaceRoot,
        env,
        timeoutMs: options.timeoutMs,
      });
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
