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
    /**
     * Workspace-relative paths (files or directory prefixes) the setup command may create or
     * modify. Defaults to the command `cwd` subtree. Any other mutation fails materialization.
     */
    allowedWritePaths: z.array(z.string().min(1)).optional(),
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

export const ArmMaterializationSchema = z
  .object({
    schemaVersion: z.literal(1),
    armId: z.string().min(1),
    /** SHA-256 of each canonical action document, in declaration order. */
    actionHashes: z.array(z.string()),
    /** Workspace-relative files owned by `workspace-overlay` actions. */
    overlayPaths: z.array(z.string()),
    /** Fingerprint over `overlayPaths` only (path, mode, content) right after materialization. */
    overlayFingerprint: z.string(),
    /** Files copied into the isolated home by `home-overlay` actions (relative to that home). */
    homeOverlayPaths: z.array(z.string()),
    /** Environment variables contributed by `environment` actions. */
    environment: z.record(z.string()),
    environmentKeys: z.array(z.string()),
    argvAdditions: z.array(z.string()),
    /** Absolute plugin directories contributed by `plugin-directory` actions. */
    pluginDirs: z.array(z.string()),
    adapterVersion: z.string().nullable(),
    setupLogs: z.array(z.string()),
  })
  .strict();

export type ArmMaterialization = z.infer<typeof ArmMaterializationSchema>;

export interface ArmProvider {
  readonly id: string;
  readonly contractVersion: 1;
  doctor(input: ArmDoctorInput): Promise<ArmDoctorResult>;
  materialize(input: ArmMaterializeInput): Promise<ArmMaterialization>;
}
