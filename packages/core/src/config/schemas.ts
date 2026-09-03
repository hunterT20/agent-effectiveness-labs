import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

import { ArmActionSchema } from '../contracts/arm.js';
import { CandidateSnapshotSchema } from '../contracts/candidate.js';
import { AEL_ERROR_CODES } from '../contracts/error-codes.js';
import { ConfigValidationError, type ConfigValidationIssue } from '../contracts/errors.js';
import { GradeReportSchema, OutcomeModeSchema, TrialBehaviorSchema } from '../contracts/grade.js';
import { TrialIdentityInputSchema } from '../contracts/trial.js';
import { GateResultSchema } from '../contracts/verdict.js';

const finiteNumber = z
  .number({
    invalid_type_error: AEL_ERROR_CODES.CONFIG_NON_FINITE_NUMBER,
  })
  .refine((value) => Number.isFinite(value), {
    message: AEL_ERROR_CODES.CONFIG_NON_FINITE_NUMBER,
  });

const rateThreshold = finiteNumber.refine((value) => value >= 0 && value <= 1, {
  message: AEL_ERROR_CODES.CONFIG_INVALID_THRESHOLD,
});

const ratioThreshold = finiteNumber.refine((value) => value >= 1, {
  message: AEL_ERROR_CODES.CONFIG_INVALID_THRESHOLD,
});

const positiveInteger = z.number().int().positive();

const SuiteRepositorySchema = z
  .object({
    type: z.literal('local-git'),
    path: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

const SuiteAgentSchema = z
  .object({
    adapter: z.string().min(1),
    model: z.string().min(1),
    reasoning: z.string().min(1),
    permissionMode: z.string().min(1),
  })
  .strict();

const SuiteIsolationRequireSchema = z
  .object({
    filesystemEnforced: z.boolean().optional(),
    networkPolicyEnforced: z.boolean().optional(),
    processTreeEnforced: z.boolean().optional(),
    hiddenGraderProtected: z.boolean().optional(),
    externalArtifactsProtected: z.boolean().optional(),
  })
  .strict();

const SuiteIsolationSchema = z
  .object({
    provider: z.enum(['directory-only', 'agent-cli-sandbox', 'container']),
    require: SuiteIsolationRequireSchema,
    network: z.enum(['inherit', 'deny', 'allow']),
  })
  .strict();

const SuiteDefaultsSchema = z
  .object({
    repeats: positiveInteger,
    concurrency: positiveInteger,
    timeoutMs: positiveInteger,
    randomSeed: z.string().min(1),
    cachePolicy: z.enum(['cold-isolated', 'warm-shared']),
  })
  .strict();

const SuiteDecisionPolicySchema = z
  .object({
    mode: z.enum(['exploratory', 'preregistered']).default('preregistered'),
    minimumCompletedPairs: positiveInteger,
    minimumIndependentFixtures: positiveInteger,
    maximumInfrastructureFailureRate: rateThreshold,
    verifiedSuccessDeltaMin: rateThreshold,
    pairedImprovementPValueMax: rateThreshold,
    multipleComparisonMethod: z.enum(['holm', 'bonferroni', 'none']),
    treatmentCriticalSafetyMax: z.number().int().nonnegative(),
    treatmentStaleEvidenceAcceptedMax: rateThreshold,
    treatmentRecoveryRateMin: rateThreshold,
    treatmentFalseBlockRateMax: rateThreshold,
    telemetryCoverageMin: rateThreshold,
    treatmentToControlCostPerSuccessMaxRatio: ratioThreshold,
    treatmentToControlMedianDurationMaxRatio: ratioThreshold,
    treatmentToControlMedianTokensMaxRatio: ratioThreshold,
  })
  .strict();

export const SuiteDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    repository: SuiteRepositorySchema,
    agent: SuiteAgentSchema,
    isolation: SuiteIsolationSchema,
    defaults: SuiteDefaultsSchema,
    primaryControlArm: z.string().min(1),
    primaryTreatmentArm: z.string().min(1),
    arms: z.array(z.string().min(1)),
    fixtures: z.array(z.string().min(1)).min(1),
    decisionPolicy: SuiteDecisionPolicySchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.arms.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: AEL_ERROR_CODES.CONFIG_EMPTY_ARMS,
        path: ['arms'],
      });
    }
  });

export type SuiteDocument = z.infer<typeof SuiteDocumentSchema>;

export const ArmDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    actions: z.array(ArmActionSchema),
  })
  .strict();

export type ArmDocument = z.infer<typeof ArmDocumentSchema>;

const FixturePhaseSchema = z
  .object({
    id: z.string().min(1),
    promptFile: z.string().min(1),
    session: z.enum(['new', 'resume']),
  })
  .strict();

const FixtureRequiredArtifactSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(['agent-final', 'agent-intermediate']),
    schema: z.string().min(1),
  })
  .strict();

const FixtureCandidateSchema = z
  .object({
    allowedPaths: z.array(z.string().min(1)),
    forbiddenPaths: z.array(z.string().min(1)),
    requiredArtifacts: z.array(FixtureRequiredArtifactSchema).optional(),
  })
  .strict();

const FixtureDeterministicGraderSchema = z
  .object({
    id: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    required: z.boolean(),
  })
  .strict();

const FixtureBlindedRubricSchema = z
  .object({
    enabled: z.boolean(),
    rubricFile: z.string().min(1).nullable(),
    minimumRaters: z.number().int().nonnegative(),
    minimumAgreement: rateThreshold.nullable(),
  })
  .strict();

const FixtureLlmJudgeSchema = z
  .object({
    role: z.enum(['disabled', 'exploratory', 'primary']),
  })
  .strict();

const FixtureGradingSchema = z
  .object({
    deterministic: z.array(FixtureDeterministicGraderSchema),
    blindedRubric: FixtureBlindedRubricSchema,
    llmJudge: FixtureLlmJudgeSchema,
  })
  .strict();

const FixtureReferenceSchema = z
  .object({
    solutionPatch: z.string().min(1).optional(),
    artifactDirectory: z.string().min(1).optional(),
    mutationCases: z.array(z.string().min(1)).optional(),
  })
  .strict();

const FixtureLimitsSchema = z
  .object({
    timeoutMsPerPhase: positiveInteger,
    maxChangedFiles: positiveInteger,
  })
  .strict();

export const FixtureDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    category: z.string().min(1),
    outcomeMode: OutcomeModeSchema,
    phases: z.array(FixturePhaseSchema).min(1),
    limits: FixtureLimitsSchema,
    candidate: FixtureCandidateSchema,
    grading: FixtureGradingSchema,
    reference: FixtureReferenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const phaseIds = value.phases.map((phase) => phase.id);
    const duplicatePhaseId = phaseIds.find((id, index) => phaseIds.indexOf(id) !== index);
    if (duplicatePhaseId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: AEL_ERROR_CODES.CONFIG_DUPLICATE_ID,
        path: ['phases'],
      });
    }

    if (value.phases[0]?.session !== 'new') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: AEL_ERROR_CODES.CONFIG_INVALID_PHASE_SESSION,
        path: ['phases', 0, 'session'],
      });
    }

    for (const [index, phase] of value.phases.entries()) {
      if (index > 0 && phase.session === 'new' && value.phases[index - 1]?.session !== 'resume') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INVALID_PHASE_SESSION,
          path: ['phases', index, 'session'],
        });
      }
    }

    const requiredArtifacts = value.candidate.requiredArtifacts ?? [];
    const hasDeterministicGrader = value.grading.deterministic.some((grader) => grader.required);
    const blindedEnabled = value.grading.blindedRubric.enabled;
    const llmPrimary = value.grading.llmJudge.role === 'primary';

    if (!hasDeterministicGrader && !blindedEnabled && !llmPrimary) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: AEL_ERROR_CODES.CONFIG_MISSING_GRADER,
        path: ['grading'],
      });
    }

    if (blindedEnabled) {
      if (value.grading.blindedRubric.rubricFile === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INVALID_BLINDED_RUBRIC,
          path: ['grading', 'blindedRubric', 'rubricFile'],
        });
      }
      if (value.grading.blindedRubric.minimumRaters < 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INVALID_BLINDED_RUBRIC,
          path: ['grading', 'blindedRubric', 'minimumRaters'],
        });
      }
      if (value.grading.blindedRubric.minimumAgreement === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INVALID_BLINDED_RUBRIC,
          path: ['grading', 'blindedRubric', 'minimumAgreement'],
        });
      }
    }

    const hasSolutionPatch = value.reference.solutionPatch !== undefined;
    const hasArtifactDirectory = value.reference.artifactDirectory !== undefined;
    const hasRequiredArtifacts = requiredArtifacts.length > 0;

    if (value.outcomeMode === 'repository') {
      if (!hasSolutionPatch) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INCONSISTENT_OUTCOME_MODE,
          path: ['reference', 'solutionPatch'],
        });
      }
      if (hasRequiredArtifacts) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INCONSISTENT_OUTCOME_MODE,
          path: ['candidate', 'requiredArtifacts'],
        });
      }
    }

    if (value.outcomeMode === 'artifact') {
      if (!hasRequiredArtifacts) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INCONSISTENT_OUTCOME_MODE,
          path: ['candidate', 'requiredArtifacts'],
        });
      }
      if (hasSolutionPatch || hasArtifactDirectory) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INCONSISTENT_OUTCOME_MODE,
          path: ['reference'],
        });
      }
    }

    if (value.outcomeMode === 'hybrid') {
      if (!hasSolutionPatch) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INCONSISTENT_OUTCOME_MODE,
          path: ['reference', 'solutionPatch'],
        });
      }
      if (!hasArtifactDirectory) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INCONSISTENT_OUTCOME_MODE,
          path: ['reference', 'artifactDirectory'],
        });
      }
      if (!hasRequiredArtifacts) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: AEL_ERROR_CODES.CONFIG_INCONSISTENT_OUTCOME_MODE,
          path: ['candidate', 'requiredArtifacts'],
        });
      }
    }
  });

export type FixtureDocument = z.infer<typeof FixtureDocumentSchema>;

const PricingRatesSchema = z
  .object({
    inputPerMillion: finiteNumber.nullable(),
    outputPerMillion: finiteNumber.nullable(),
    cachedInputPerMillion: finiteNumber.nullable(),
    reasoningPerMillion: finiteNumber.nullable(),
    subagentPerMillion: finiteNumber.nullable(),
  })
  .strict();

export const PricingDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    currency: z.string().length(3),
    effectiveAt: z.string().datetime(),
    rates: PricingRatesSchema,
  })
  .strict();

export type PricingDocument = z.infer<typeof PricingDocumentSchema>;

export const JSON_SCHEMA_REGISTRY = {
  suite: SuiteDocumentSchema,
  arm: ArmDocumentSchema,
  fixture: FixtureDocumentSchema,
  pricing: PricingDocumentSchema,
  candidateSnapshot: CandidateSnapshotSchema,
  gradeReport: GradeReportSchema,
  gateResult: GateResultSchema,
  trialBehavior: TrialBehaviorSchema,
  trialIdentityInput: TrialIdentityInputSchema,
} as const;

function formatFieldPath(path: (string | number)[]): string {
  if (path.length === 0) {
    return '$';
  }

  return path.reduce<string>((current, segment) => {
    if (typeof segment === 'number') {
      return `${current}[${String(segment)}]`;
    }
    return current.length === 0 ? segment : `${current}.${segment}`;
  }, '');
}

function mapIssueToErrorCode(
  issue: z.ZodIssue,
): (typeof AEL_ERROR_CODES)[keyof typeof AEL_ERROR_CODES] {
  switch (issue.code) {
    case 'unrecognized_keys':
      return AEL_ERROR_CODES.CONFIG_UNKNOWN_FIELD;
    case 'invalid_literal':
      if (issue.path.at(-1) === 'schemaVersion') {
        return AEL_ERROR_CODES.CONFIG_INVALID_SCHEMA_VERSION;
      }
      return AEL_ERROR_CODES.CONFIG_VALIDATION_FAILED;
    case 'invalid_type':
      if (issue.message === AEL_ERROR_CODES.CONFIG_NON_FINITE_NUMBER) {
        return AEL_ERROR_CODES.CONFIG_NON_FINITE_NUMBER;
      }
      if ('received' in issue && issue.received === 'nan') {
        return AEL_ERROR_CODES.CONFIG_NON_FINITE_NUMBER;
      }
      return AEL_ERROR_CODES.CONFIG_VALIDATION_FAILED;
    case 'custom':
      if (
        Object.values(AEL_ERROR_CODES).includes(
          issue.message as (typeof AEL_ERROR_CODES)[keyof typeof AEL_ERROR_CODES],
        )
      ) {
        return issue.message as (typeof AEL_ERROR_CODES)[keyof typeof AEL_ERROR_CODES];
      }
      return AEL_ERROR_CODES.CONFIG_VALIDATION_FAILED;
    case 'too_small':
    case 'too_big':
      if (issue.message === AEL_ERROR_CODES.CONFIG_INVALID_THRESHOLD) {
        return AEL_ERROR_CODES.CONFIG_INVALID_THRESHOLD;
      }
      if (issue.message === AEL_ERROR_CODES.CONFIG_NON_FINITE_NUMBER) {
        return AEL_ERROR_CODES.CONFIG_NON_FINITE_NUMBER;
      }
      return AEL_ERROR_CODES.CONFIG_VALIDATION_FAILED;
    default:
      return AEL_ERROR_CODES.CONFIG_VALIDATION_FAILED;
  }
}

function extractIssueDetails(issue: z.ZodIssue): ConfigValidationIssue {
  if (issue.code === 'unrecognized_keys') {
    const keys = 'keys' in issue ? issue.keys : [];
    const fieldPath = keys[0] ?? '$';
    return {
      fieldPath,
      code: AEL_ERROR_CODES.CONFIG_UNKNOWN_FIELD,
      message: issue.message,
    };
  }

  const fieldPath = formatFieldPath(issue.path);
  const code = mapIssueToErrorCode(issue);

  return {
    fieldPath,
    code,
    message: issue.message,
  };
}

function parseDocument<TSchema extends z.ZodTypeAny>(
  input: unknown,
  filePath: string,
  schema: TSchema,
): z.infer<TSchema> {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data as z.infer<TSchema>;
  }

  const issues = result.error.issues.map((issue) => extractIssueDetails(issue));
  const firstIssue = issues[0] ?? {
    fieldPath: '$',
    code: AEL_ERROR_CODES.CONFIG_VALIDATION_FAILED,
    message: 'Configuration validation failed',
  };
  const summary = issues.map((issue) => `${issue.fieldPath}: ${issue.message}`).join('; ');

  throw new ConfigValidationError(`${filePath}: ${summary}`, {
    code: firstIssue.code,
    filePath,
    fieldPath: firstIssue.fieldPath,
    issues,
    cause: result.error,
  });
}

export function parseSuiteDocument(input: unknown, filePath: string): SuiteDocument {
  return parseDocument(input, filePath, SuiteDocumentSchema);
}

export function parseArmDocument(input: unknown, filePath: string): ArmDocument {
  return parseDocument(input, filePath, ArmDocumentSchema);
}

export function parseFixtureDocument(input: unknown, filePath: string): FixtureDocument {
  return parseDocument(input, filePath, FixtureDocumentSchema);
}

export function parsePricingDocument(input: unknown, filePath: string): PricingDocument {
  return parseDocument(input, filePath, PricingDocumentSchema);
}

export function generateJsonSchemas(targetDir: string): Record<string, string> {
  mkdirSync(targetDir, { recursive: true });
  const outputs: Record<string, string> = {};

  for (const [name, schema] of Object.entries(JSON_SCHEMA_REGISTRY)) {
    const jsonSchema = zodToJsonSchema(schema, {
      name,
      $refStrategy: 'none',
    });
    const outputPath = join(targetDir, `${name}.schema.json`);
    const serialized = `${JSON.stringify(jsonSchema, null, 2)}\n`;
    writeFileSync(outputPath, serialized, 'utf8');
    outputs[name] = outputPath;
  }

  return outputs;
}

export function readGeneratedSchema(
  name: keyof typeof JSON_SCHEMA_REGISTRY,
  targetDir: string,
): string {
  return readFileSync(join(targetDir, `${name}.schema.json`), 'utf8');
}
