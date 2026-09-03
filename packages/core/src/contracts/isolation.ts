import { z } from 'zod';

export const IsolationLevelSchema = z.enum(['directory-only', 'agent-cli-sandbox', 'container']);

export type IsolationLevel = z.infer<typeof IsolationLevelSchema>;

export const IsolationCapabilitiesSchema = z
  .object({
    level: IsolationLevelSchema,
    filesystemEnforced: z.boolean(),
    networkPolicyEnforced: z.boolean(),
    processTreeEnforced: z.boolean(),
    hiddenGraderProtected: z.boolean(),
    externalArtifactsProtected: z.boolean(),
  })
  .strict();

export type IsolationCapabilities = z.infer<typeof IsolationCapabilitiesSchema>;

export interface IsolationDoctorInput {
  readonly requestedCapabilities: Partial<IsolationCapabilities>;
}

export interface IsolationDoctorResult {
  readonly supported: boolean;
  readonly observedCapabilities: IsolationCapabilities;
  readonly messages: readonly string[];
}

export interface IsolationPrepareInput {
  readonly workspaceRoot: string;
  readonly trialId: string;
  readonly logDir?: string;
}

export interface IsolationSession {
  readonly id: string;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdoutPath?: string;
  readonly stderrPath?: string;
}

export interface ProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface IsolationProvider {
  doctor(input: IsolationDoctorInput): Promise<IsolationDoctorResult>;
  prepare(input: IsolationPrepareInput): Promise<IsolationSession>;
  run(session: IsolationSession, input: ProcessInvocation): Promise<ProcessResult>;
  dispose(session: IsolationSession): Promise<void>;
}
