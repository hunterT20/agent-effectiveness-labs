import type { MetricValue } from './metrics.js';
import type { IsolationCapabilities, ProcessInvocation, ProcessResult } from './isolation.js';

export interface AgentAdapterCapabilities {
  readonly resume: boolean;
  readonly streamJsonTelemetry: boolean;
  readonly sandboxProbe: boolean;
}

export interface AgentDoctorInput {
  readonly workspaceRoot: string;
  readonly model?: string;
}

export interface AgentDoctorResult {
  readonly ready: boolean;
  readonly messages: readonly string[];
  readonly version?: string;
  readonly capabilities?: AgentAdapterCapabilities;
  readonly observedCapabilities?: IsolationCapabilities;
}

export interface AgentInvocationInput {
  readonly workspaceRoot: string;
  readonly promptFile: string;
  readonly phaseId: string;
  readonly sessionMode: 'new' | 'resume';
  readonly resumeChatId?: string;
  readonly model?: string;
  readonly pluginDirs?: readonly string[];
  readonly trialId?: string;
  readonly isolatedHomeRoot?: string;
  readonly timeoutMs?: number;
}

export interface AgentOutcomeInput {
  readonly processResult: ProcessResult;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface AgentOutcome {
  readonly completed: boolean;
  readonly responseArtifactPaths: readonly string[];
  readonly sessionChatId?: string;
}

export interface AgentTelemetryInput {
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly processResult: ProcessResult;
}

export interface AgentTelemetry {
  readonly inputTokens: MetricValue<number>;
  readonly outputTokens: MetricValue<number>;
  readonly cachedInputTokens: MetricValue<number>;
  readonly reasoningTokens: MetricValue<number>;
  readonly subagentTokens: MetricValue<number>;
  readonly toolCalls: MetricValue<number>;
}

export interface AgentAdapter {
  readonly id: string;
  readonly contractVersion: 1;
  readonly capabilities?: AgentAdapterCapabilities;
  doctor(input: AgentDoctorInput): Promise<AgentDoctorResult>;
  buildInvocation(input: AgentInvocationInput): Promise<ProcessInvocation>;
  parseOutcome(input: AgentOutcomeInput): Promise<AgentOutcome>;
  collectTelemetry(input: AgentTelemetryInput): Promise<AgentTelemetry>;
}
