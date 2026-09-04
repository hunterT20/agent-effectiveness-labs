import { readFile, stat } from 'node:fs/promises';
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
  buildCursorChildEnv,
  ensureIsolatedHome,
  parseCursorAgentVersion,
  probeCursorSandbox,
  probeToObservedCapabilities,
  readCursorAgentVersion,
  redactCursorArgv,
  TESTED_CURSOR_VERSION_RANGES,
} from './cursorSupport.js';

export interface CursorAdapterOptions {
  readonly command?: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly pluginDirs?: readonly string[];
  /** Skip the tested-version gate (doctor still warns). Prefer `AEL_ALLOW_UNTESTED_CURSOR=1`. */
  readonly skipVersionCheck?: boolean;
  /** Skip the live sandbox probe entirely (capabilities reported as unverified). */
  readonly skipSandboxProbe?: boolean;
}

const CAPABILITIES: AgentAdapterCapabilities = {
  resume: true,
  streamJsonTelemetry: true,
  sandboxProbe: true,
};

/** Upper bound for prompt bodies passed as the positional argument (argv budget). */
export const CURSOR_MAX_PROMPT_BYTES = 200 * 1024;

const UNVERIFIED_CAPABILITIES: IsolationCapabilities = {
  level: 'agent-cli-sandbox',
  filesystemEnforced: false,
  networkPolicyEnforced: false,
  processTreeEnforced: false,
  hiddenGraderProtected: false,
  externalArtifactsProtected: false,
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
        messages.push(
          `cursor-agent not found, exited non-zero, or timed out on --version (command: ${command})`,
        );
        return {
          ready: false,
          messages,
          capabilities: CAPABILITIES,
          observedCapabilities: UNVERIFIED_CAPABILITIES,
        };
      }
      messages.push(`cursor-agent version ${version.raw}`);

      let ready = true;
      if (!version.supported) {
        const allowUntested =
          options.skipVersionCheck === true || process.env.AEL_ALLOW_UNTESTED_CURSOR === '1';
        if (allowUntested) {
          messages.push(
            `warning: version ${version.raw} is outside tested ranges (${TESTED_CURSOR_VERSION_RANGES.join(', ')}); proceeding because untested versions were explicitly allowed`,
          );
        } else {
          ready = false;
          messages.push(
            `version ${version.raw} is outside tested ranges (${TESTED_CURSOR_VERSION_RANGES.join(', ')}); set AEL_ALLOW_UNTESTED_CURSOR=1 to proceed at your own risk`,
          );
        }
      }

      let observedCapabilities: IsolationCapabilities = UNVERIFIED_CAPABILITIES;
      if (options.skipSandboxProbe === true || process.env.AEL_SKIP_SANDBOX_PROBE === '1') {
        messages.push(
          'sandbox probe skipped (AEL_SKIP_SANDBOX_PROBE); observed capabilities are unverified',
        );
      } else {
        const probe = await probeCursorSandbox({
          command,
          model: input.model ?? options.model,
          timeoutMs: Math.min(options.timeoutMs, 60_000),
        });
        for (const message of probe.messages) {
          messages.push(message);
        }
        observedCapabilities = probeToObservedCapabilities(probe);
        if (probe.status === 'observed' && !observedCapabilities.filesystemEnforced) {
          messages.push(
            'sandbox probe did not observe filesystem enforcement; do not trust --sandbox flag alone',
          );
        }
      }

      return {
        ready,
        messages,
        version: version.raw,
        capabilities: CAPABILITIES,
        observedCapabilities,
      };
    },
    async buildInvocation(input: AgentInvocationInput): Promise<ProcessInvocation> {
      const promptPath = join(input.workspaceRoot, input.promptFile);
      const isolatedHomeRoot =
        input.isolatedHomeRoot ??
        join(input.workspaceRoot, '.ael', 'isolated-home', input.trialId ?? input.phaseId);
      await ensureIsolatedHome(isolatedHomeRoot);

      const promptInfo = await stat(promptPath);
      if (promptInfo.size > CURSOR_MAX_PROMPT_BYTES) {
        throw new Error(
          `prompt file ${promptPath} is ${String(promptInfo.size)} bytes; cursor adapter limit is ${String(CURSOR_MAX_PROMPT_BYTES)} bytes`,
        );
      }
      const prompt = await readFile(promptPath, 'utf8');
      if (prompt.trim().length === 0) {
        throw new Error(`prompt file ${promptPath} is empty`);
      }

      const env = buildCursorChildEnv(isolatedHomeRoot);
      env.AEL_PHASE_ID = input.phaseId;
      env.AEL_SESSION_MODE = input.sessionMode;

      // Every flag below is cross-checked against `cursor-agent --help` (2026.09.02):
      // -p/--print, --output-format <format>, --trust, --sandbox <mode>, --workspace <path>,
      // --model <model>, --plugin-dir <path> (repeatable), --resume [chatId]. The prompt is the
      // positional `[prompt...]` argument; `@path` is a file *mention*, not a prompt-file flag.
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

      args.push(prompt);

      return {
        command,
        args,
        cwd: input.workspaceRoot,
        env,
        timeoutMs: input.timeoutMs ?? options.timeoutMs,
        redactedArgv: redactCursorArgv(command, args),
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
