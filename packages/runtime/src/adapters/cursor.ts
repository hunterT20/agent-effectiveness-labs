import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  IsolationCapabilities,
  ProcessInvocation,
} from '@ael/core';

import { extractCursorTelemetry } from '../telemetry/cursorExtractor.js';
import {
  buildIsolatedHomeEnv,
  ensureIsolatedHome,
  parseCursorAgentVersion,
  probeCursorSandbox,
  readCursorAgentVersion,
  TESTED_CURSOR_VERSION_RANGES,
} from './cursorSupport.js';

export interface CursorAdapterOptions {
  readonly command?: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly pluginDirs?: readonly string[];
  readonly skipVersionCheck?: boolean;
  readonly skipSandboxProbe?: boolean;
}

const CAPABILITIES: AgentAdapterCapabilities = {
  resume: true,
  streamJsonTelemetry: true,
  sandboxProbe: true,
};

export function createCursorAdapter(options: CursorAdapterOptions): AgentAdapter {
  const command = options.command ?? 'cursor-agent';

  return {
    id: 'cursor',
    contractVersion: 1,
    capabilities: CAPABILITIES,
    async doctor(input: AgentDoctorInput): Promise<AgentDoctorResult> {
      const messages: string[] = [];
      const version = await readCursorAgentVersion(command);
      if (version === null) {
        if (process.env.AEL_SKIP_SANDBOX_PROBE === '1') {
          messages.push('cursor-agent version unavailable; probe skipped for CI');
          return {
            ready: true,
            messages,
            capabilities: CAPABILITIES,
          };
        }
        return {
          ready: false,
          messages: ['cursor-agent not found or --version failed'],
          capabilities: CAPABILITIES,
        };
      }
      messages.push(`cursor-agent version ${version.raw}`);
      if (!options.skipVersionCheck && !version.supported) {
        messages.push(
          `version ${version.raw} is outside tested ranges; telemetry and sandbox behavior may degrade`,
        );
      }

      let observedCapabilities: IsolationCapabilities | undefined;
      if (!options.skipSandboxProbe && process.env.AEL_SKIP_SANDBOX_PROBE !== '1') {
        const probe = await probeCursorSandbox({
          command,
          workspaceRoot: input.workspaceRoot,
          model: input.model ?? options.model,
          timeoutMs: Math.min(options.timeoutMs, 60_000),
        });
        for (const message of probe.messages) {
          messages.push(message);
        }
        observedCapabilities = {
          level: 'agent-cli-sandbox',
          filesystemEnforced: probe.readHomeBlocked && probe.writeOutsideWorkspaceBlocked,
          networkPolicyEnforced: probe.networkBlocked,
          processTreeEnforced: false,
          hiddenGraderProtected: false,
          externalArtifactsProtected: false,
        };
        if (!observedCapabilities.filesystemEnforced) {
          messages.push(
            'sandbox probe did not observe filesystem enforcement; do not trust --sandbox flag alone',
          );
        }
      }

      return {
        ready: true,
        messages,
        version: version.raw,
        capabilities: CAPABILITIES,
        ...(observedCapabilities !== undefined ? { observedCapabilities } : {}),
      };
    },
    async buildInvocation(input: AgentInvocationInput): Promise<ProcessInvocation> {
      const promptPath = join(input.workspaceRoot, input.promptFile);
      const isolatedHomeRoot =
        input.isolatedHomeRoot ??
        join(input.workspaceRoot, '.ael', 'isolated-home', input.trialId ?? input.phaseId);
      await ensureIsolatedHome(isolatedHomeRoot);

      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      Object.assign(env, buildIsolatedHomeEnv(isolatedHomeRoot));
      env.AEL_PHASE_ID = input.phaseId;
      env.AEL_SESSION_MODE = input.sessionMode;

      const args = [
        '--print',
        '--output-format',
        'stream-json',
        '--trust',
        '--sandbox',
        'enabled',
        '--workspace',
        input.workspaceRoot,
        '--model',
        input.model ?? options.model,
      ];

      const pluginDirs = input.pluginDirs ?? options.pluginDirs ?? [];
      for (const pluginDir of pluginDirs) {
        args.push('--plugin-dir', pluginDir);
      }

      if (input.sessionMode === 'resume') {
        if (input.resumeChatId === undefined || input.resumeChatId.length === 0) {
          throw new Error('resume session requires resumeChatId from prior phase');
        }
        args.push('--resume', input.resumeChatId);
      }

      args.push(`@${promptPath}`);

      return {
        command,
        args,
        cwd: input.workspaceRoot,
        env,
        timeoutMs: input.timeoutMs ?? options.timeoutMs,
      };
    },
    async parseOutcome(input: AgentOutcomeInput): Promise<AgentOutcome> {
      let sessionChatId: string | undefined;
      try {
        const stdout = await readFile(input.stdoutPath, 'utf8');
        const extraction = extractCursorTelemetry(stdout);
        if (extraction.sessionChatId !== null) {
          sessionChatId = extraction.sessionChatId;
        }
      } catch {
        // outcome parsing falls back to process exit code only
      }

      const completed = input.processResult.exitCode === 0;
      return {
        completed,
        responseArtifactPaths: [],
        ...(sessionChatId !== undefined ? { sessionChatId } : {}),
      };
    },
    async collectTelemetry(input: AgentTelemetryInput): Promise<AgentTelemetry> {
      try {
        const stdout = await readFile(input.stdoutPath, 'utf8');
        return extractCursorTelemetry(stdout).telemetry;
      } catch {
        const unavailable = {
          value: null,
          quality: 'unavailable' as const,
          source: 'cursor-stream-json',
          coverageReason: 'stdout unavailable for telemetry extraction',
        };
        return {
          inputTokens: unavailable,
          outputTokens: unavailable,
          cachedInputTokens: unavailable,
          reasoningTokens: unavailable,
          subagentTokens: unavailable,
          toolCalls: unavailable,
        };
      }
    },
  };
}

export { parseCursorAgentVersion, readCursorAgentVersion, TESTED_CURSOR_VERSION_RANGES };
