import { z } from 'zod';

export const HomeOverlayActionSchema = z
  .object({
    type: z.literal('home-overlay'),
    source: z.string().min(1),
  })
  .strict();

export const WorkspaceOverlayActionSchema = z
  .object({
    type: z.literal('workspace-overlay'),
    source: z.string().min(1),
  })
  .strict();

export const EnvironmentActionSchema = z
  .object({
    type: z.literal('environment'),
    variables: z.record(z.string()),
  })
  .strict();

export const AgentArgumentActionSchema = z
  .object({
    type: z.literal('agent-argument'),
    args: z.array(z.string()),
  })
  .strict();

export const PluginDirectoryActionSchema = z
  .object({
    type: z.literal('plugin-directory'),
    path: z.string().min(1),
  })
  .strict();

export const SandboxedSetupCommandActionSchema = z
  .object({
    type: z.literal('sandboxed-setup-command'),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const ArmActionSchema = z.discriminatedUnion('type', [
  HomeOverlayActionSchema,
  WorkspaceOverlayActionSchema,
  EnvironmentActionSchema,
  AgentArgumentActionSchema,
  PluginDirectoryActionSchema,
  SandboxedSetupCommandActionSchema,
]);

export type ArmAction = z.infer<typeof ArmActionSchema>;
export type HomeOverlayAction = z.infer<typeof HomeOverlayActionSchema>;
export type WorkspaceOverlayAction = z.infer<typeof WorkspaceOverlayActionSchema>;
export type EnvironmentAction = z.infer<typeof EnvironmentActionSchema>;
export type AgentArgumentAction = z.infer<typeof AgentArgumentActionSchema>;
export type PluginDirectoryAction = z.infer<typeof PluginDirectoryActionSchema>;
export type SandboxedSetupCommandAction = z.infer<typeof SandboxedSetupCommandActionSchema>;

export interface ArmDoctorInput {
  readonly workspaceRoot: string;
}

export interface ArmDoctorResult {
  readonly ready: boolean;
  readonly messages: readonly string[];
}

export interface ArmMaterializeInput {
  readonly workspaceRoot: string;
  readonly trialId: string;
}

export interface ArmMaterialization {
  readonly armId: string;
  readonly actionHashes: readonly string[];
  readonly overlayPaths: readonly string[];
  readonly environmentKeys: readonly string[];
  readonly argvAdditions: readonly string[];
  readonly adapterVersion: string | null;
  readonly setupLogs: readonly string[];
}

export interface ArmProvider {
  readonly id: string;
  readonly contractVersion: 1;
  doctor(input: ArmDoctorInput): Promise<ArmDoctorResult>;
  materialize(input: ArmMaterializeInput): Promise<ArmMaterialization>;
}
