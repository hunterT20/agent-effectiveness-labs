import type { MetricValue } from './metrics.js';
import type { ProcessInvocation, ProcessResult } from './isolation.js';

export interface AgentDoctorInput {
  readonly workspaceRoot: string;
}

export interface AgentDoctorResult {
  readonly ready: boolean;
  readonly messages: readonly string[];
}

export interface AgentInvocationInput {
  readonly workspaceRoot: string;
  readonly promptFile: string;
  readonly phaseId: string;
  readonly sessionMode: 'new' | 'resume';
}

export interface AgentOutcomeInput {
  readonly processResult: ProcessResult;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface AgentOutcome {
  readonly completed: boolean;
  readonly responseArtifactPaths: readonly string[];
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
  doctor(input: AgentDoctorInput): Promise<AgentDoctorResult>;
  buildInvocation(input: AgentInvocationInput): Promise<ProcessInvocation>;
  parseOutcome(input: AgentOutcomeInput): Promise<AgentOutcome>;
  collectTelemetry(input: AgentTelemetryInput): Promise<AgentTelemetry>;
}
