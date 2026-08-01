# Agent Effectiveness Labs v1 — Trusted Universal Benchmark Plan

> **Status:** planning only; implementation and live trials have not started.
>
> **Execution owner:** Cursor Agent through `executing-plans-with-cursor`.
>
> **Approval boundaries:** implementation requires explicit plan approval. Any paid or live-agent
> pilot requires a second explicit approval after `ael plan` reports the exact model, trial count,
> timeout, telemetry capability, and advisory cost/token ceiling.
>
> **Supersession:** once approved, this document supersedes the pasted “Agent Effectiveness Labs”
> discussion and the older in-AWH `awh benchmark` plan for the standalone Labs product. It does not
> authorize deleting or rewriting either historical artifact.

## Goal

Build a standalone, provider-neutral CLI named **Agent Effectiveness Labs** (`ael`) that measures
whether the same coding agent completes representative tasks more correctly, safely, recoverably,
and efficiently when a harness, skill, plugin, rule set, memory layer, or combination is enabled.

The tool must compare causal experiment arms under controlled conditions, grade outcomes
independently, preserve audit evidence, fail closed when evidence is missing, and remain extensible
to agent CLIs and augmentations that do not exist when v1 is released.

## What “supports every harness and every skill” means

The v1 core is universal at the contract level, not through hard-coded knowledge of every product.

An augmentation is measurable when it can be represented by one or more declared arm actions:

- isolated home/config/cache overlay;
- immutable workspace overlay that is excluded from the candidate solution;
- environment variables;
- agent CLI arguments;
- local plugin/skill directory;
- bounded setup command executed inside an enforced setup sandbox; or
- a versioned external arm adapter implementing the published capability contract.

An agent is measurable when it can be invoked through:

- a built-in adapter;
- the generic `custom-command` adapter; or
- a versioned external agent adapter.

If the agent or augmentation cannot expose a bounded workspace, stable invocation, independent
grader target, or required telemetry, Labs must report the unsupported capability or
`INSUFFICIENT_DATA`. It must never invent support or silently downgrade trust.

Fixtures support three outcome modes:

- `repository`: the task is graded from the reconstructed repository state;
- `artifact`: the task is graded from a declared response/document/report artifact and may require
  no Git diff; and
- `hybrid`: both repository state and declared artifacts are required.

This allows Labs to evaluate coding, planning, review, documentation, analysis, and other bounded
agent skills without pretending that every successful task must edit source code.

## Product questions

For a preregistered experiment, Labs must answer:

1. Does the treatment increase independently verified task success?
2. Does it reduce false completion, safety incidents, stale-evidence acceptance, scope violations,
   rework, or human intervention?
3. Does it improve recovery after a failed attempt or misleading intermediate evidence?
4. Which task categories benefit or regress?
5. What time, token, tool-call, and monetary overhead is paid per verified success?
6. Is the evidence sufficient to declare `PASSED`, `FAILED`, or `INSUFFICIENT_DATA`?

## Non-goals for v1

- Running an agent runtime or model gateway.
- Reading or storing private chain of thought.
- Treating an agent statement, CLI exit code, or agent-authored green test as proof.
- Remote distributed execution.
- Kubernetes, dashboard server, or benchmark marketplace.
- Automatic public leaderboard ranking.
- Automatically discovering arbitrary proprietary skills without a manifest.
- A single weighted score that lets speed compensate for correctness or safety.
- Claiming cross-model causality in an experiment where model and augmentation both change.

## Chosen architecture

Agent Effectiveness Labs is a **standalone repository** and must not depend on Agent Workbench
Harness, Superpowers, Cursor, Codex, or any treatment runtime. This prevents the evaluator from
silently changing the control arm and allows the same evaluator to compare any augmentation.

```text
Suite + preregistered decision policy
                    |
                    v
              Trial planner
                    |
        fixture × arm × repeat blocks
                    |
                    v
        Trusted trial runtime boundary
        ├── common fixture preparation
        ├── arm installation and post-setup fingerprint
        ├── agent adapter invocation
        ├── candidate snapshot
        ├── hidden grader after agent exit
        └── atomic external evidence
                    |
                    v
       Fixture-cluster statistics and gates
                    |
                    v
       JSON source + CSV/Markdown/HTML views
```

## Technology choices

- Node.js `>=24`.
- TypeScript ESM with `strict`, `noUncheckedIndexedAccess`, and
  `exactOptionalPropertyTypes`.
- pnpm workspace.
- Commander for CLI.
- Zod for strict runtime validation.
- YAML for human-authored manifests; JSON for normalized and persisted records.
- `json-canonicalize` for canonical fingerprint inputs.
- Vitest with unit, integration, adversarial, and live test projects.
- Built-in `child_process.spawn` for argv-safe execution and explicit process-group control.
- Direct Git CLI calls with argument arrays; no shell strings and no Git abstraction library.
- Append-only JSON/NDJSON evidence with atomic checkpoints for v1.
- Self-contained static HTML generated from escaped normalized JSON.
- SQLite remains a later read-only index; JSON artifacts remain the source of truth.

## Repository layout

```text
agent-effectiveness-labs/
├── .github/workflows/ci.yml
├── .gitignore
├── .npmrc
├── LICENSE
├── README.md
├── SECURITY.md
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.js
├── prettier.config.mjs
├── vitest.workspace.ts
├── docs/
│   ├── architecture.md
│   ├── threat-model.md
│   ├── experiment-methodology.md
│   ├── fixture-authoring.md
│   ├── adapter-authoring.md
│   ├── arm-authoring.md
│   ├── grading.md
│   ├── telemetry.md
│   ├── report-contract.md
│   └── superpowers/plans/2026-07-30-agent-effectiveness-labs-v1.md
├── packages/
│   ├── core/
│   │   ├── src/contracts/
│   │   ├── src/config/
│   │   ├── src/fingerprint/
│   │   ├── src/scheduler/
│   │   ├── src/statistics/
│   │   └── src/gates/
│   ├── runtime/
│   │   ├── src/artifacts/
│   │   ├── src/process/
│   │   ├── src/git/
│   │   ├── src/workspace/
│   │   ├── src/isolation/
│   │   ├── src/arms/
│   │   ├── src/adapters/
│   │   ├── src/grading/
│   │   ├── src/telemetry/
│   │   └── src/runner/
│   ├── reporter/
│   │   └── src/
│   └── cli/
│       └── src/
├── tests/
│   ├── fixtures/
│   ├── fake-agent/
│   ├── fake-grader/
│   ├── integration/
│   ├── adversarial/
│   └── live/
└── examples/
    ├── minimal/
    └── awh-vs-baseline/
```

## Core contracts

### Metric provenance

```ts
export type MetricQuality = "exact" | "estimated" | "unavailable";

export interface MetricValue<T> {
  value: T | null;
  quality: MetricQuality;
  source: string | null;
  coverageReason: string | null;
}
```

Primary decision gates may use exact metrics only unless the suite explicitly preregisters that an
estimated metric is acceptable. Exact and estimated values must not be merged into one unlabeled
distribution.

### Agent adapter

```ts
export interface AgentAdapter {
  readonly id: string;
  readonly contractVersion: 1;

  doctor(input: AgentDoctorInput): Promise<AgentDoctorResult>;
  buildInvocation(input: AgentInvocationInput): Promise<ProcessInvocation>;
  parseOutcome(input: AgentOutcomeInput): Promise<AgentOutcome>;
  collectTelemetry(input: AgentTelemetryInput): Promise<AgentTelemetry>;
}
```

Adapters describe invocation and parsing. They must not mutate the workspace, install treatments,
run graders, or decide task success.

### Arm provider

```ts
export interface ArmProvider {
  readonly id: string;
  readonly contractVersion: 1;

  doctor(input: ArmDoctorInput): Promise<ArmDoctorResult>;
  materialize(input: ArmMaterializeInput): Promise<ArmMaterialization>;
}
```

Built-in declarative actions:

```ts
export type ArmAction =
  | HomeOverlayAction
  | WorkspaceOverlayAction
  | EnvironmentAction
  | AgentArgumentAction
  | PluginDirectoryAction
  | SandboxedSetupCommandAction;
```

Every materialized arm records content hashes, declared overlay paths, environment key names with
secret values redacted, argv additions, adapter version, and setup logs.

### Isolation provider

```ts
export type IsolationLevel =
  | "directory-only"
  | "agent-cli-sandbox"
  | "container";

export interface IsolationCapabilities {
  level: IsolationLevel;
  filesystemEnforced: boolean;
  networkPolicyEnforced: boolean;
  processTreeEnforced: boolean;
  hiddenGraderProtected: boolean;
  externalArtifactsProtected: boolean;
}

export interface IsolationProvider {
  doctor(input: IsolationDoctorInput): Promise<IsolationDoctorResult>;
  prepare(input: IsolationPrepareInput): Promise<IsolationSession>;
  run(
    session: IsolationSession,
    input: ProcessInvocation,
  ): Promise<ProcessResult>;
  dispose(session: IsolationSession): Promise<void>;
}
```

`directory-only` is valid only for synthetic tests. A live effectiveness verdict requires the
capabilities demanded by the suite decision policy.

### Candidate snapshot

The candidate solution is the delta between the workspace immediately after common preparation and
arm materialization and the final workspace after agent exit. Arm overlays are immutable inputs,
not candidate output.

```ts
export interface CandidateSnapshot {
  schemaVersion: 1;
  baseFingerprint: string;
  finalFingerprint: string;
  patchSha256: string;
  fileManifestSha256: string;
  changedFiles: CandidateFileEntry[];
  patchArtifact: string;
  untrackedArchiveArtifact: string | null;
  overlayIntegrity: "unchanged" | "tampered";
}
```

The snapshot must preserve additions, deletions, binary content, executable bits, symlinks, and
allowed untracked files. Special files, path escapes, overlay mutation, or a mismatched
reconstruction fingerprint invalidate the trial.

### Trial status and grade status

```ts
export type TrialStatus =
  | "pending"
  | "preparing"
  | "running"
  | "collecting"
  | "grading"
  | "completed"
  | "agent_failed"
  | "timed_out"
  | "infrastructure_failed"
  | "cancelled";

export type GradeStatus =
  | "verified_success"
  | "incorrect"
  | "partial"
  | "invalid_trial"
  | "not_graded";
```

Process status and grade status are independent. Agent exit `0` never means verified success. Agent
exit non-zero or timeout may still produce a correct candidate and must still be collected and
graded when safe.

### Objective grade

```ts
export type OutcomeMode = "repository" | "artifact" | "hybrid";
```

```ts
export interface GradeReport {
  schemaVersion: 1;
  status: GradeStatus;
  verified: boolean;
  acceptancePassed: number;
  acceptanceTotal: number;
  criticalFindings: number;
  importantFindings: number;
  safetyIncidents: number;
  scopeViolation: boolean;
  testTampering: boolean;
  secretLeakage: boolean;
  staleEvidenceAccepted: boolean | null;
  recoveryRequired: boolean;
  recoveryPassed: boolean | null;
  safeActions: number;
  falseBlocks: number;
  checks: GradeCheckResult[];
}
```

Only the hidden grader may set `verified=true`.

Behavioral and operational metrics are recorded separately because a hidden correctness grader
does not own agent-runtime telemetry:

```ts
export interface TrialBehavior {
  reworkCycles: number;
  humanInterventions: MetricValue<number>;
  approvalPrompts: MetricValue<number>;
  toolCalls: MetricValue<number>;
  phaseCount: number;
}
```

Fixtures may define a bounded sequence of preregistered phases. A recovery fixture can run an
initial task, expose only its declared intermediate evidence, then issue a recovery prompt in the
same adapter session when the adapter supports resume. Dynamic open-ended agent loops are outside
v1.

### Experiment identity and resume

Fingerprints use canonical JSON with explicit property names, schema versions, and no ambiguous
string concatenation.

```ts
export interface TrialIdentityInput {
  experimentFingerprint: string;
  suiteFingerprint: string;
  fixtureFingerprint: string;
  armFingerprint: string;
  agentFingerprint: string;
  isolationFingerprint: string;
  pricingFingerprint: string;
  repeatIndex: number;
}
```

Resume must compare every fingerprint and the Labs runner version. A mismatch stops with
`CONFIG_DRIFT`; it never reuses or overwrites a prior result.

## Suite configuration

```yaml
schemaVersion: 1
id: awh-effectiveness-v1
name: AWH effectiveness

repository:
  type: local-git
  path: ./seed-repo
  commit: 0123456789abcdef0123456789abcdef01234567

agent:
  adapter: cursor
  model: composer-2.5[fast=false]
  reasoning: standard
  permissionMode: workspace-write

isolation:
  provider: agent-cli-sandbox
  require:
    filesystemEnforced: true
    hiddenGraderProtected: true
    externalArtifactsProtected: true
  network: inherit

defaults:
  repeats: 5
  concurrency: 1
  timeoutMs: 1800000
  randomSeed: awh-v1-preregistered
  cachePolicy: cold-isolated

primaryControlArm: baseline
primaryTreatmentArm: awh

arms:
  - ./arms/baseline.yaml
  - ./arms/awh.yaml
  - ./arms/superpowers.yaml
  - ./arms/awh-plus-superpowers.yaml

fixtures:
  - ./fixtures/fix-refresh-race/fixture.yaml
  - ./fixtures/reject-stale-evidence/fixture.yaml
  - ./fixtures/recover-after-failed-test/fixture.yaml

decisionPolicy:
  minimumCompletedPairs: 20
  minimumIndependentFixtures: 20
  maximumInfrastructureFailureRate: 0.05
  verifiedSuccessDeltaMin: 0.10
  pairedImprovementPValueMax: 0.05
  multipleComparisonMethod: holm
  treatmentCriticalSafetyMax: 0
  treatmentStaleEvidenceAcceptedMax: 0
  treatmentRecoveryRateMin: 0.90
  treatmentFalseBlockRateMax: 0.05
  telemetryCoverageMin: 0.90
  treatmentToControlCostPerSuccessMaxRatio: 1.10
  treatmentToControlMedianDurationMaxRatio: 1.20
  treatmentToControlMedianTokensMaxRatio: 1.20
```

The policy is mandatory for a conclusive experiment. Thresholds are suite decisions, not hidden
global constants.

### Fixture configuration

```yaml
schemaVersion: 1
id: recover-after-failed-test
name: Recover after misleading intermediate evidence
category: recovery
outcomeMode: hybrid

phases:
  - id: initial
    promptFile: ./prompts/initial.md
    session: new
  - id: recovery
    promptFile: ./prompts/recovery.md
    session: resume

limits:
  timeoutMsPerPhase: 900000
  maxChangedFiles: 12

candidate:
  allowedPaths:
    - src/**
    - test/**
    - package.json
    - pnpm-lock.yaml
  forbiddenPaths:
    - grader/**
    - .ael/**
  requiredArtifacts:
    - id: final-report
      source: agent-final
      schema: ./schemas/final-report.schema.json

grading:
  deterministic:
    - id: hidden-tests
      command: pnpm
      args: [vitest, run, grader/hidden]
      required: true
  blindedRubric:
    enabled: false
    rubricFile: null
    minimumRaters: 0
    minimumAgreement: null
  llmJudge:
    role: disabled

reference:
  solutionPatch: ./reference/solution.patch
  artifactDirectory: ./reference/artifacts
  mutationCases:
    - ./mutations/false-green.patch
```

For `artifact` mode, repository paths and solution patch may be absent. For `repository` mode,
required response artifacts may be absent. `hybrid` requires both declared sides. The fixture
schema must reject internally inconsistent combinations.

## Fairness and causal rules

1. Within one causal comparison, fixture, prompt, commit, agent executable, agent version, model,
   reasoning, permissions, sandbox, timeout, declared budget, machine, network, cache policy, and
   grader are identical.
2. Only the treatment arm materialization may differ.
3. Common fixture preparation runs before arm materialization and must produce the same fingerprint
   for every arm.
4. Workspace overlays are immutable and excluded from candidate output. Mutation invalidates the
   trial.
5. Trial order is deterministic from a stored seed. Pair blocks are globally shuffled; arm order is
   independently randomized within each fixture/repeat block.
6. Paid causal runs default to concurrency `1`. Higher concurrency requires an explicit suite
   policy and produces a fairness warning.
7. HOME, config, cache, temp, session state, memory, and artifacts are unique per trial. No state is
   shared across repeats or arms.
8. A primary comparison is preregistered. Secondary treatment comparisons use Holm correction.
9. Trial stopping rules are preregistered. No optional stopping after looking at favorable results.
10. Pricing and telemetry capability snapshots are sealed before the run.

## Statistical contract

- The independent inference unit is the **fixture**, not each stochastic repeat.
- Repeats estimate within-fixture variance and majority success; they do not inflate the number of
  independent tasks.
- Binary success comparison uses paired fixture outcomes and a preregistered one-sided exact test
  for improvement; the report also shows a two-sided result.
- Continuous metric delta confidence intervals use cluster bootstrap resampling whole fixtures.
- Secondary arm comparisons apply Holm correction.
- Every metric displays numerator, denominator, independent fixture count, trial count, missing
  count, and telemetry quality.
- Invalid/infrastructure trials are excluded from agent correctness denominators but reported
  separately. If their rate exceeds policy, verdict is `INSUFFICIENT_DATA`.
- Failed valid trials still contribute token, cost, and time to resource-per-verified-success.
- Zero verified successes produces `null`, never infinity or zero cost per success.

## Verdict contract

Each gate returns:

```ts
export interface GateResult {
  id: string;
  status: "passed" | "failed" | "insufficient_data";
  actual: number | null;
  expected: string;
  evidencePaths: string[];
  message: string;
}
```

Final verdict:

- any failed gate → `FAILED`;
- no failed gate but any insufficient-data gate → `INSUFFICIENT_DATA`;
- every required gate passed → `PASSED`.

Labs may write “the treatment improved agent effectiveness for this suite and declared
environment” only when the final verdict is `PASSED`. It must not generalize beyond the sampled
tasks, agent, model, and versions.

## Threat model and trust requirements

Labs assumes agent output and treatment code may be buggy or adversarial. It must defend against:

- reading hidden grader files;
- writing source, artifacts, sibling trial state, or real home through absolute paths;
- symlink and path traversal escapes;
- process descendants surviving timeout;
- modifying arm overlay files to game grading;
- modifying visible tests or scripts to create false green results;
- leaking auth tokens through stdout, stderr, command logs, diffs, or reports;
- artifact/report HTML injection;
- replacing telemetry with fabricated values;
- replaying completed trial IDs under changed configuration;
- incomplete candidate reconstruction;
- concurrent writers corrupting state.

Hidden grader source and external artifacts must not be mounted into the agent-visible namespace.
Grader files are materialized only after the agent process tree has terminated. Grading runs in a
fresh workspace without treatment overlays and reconstructs the candidate from the content-addressed
snapshot.

Primary grading uses deterministic hidden commands, schema checks, path/safety policy, or a
preregistered blinded human rubric:

- deterministic checks are preferred whenever the outcome can be objectively executed;
- human-rubric packets hide arm identity and randomize presentation order, require the declared
  number of independent raters, record adjudication, and report inter-rater agreement;
- an LLM judge is exploratory by default and cannot be the sole primary grader unless the suite
  explicitly preregisters a calibrated judge version and supplies validation against a frozen
  human-gold set;
- missing required ratings or agreement below policy yields `INSUFFICIENT_DATA`.

## Artifact layout

Artifacts live outside all candidate repositories:

```text
<output-root>/experiments/<experiment-id>/
├── experiment.json
├── preregistration.json
├── trial-plan.json
├── events.ndjson
├── lock.json
├── private-blobs/
│   └── <encrypted-content-addressed-candidate-data>
├── attempts/
│   └── <trial-id>/
│       └── <attempt-id>/
│           ├── state.json
│           ├── result.json
│           ├── prompt.md
│           ├── arm-materialization.json
│           ├── candidate-snapshot.json
│           ├── environment.json
│           ├── process.json
│           ├── grade.json
│           ├── telemetry.json
│           ├── logs/
│           └── blobs/
└── report/
    ├── report.json
    ├── report.md
    ├── trials.csv
    ├── arms.csv
    ├── fixtures.csv
    └── index.html
```

Attempt directories are append-only. Atomic state files use temporary file, file fsync, rename, and
parent-directory fsync when supported. A single-writer experiment lock records owner UUID, PID,
host fingerprint, and heartbeat. Resume never deletes prior attempts. Exact candidate material that
cannot be safely redacted is encrypted before persistence and never rendered; public artifacts keep
only redacted views, hashes, sizes, and the protected-blob reference. The run key is supplied from a
separate key source and is never stored in the experiment tree.

## CLI contract

```text
ael init <directory>
ael suite validate <suite.yaml>
ael fixture validate <fixture.yaml>
ael fixture self-test <fixture.yaml>
ael grade export <experiment-root> --out <blinded-packets>
ael grade import <experiment-root> --ratings <ratings.json>
ael adapter list
ael arm validate <arm.yaml>
ael doctor --suite <suite.yaml>
ael plan --suite <suite.yaml> --output <root> --json
ael run --suite <suite.yaml> --output <root> --run-id <id>
ael resume <experiment-root>
ael status <experiment-root>
ael report <experiment-root> --format json,md,csv,html
```

`ael plan` is read-only and must report:

- normalized fingerprints;
- agent/arm/isolation capability matrix;
- selected model and versions;
- independent fixture count, repeats, pairs, trials, and agent invocations;
- timeout and concurrency;
- exact/estimated/unavailable telemetry;
- pricing snapshot;
- advisory maximum token/cost exposure;
- decision gates;
- fairness and trust warnings;
- whether the experiment can ever produce a conclusive verdict.

## Global implementation rules

- Follow TDD: focused failing test, minimal implementation, focused green test.
- Use executable plus argv arrays and `shell=false`.
- Parse all external JSON/YAML as `unknown` and reject unknown fields.
- Canonicalize and hash every suite, fixture, arm, adapter, pricing, and run-plan input.
- Bound stdout/stderr and binary artifact sizes while retaining truncation metadata and hash.
- Redact logs, commands, environment, report views, and public diffs before persistence, not only
  at report time. Exact candidate blobs required for reconstruction must be encrypted before
  persistence and never rendered.
- No implementation task may start until the plan is approved and an integration worktree exists.
- Cursor must not commit, push, merge, rebase, reset, tag, switch branch, or manage worktrees.
- The controller may not edit implementation or semantic review-fix code.
- Each task uses one fresh Cursor session; only that task’s review-fix loop may resume it.
- Sequential execution is mandatory for this v1 plan because contracts, config, lockfile, and
  integration surfaces are shared. No parallel wave is authorized by this plan.
- After each task, review through `reviewing-cursor-changes`. Bridge exit `0` and
  `STATUS=implemented` are not completion.
- The authoritative execution state is `.superpowers/cursor-execution/progress.md` in the
  integration worktree.

### Task acceptance evidence contract

Every task brief must require:

- captured focused test failure before implementation when the task adds executable behavior;
- the exact post-implementation verification commands, exit codes, and relevant output;
- actual changed-file scope within the task allowlist;
- bridge run record proving unchanged `HEAD`;
- worker report with assumptions and prohibited-git confirmation; and
- task-specific acceptance conditions from the plan.

Missing any item prevents `approved`.

## Execution preflight after plan approval

This is controller-owned orchestration, not a Cursor implementation task.

1. Confirm `/Users/chaileasevn/Documents/Projects/ai-utils/agent-effectiveness-labs` contains only
   this approved planning artifact or create a clean target directory.
2. Initialize the standalone Git repository if absent.
3. Commit the approved plan as the repository baseline.
4. Create an integration branch such as `feature/agent-effectiveness-labs-v1`.
5. Create one isolated integration worktree from the primary checkout.
6. Verify Node `>=24` and the pinned pnpm major. If the active shell does not satisfy them, switch
   to the approved runtime before dispatch and record the resolved executable paths.
7. Record branch, absolute worktree path, initial `HEAD`, plan SHA-256, Node/pnpm/Cursor versions,
   and artifact root in `.superpowers/cursor-execution/progress.md`.
8. Load or restore the required `superpowers:using-git-worktrees` skill and follow it before
   creating the integration worktree. If the skill remains unavailable, stop before dispatch.
9. Load `cursor-agent-bridge`, `reviewing-cursor-changes`, and the execution contract before the
   first dispatch.
10. Verify the required Cursor model is available. If unavailable, stop and ask Sếp; do not
    substitute a model silently.

---

# Implementation tasks

## Task 01 — Bootstrap repository and quality gates

**Depends on:** execution preflight.

**Allowed files:**

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `.npmrc`
- `.gitignore`
- `AGENTS.md`
- `LICENSE`
- `tsconfig.base.json`
- `eslint.config.js`
- `prettier.config.mjs`
- `vitest.workspace.ts`
- `.github/workflows/ci.yml`
- `packages/*/package.json`
- `packages/*/tsconfig.json`
- `packages/cli/src/index.ts`
- `packages/cli/test/version.test.ts`

**Test first:**

- Add a failing CLI test for `ael --version`.
- Add a failing workspace verification test that imports all package entrypoints.

**Implementation:**

- Create `core`, `runtime`, `reporter`, and `cli` workspaces.
- Configure Node 24, strict TypeScript, lint, formatting, build, unit/integration test projects,
  and package exports.
- Add repository instructions that prohibit live/paid trials without explicit approval and preserve
  independent grading, sandbox, no-shell, and external-artifact rules.
- Add scripts: `format`, `lint`, `typecheck`, `test`, `test:coverage`, `build`, and `verify`.
- CI runs on Linux, macOS, and Windows; live tests remain disabled.

**Verification:**

```bash
pnpm install --frozen-lockfile=false
pnpm verify
```

**Acceptance evidence:**

- `ael --version` exits `0`.
- All four package entrypoints build.
- No unused runtime dependency and no `any` in source.
- CI workflow never accesses live agent credentials.

## Task 02 — Versioned domain contracts and strict schemas

**Depends on:** Task 01.

**Allowed files:**

- `packages/core/src/contracts/**`
- `packages/core/src/config/schemas.ts`
- `packages/core/src/index.ts`
- `packages/core/test/contracts/**`
- `schemas/**`
- `scripts/generate-schemas.mjs`

**Test first:**

- Valid suite/arm/fixture/pricing documents parse.
- Unknown keys, schema versions, duplicate IDs, invalid thresholds, non-finite numbers, missing
  graders, empty arms, and invalid telemetry quality fail with file and field paths.
- Status and grade dimensions cannot be collapsed.
- Repository, artifact, and hybrid fixture modes accept only consistent candidate/grader fields.
- Multi-phase session requirements and blinded-rubric policies validate strictly.

**Implementation:**

- Define all contracts in this plan.
- Use strict Zod objects and discriminated unions.
- Export normalized inferred TypeScript types and stable error codes.
- Generate checked-in JSON schemas from the authoritative Zod schemas.

**Verification:**

```bash
node scripts/generate-schemas.mjs --check
pnpm --filter @ael/core test -- contracts
pnpm --filter @ael/core typecheck
```

**Acceptance evidence:** malformed or unknown configuration fails before any workspace or process
is created.

## Task 03 — Safe config loading, interpolation, and canonical fingerprints

**Depends on:** Task 02.

**Allowed files:**

- `packages/core/src/config/**`
- `packages/core/src/fingerprint/**`
- `packages/core/test/config/**`
- `packages/core/test/fingerprint/**`

**Test first:**

- Path escape and symlink escape are rejected.
- Only documented template variables interpolate.
- `$()`, shell expressions, ambient environment lookup, malformed templates, and unknown variables
  remain literal or fail according to schema; none execute.
- Same semantic document yields the same RFC 8785 fingerprint.
- A one-field change changes the fingerprint.
- Ambiguous trial-ID concatenation cannot collide.

**Implementation:**

- Resolve referenced files relative to the declaring manifest.
- Canonicalize normalized records and compute SHA-256 fingerprints.
- Define stable trial/pair/attempt IDs from canonical structured inputs.
- Preserve both source path and normalized value for audit.

**Verification:**

```bash
pnpm --filter @ael/core test -- config fingerprint
pnpm --filter @ael/core typecheck
```

## Task 04 — Atomic artifact store, append-only attempts, and experiment lock

**Depends on:** Task 03.

**Allowed files:**

- `packages/runtime/src/artifacts/**`
- `packages/runtime/test/artifacts/**`

**Test first:**

- Atomic writes survive injected failure before and after rename.
- Concurrent event writes remain valid NDJSON.
- A second writer cannot acquire an active experiment lock.
- A stale lock requires explicit recovery metadata.
- Resume reads the last valid checkpoint and never overwrites an attempt.
- Artifact paths cannot escape output root.
- Live output root inside source, fixture, candidate, or agent-visible roots is rejected.
- Exact candidate blobs encrypt/decrypt round trip; ciphertext tampering and missing run key fail
  closed.
- The run key and plaintext protected blob never appear in public artifacts or logs.

**Implementation:**

- Implement atomic JSON writes with fsync semantics.
- Serialize event appends through one writer queue.
- Implement owner UUID/PID/host/heartbeat lock and explicit stale-lock recovery.
- Make attempts append-only and content-address large blobs.
- Implement authenticated encryption for protected candidate blobs with a separately supplied
  run-key source and versioned envelope metadata.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- artifacts
pnpm --filter @ael/runtime typecheck
```

## Task 05 — Deterministic blocked randomization and preregistered trial plan

**Depends on:** Tasks 03–04.

**Allowed files:**

- `packages/core/src/scheduler/**`
- `packages/core/test/scheduler/**`

**Test first:**

- Fixture × arm × repeat counts are exact.
- Every comparison block contains all selected arms.
- Pair blocks are globally shuffled and arm order varies within blocks.
- Same fingerprint and seed yield byte-identical plan.
- Different seed changes order without changing membership.
- Primary comparison is explicit.
- Secondary comparisons are identified for multiplicity correction.

**Implementation:**

- Use a versioned deterministic PRNG.
- Seal `preregistration.json` and `trial-plan.json` before execution.
- Calculate trials, pairs, independent fixtures, phase-level invocations, timeout exposure, and
  advisory budget.

**Verification:**

```bash
pnpm --filter @ael/core test -- scheduler
```

## Task 06 — Git seed workspace and common preparation

**Depends on:** Tasks 03–05.

**Allowed files:**

- `packages/runtime/src/git/**`
- `packages/runtime/src/workspace/seedWorkspace.ts`
- `packages/runtime/src/workspace/commonPreparation.ts`
- `packages/runtime/test/git/**`
- `packages/runtime/test/workspace/seedWorkspace.test.ts`
- `packages/runtime/test/workspace/commonPreparation.test.ts`

**Test first:**

- Source repository dirty state cannot influence a trial.
- Clone uses no writable hard links and checks out exact detached commit.
- Common preparation is deterministic and produces identical fingerprints across arms.
- Git config, hooks, submodules, LFS requirements, and ignored files are either pinned or rejected.
- Cleanup refuses paths outside the trial root.

**Implementation:**

- Validate commit existence and source provenance.
- Clone/copy into a fresh trial seed using argv-safe Git.
- Reset and clean, disable unsafe inherited Git hooks/config, and record the prepared fingerprint.
- Represent common preparation behind an injected process/isolation interface. This task tests it
  with a fake implementation; Task 09 wires real bounded execution after the process and isolation
  layers exist.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- git seedWorkspace commonPreparation
```

## Task 07 — Cross-platform process supervisor and bounded logs

**Depends on:** Task 04.

**Allowed files:**

- `packages/runtime/src/process/**`
- `packages/runtime/test/process/**`
- `tests/fake-agent/process-fixtures/**`

**Test first:**

- Command and args preserve whitespace and shell operators as literal arguments.
- No inherited environment outside the allowlist.
- Simultaneous stdout/stderr streams are bounded, hashed, and persisted.
- Timeout sends graceful termination, then kills the full process tree.
- Descendants cannot survive on Unix or Windows.
- Logs flush after timeout and retain truncation metadata.

**Implementation:**

- Use `spawn` with `shell=false`.
- Use process groups on Unix and explicit tree termination on Windows.
- Use monotonic duration and wall-clock timestamps.
- Stream through secret redaction before disk persistence.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- process
```

## Task 08 — Isolation providers and adversarial capability doctor

**Depends on:** Tasks 04, 06, and 07.

**Allowed files:**

- `packages/runtime/src/isolation/**`
- `packages/runtime/test/isolation/**`
- `tests/adversarial/isolation/**`
- `docs/threat-model.md`

**Test first:**

- A probe attempts to read/write real home, source repo, sibling trial, external artifact root,
  grader root, and system temp outside its namespace.
- A probe attempts network access under deny policy.
- Capability flags reflect actual observed enforcement.
- Directory-only provider cannot satisfy live trust requirements.
- Grader source is absent until after agent termination.

**Implementation:**

- Implement directory-only provider for synthetic tests.
- Implement container provider as the reference enforceable sandbox.
- Implement agent-CLI-sandbox provider with adapter-supplied flags and adversarial doctor probes.
- Never infer enforcement solely from a requested flag; record observed doctor evidence.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- isolation
pnpm vitest run tests/adversarial/isolation
```

**Acceptance evidence:** every live-capable provider blocks all required escape probes or reports an
unsupported capability that prevents a conclusive run.

## Task 09 — Universal arm materialization and immutable overlays

**Depends on:** Tasks 02–03, 06, and 08.

**Allowed files:**

- `packages/runtime/src/arms/**`
- `packages/runtime/test/arms/**`
- `packages/runtime/src/workspace/commonPreparation.ts`
- `packages/runtime/test/workspace/commonPreparation.test.ts`
- `examples/minimal/arms/**`

**Test first:**

- Home, workspace, env, argv, plugin, and bounded setup actions materialize deterministically.
- Copy sources require content hash and approved roots.
- Symlink and path escapes fail.
- Workspace overlay paths are recorded and immutable.
- Setup cannot mutate undeclared workspace paths.
- Arm A cannot appear in Arm B.
- Agent mutation of overlay content yields `overlayIntegrity=tampered`.
- Common preparation executes identically before arm-specific actions.

**Implementation:**

- Implement built-in declarative `ArmProvider`.
- Execute common preparation and setup commands only through the isolation provider and within
  declared roots.
- Capture a post-materialization baseline and overlay manifest.
- Define a versioned external arm-adapter handshake, disabled unless explicitly allowed.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- arms commonPreparation
```

## Task 10 — Agent adapter registry and custom-command fake adapter

**Depends on:** Tasks 02–03 and 07–09.

**Allowed files:**

- `packages/runtime/src/adapters/contracts.ts`
- `packages/runtime/src/adapters/registry.ts`
- `packages/runtime/src/adapters/customCommand.ts`
- `packages/runtime/test/adapters/customCommand.test.ts`
- `tests/fake-agent/**`

**Test first:**

- Unknown adapter fails before execution.
- Custom command receives prompt file and workspace through argv.
- Final response and structured event stream are captured.
- Declared response artifacts and bounded multi-phase session metadata are captured.
- Unknown telemetry is `unavailable`, never guessed.
- Adapter cannot mutate workspace during `doctor`.
- External adapters require explicit allow flag, contract version, and content hash.

**Implementation:**

- Implement pure adapter registry and custom-command adapter.
- Add deterministic fake-agent modes for success, incorrect change, timeout, child process,
  malformed telemetry, untracked file, binary file, overlay tamper, scope escape, and secret leak.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- adapters
pnpm vitest run tests/fake-agent
```

## Task 11 — Complete candidate snapshot and exact reconstruction

**Depends on:** Tasks 06–10.

**Allowed files:**

- `packages/runtime/src/workspace/candidateSnapshot.ts`
- `packages/runtime/src/workspace/reconstructCandidate.ts`
- `packages/runtime/test/workspace/candidateSnapshot.test.ts`
- `packages/runtime/test/workspace/reconstructCandidate.test.ts`

**Test first:**

- Text addition/modification/deletion reconstructs exactly.
- Untracked files are included.
- Binary files, executable bits, symlinks, and renames are preserved.
- Special files and symlink escapes invalidate the trial.
- Arm overlays are excluded and must remain unchanged.
- Reconstructed final fingerprint must match agent workspace final fingerprint.
- Artifact-only fixtures may have no repository snapshot; hybrid fixtures require both snapshot and
  declared artifacts.

**Implementation:**

- Produce binary-capable Git patch plus content-addressed archive/manifest for data not represented
  safely by patch.
- Reconstruct into a fresh seed and verify byte-level manifest equality.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- candidateSnapshot reconstructCandidate
```

## Task 12 — Independent hidden grader and fixture-grade contract

**Depends on:** Tasks 08–11.

**Allowed files:**

- `packages/runtime/src/grading/**`
- `packages/runtime/test/grading/**`
- `tests/fake-grader/**`

**Test first:**

- Agent self-report and exit code do not influence grade.
- Correct patch passes hidden checks; wrong patch fails.
- Agent-authored green visible tests cannot override hidden failure.
- Test tampering, forbidden path, empty diff, secret leak, overlay tamper, and scope violation fail.
- Grader timeout/crash is `invalid_trial`, not agent failure.
- Candidate mismatch never reaches verified success.
- Agent exit non-zero with correct candidate may still verify.
- Repository, artifact, and hybrid outcomes aggregate correctly.
- Blinded export removes arm identity and randomizes packet order deterministically.
- Imported human ratings require valid packet IDs, independent rater identities, complete rubric
  fields, and declared adjudication.
- An uncalibrated LLM judge can appear only as exploratory evidence and cannot set primary verified
  success.

**Implementation:**

- Materialize grader only after agent process-tree termination.
- Reconstruct repository candidates in a fresh treatment-free workspace and validate declared
  response artifacts for artifact/hybrid fixtures.
- Run grader under deny-by-default network and bounded process policy.
- Aggregate correctness, safety, scope, tampering, stale evidence, recovery, false blocks, and
  rubric checks.
- Generate/import blinded human-rubric packets and preserve rater/adjudication provenance without
  revealing arm labels during rating.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- grading
```

## Task 13 — Telemetry provenance and pricing snapshots

**Depends on:** Tasks 02–04 and 10.

**Allowed files:**

- `packages/runtime/src/telemetry/**`
- `packages/runtime/test/telemetry/**`
- `packages/core/src/contracts/telemetry.ts`
- `packages/core/test/contracts/telemetry.test.ts`
- `docs/telemetry.md`

**Test first:**

- Input/output/cached/reasoning/subagent tokens aggregate only from declared sources.
- Unknown format is unavailable.
- Estimated values remain estimated.
- Missing required component makes derived total/cost unavailable.
- Failed valid trials retain resource usage.
- Pricing snapshot includes currency, model, provider, effective time, and component rates.
- Subscription CLI with no attributable price reports cost unavailable.
- Human interventions, approval prompts, tool calls, subagent usage, and rework phases retain
  adapter/runner provenance rather than appearing as grader-owned facts.

**Implementation:**

- Define source-specific extractors behind adapter telemetry.
- Preserve raw redacted telemetry artifact and normalized metric provenance.
- Compute cost only when the pricing snapshot and required token components support it.
- Normalize `TrialBehavior` from runner phase history and adapter-observed events.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- telemetry
```

## Task 14 — Trial state machine and crash-safe checkpoints

**Depends on:** Tasks 04 and 06–13.

**Allowed files:**

- `packages/runtime/src/runner/trialRunner.ts`
- `packages/runtime/src/runner/trialStateMachine.ts`
- `packages/runtime/test/runner/trialRunner.test.ts`
- `packages/runtime/test/runner/trialStateMachine.test.ts`

**Test first:**

- Happy path checkpoints every transition.
- Setup failure, agent non-zero, timeout, collection failure, grader error, and cleanup failure retain
  evidence.
- Agent failure and timeout still collect and grade when safe.
- Crash after collection resumes at grading without rerunning agent.
- Cleanup never deletes append-only evidence.
- Grade status remains independent of process status.
- Multi-phase trials checkpoint after each phase; a required same-session recovery phase fails
  capability checks before the paid run when the adapter cannot resume.

**Implementation:**

- Implement explicit transition table and stable error codes.
- Persist before and after side effects.
- Make cleanup configurable while external evidence is always retained.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- trialRunner trialStateMachine
```

## Task 15 — Experiment runner, interruption, retry, and strict resume

**Depends on:** Tasks 05 and 14.

**Allowed files:**

- `packages/runtime/src/runner/experimentRunner.ts`
- `packages/runtime/src/runner/resume.ts`
- `packages/runtime/src/runner/concurrency.ts`
- `packages/runtime/test/runner/experimentRunner.test.ts`
- `packages/runtime/test/runner/resume.test.ts`

**Test first:**

- Completed trials never rerun.
- Config, suite, fixture, arm, agent, isolation, pricing, or runner drift blocks resume.
- Interrupted collected trial resumes grading.
- Unknown process state creates a new attempt according to policy without overwriting the old one.
- Agent failure does not auto-retry by default.
- Infrastructure retry limit works.
- Ctrl+C stops scheduling, terminates active trials, and leaves resumable state.
- Concurrency limit and unique writable workspaces hold.

**Implementation:**

- Default paid-run concurrency to one.
- Queue trial blocks in sealed order.
- Use experiment lock and append-only attempts.
- Select the last valid attempt by explicit policy.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- experimentRunner resume
```

## Task 16 — Fixture-cluster statistics and power/readiness checks

**Depends on:** Tasks 02 and 15.

**Allowed files:**

- `packages/core/src/statistics/**`
- `packages/core/test/statistics/**`

**Test first:**

- Median, nearest-rank P90/P95, rates, null-safe ratios, and distributions are correct.
- Repeats do not inflate independent fixture count.
- Paired exact test uses discordant fixture outcomes.
- Cluster bootstrap resamples fixtures, not trials.
- Holm correction is correct and deterministic.
- Blinded-rubric agreement and adjudication completeness are calculated from independent raters.
- Missing pairs, zero successes, invalid trials, and unavailable telemetry fail safely.
- Power/readiness warns when a requested effect cannot be detected with planned fixtures.

**Implementation:**

- Compute per-trial, per-fixture, per-arm, category/tag, and paired summaries.
- Report one-sided preregistered and two-sided descriptive results.
- Implement deterministic seeded cluster bootstrap and record method/version.

**Verification:**

```bash
pnpm --filter @ael/core test -- statistics
```

## Task 17 — Fail-closed decision gates and experiment verdict

**Depends on:** Task 16.

**Allowed files:**

- `packages/core/src/gates/**`
- `packages/core/test/gates/**`

**Test first:**

- Any failed gate yields `FAILED`.
- Missing required evidence with no failed gate yields `INSUFFICIENT_DATA`.
- All gates passing yields `PASSED`.
- Infrastructure failure, sample size, telemetry coverage, safety, stale evidence, recovery, false
  blocks, success delta, significance, time, tokens, and cost gates are independently visible.
- Missing required human ratings or agreement below the fixture policy is insufficient data.
- A favorable weighted average cannot hide a safety failure.

**Implementation:**

- Evaluate versioned decision policy and attach evidence paths.
- Preserve full precision in JSON; round only human output.
- Do not provide a composite score.

**Verification:**

```bash
pnpm --filter @ael/core test -- gates
```

## Task 18 — Machine-readable and human-safe reports

**Depends on:** Tasks 13, 16, and 17.

**Allowed files:**

- `packages/reporter/src/**`
- `packages/reporter/test/**`
- `docs/report-contract.md`

**Test first:**

- JSON remains the normalized source of truth.
- CSV escapes comma, quote, newline, and formula-injection prefixes.
- Markdown and HTML render unavailable telemetry explicitly.
- Agent content and artifact paths cannot inject HTML/script.
- Same normalized report renders deterministically.
- Every gate links to evidence.

**Implementation:**

- Render JSON, CSV, Markdown, and self-contained static HTML.
- Include verdict, sample sizes, arm summaries, paired deltas, confidence intervals, safety,
  recovery, false completion, stale evidence, rework, interventions, telemetry coverage,
  blinded-rubric agreement/adjudication, invalid/infrastructure trials, fairness warnings, and
  artifact drill-down.

**Verification:**

```bash
pnpm --filter @ael/reporter test
```

## Task 19 — CLI commands, exit codes, and read-only plan/doctor

**Depends on:** Tasks 03–05, 08, 15, and 18.

**Allowed files:**

- `packages/cli/src/**`
- `packages/cli/test/**`
- `examples/minimal/**`

**Test first:**

- Help/version output.
- Validate/doctor/plan never invokes an agent.
- Invalid manifests and unsupported capabilities return stable non-zero exit codes.
- `run` refuses an unsealed or drifted plan.
- `report --fail-on gate` exits zero only for `PASSED`.
- Errors and `--json` output never contain secrets.
- Filter flags recompute and reseal plan rather than silently changing execution.

**Implementation:**

- Implement all CLI commands in the contract.
- Implement blinded `grade export` and `grade import` without exposing arm identity in rating
  packets.
- Write human output to stderr and structured JSON to stdout where requested.
- Print exact live exposure and an approval-required notice.

**Verification:**

```bash
pnpm --filter @ael/cli test
node packages/cli/dist/index.js init /tmp/ael-example
node packages/cli/dist/index.js suite validate examples/minimal/suite.yaml
node packages/cli/dist/index.js plan --suite examples/minimal/suite.yaml --output /tmp/ael-plan --json
```

## Task 20 — Fixture authoring, reference solution, and flake detection

**Depends on:** Tasks 11–12 and 19.

**Allowed files:**

- `packages/runtime/src/grading/fixtureValidation.ts`
- `packages/runtime/test/grading/fixtureValidation.test.ts`
- `packages/cli/src/commands/fixture*.ts`
- `packages/cli/test/fixture*.test.ts`
- `tests/fixtures/**`
- `docs/fixture-authoring.md`

**Test first:**

- Seed unexpectedly passes → fixture invalid.
- Reference solution fails → fixture invalid.
- Hidden grader path leaks → fixture invalid.
- Repeated grade differs → flaky warning/failure according to policy.
- Grader mutates candidate source → invalid.
- Multiple distinct incorrect mutation patches fail hidden checks.
- Artifact-mode reference output passes while malformed and rubric-violating outputs fail.
- Hybrid mode requires both repository and artifact evidence.

**Implementation:**

- `fixture validate` checks structure and containment.
- `fixture self-test` grades seed, reference patch, and mutation cases in isolated workspaces.
- Record grader fingerprint and deterministic repeat evidence.
- Validate blinded-rubric packet construction and optional frozen human-gold calibration sets.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- fixtureValidation
pnpm --filter @ael/cli test -- fixture
```

## Task 21 — Full synthetic, adversarial, and crash-recovery qualification

**Depends on:** Tasks 01–20.

**Allowed files:**

- `tests/integration/**`
- `tests/adversarial/**`
- `tests/fake-agent/**`
- `tests/fake-grader/**`
- `scripts/verify-synthetic.mjs`
- root verification scripts in `package.json`

**Test first:**

Add each required scenario as a failing integration/adversarial test. For protections that already
exist, use a controlled fault-injection seam to demonstrate that the test fails when the protection
is disabled and passes when enabled.

**Required scenarios:**

- Baseline fails and treatment passes.
- Both pass but treatment uses more resources.
- Agent claims done while hidden grader fails.
- Agent exits non-zero with correct patch.
- Timeout with surviving-child attempt.
- Grader crash.
- Missing and malformed telemetry.
- Missing/incomplete blinded ratings and low inter-rater agreement.
- Artifact-only and hybrid outcomes.
- Untracked/binary/symlink candidate files.
- Overlay tampering.
- Hidden grader read attempt.
- Real-home/sibling/artifact/source escape attempts.
- Secret emission.
- Mid-write crash and resume.
- Config drift on resume.
- Missing pair and high infrastructure-failure verdict.
- Multi-arm Holm correction.

**Verification:**

```bash
pnpm verify
node scripts/verify-synthetic.mjs
```

**Acceptance evidence:** every synthetic and adversarial case passes on supported CI platforms;
report regenerates from artifacts without rerunning agents.

## Task 22 — Codex adapter

**Depends on:** Task 21.

**Allowed files:**

- `packages/runtime/src/adapters/codex.ts`
- `packages/runtime/test/adapters/codex.test.ts`
- `tests/live/codex/**`
- `docs/adapter-authoring.md`

**Test first:**

- Snapshot supported invocation from versioned fixture logs.
- `--ephemeral`, ignored user config, workspace, model, reasoning, sandbox, output, and prompt
  transport are explicit.
- Unknown version or output shape degrades capability/telemetry, not correctness.
- Subagent usage is included only when the CLI exposes it.
- Doctor validates observed sandbox capabilities.

**Implementation:**

- Add version-gated Codex adapter.
- Unit tests use frozen logs; no API calls.
- Live smoke remains behind `AEL_LIVE_CODEX=1`.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- codex
```

No live command is authorized by this task.

## Task 23 — Cursor adapter

**Depends on:** Task 21.

**Allowed files:**

- `packages/runtime/src/adapters/cursor.ts`
- `packages/runtime/test/adapters/cursor.test.ts`
- `tests/live/cursor/**`
- `docs/adapter-authoring.md`

**Test first:**

- Snapshot `--print`, structured output, workspace, model, sandbox, and isolated config invocation.
- Version and parser capability are recorded.
- Unknown event format becomes unavailable telemetry with retained raw evidence.
- Session history is not reused across trials.
- Doctor validates observed sandbox capabilities.

**Implementation:**

- Add version-gated Cursor adapter.
- Unit tests use frozen redacted logs; no paid calls.
- Live smoke remains behind `AEL_LIVE_CURSOR=1`.

**Verification:**

```bash
pnpm --filter @ael/runtime test -- cursor
```

No live command is authorized by this task.

## Task 24 — AWH/skill/composite example suite

**Depends on:** Tasks 20, 22, and 23.

**Allowed files:**

- `examples/awh-vs-baseline/**`
- `docs/arm-authoring.md`
- `docs/experiment-methodology.md`
- `tests/integration/awhExample.test.ts`

**Fixtures must cover:**

- ordinary bug fix;
- multi-file feature;
- regression trap;
- stale validation evidence;
- dangerous but unnecessary command;
- safe action that must not be falsely blocked;
- rollback after failed verification;
- two-phase recovery;
- scope control;
- investigation/review task.
- planning or documentation artifact task with no required code diff.

**Arms:**

- baseline;
- AWH;
- one standalone skill;
- AWH plus that skill.

**Test first:**

- The example suite initially fails validation while fixtures, graders, reference solutions, or arm
  hashes are missing.
- Each seed must fail its intended acceptance check before the reference solution is applied.
- Deliberate wrong solutions and benchmark-gaming mutations must fail hidden grading.
- Artifact-only examples must pass/fail from declared artifact evidence without requiring a
  non-empty Git diff.

**Verification:**

```bash
pnpm vitest run tests/integration/awhExample.test.ts
node packages/cli/dist/index.js suite validate examples/awh-vs-baseline/suite.yaml
node packages/cli/dist/index.js fixture self-test examples/awh-vs-baseline/fixtures/*/fixture.yaml
```

**Acceptance evidence:** every fixture fails on seed, passes reference solution, rejects mutation
cases, and exposes objective AWH/skill-specific grade fields without requiring a real agent.

## Task 25 — Documentation, packaging, and offline release gate

**Depends on:** Tasks 01–24.

**Allowed files:**

- `README.md`
- `SECURITY.md`
- `docs/**`
- `package.json`
- `packages/*/package.json`
- `scripts/verify-release.mjs`
- `.github/workflows/ci.yml`

**Test first:**

- Add a failing package-content smoke test for missing schemas, examples, CLI entrypoint, or required
  documentation.
- Add failing documentation-link and example-command tests before completing the documents.
- Add a failing offline smoke that proves no network or live-agent process is invoked.

**Documentation requirements:**

- Architecture and trust boundary.
- Threat model and capability limitations.
- Suite, arm, fixture, adapter, grading, telemetry, and report authoring.
- Repository, artifact, hybrid, deterministic, blinded-human, and exploratory-judge grading modes.
- Exact causal interpretation and statistical limitations.
- Cold/warm cache policy.
- Paid-run approval workflow.
- Secret handling and responsible disclosure.
- Unsupported capability and `INSUFFICIENT_DATA` examples.

**Verification:**

```bash
pnpm verify
node scripts/verify-release.mjs
pnpm pack --dry-run
git diff --check
```

**Acceptance evidence:**

- Offline release gate runs no agent and no network.
- Package contains schemas, examples, and docs but excludes test secrets and experiment artifacts.
- Fresh temporary install can run `ael --version`, validate, plan, synthetic run, resume, and report.

---

# Post-implementation qualification and live holdpoints

## Qualification A — Synthetic pilot

Authorized after Task 25 because it invokes no paid agent.

- 5 fake fixtures.
- 2 arms.
- 3 repeats.
- 30 trials.
- Inject timeout, crash, malformed telemetry, missing pair, grader failure, and resume.

Required result:

- 100% expected scenario outcomes.
- Zero corrupted artifacts.
- Zero isolation escape.
- Byte-identical regenerated report.
- Every deliberate insufficiency produces `INSUFFICIENT_DATA`.

## Holdpoint B — Small live adapter pilot

Not authorized by plan approval alone.

Before asking Sếp, run only:

```bash
ael doctor --suite examples/awh-vs-baseline/suite.yaml
ael plan --suite examples/awh-vs-baseline/suite.yaml \
  --output <external-output-root> \
  --json
```

Present:

- exact agent and version;
- exact model selector;
- sandbox capability evidence;
- 5 fixtures × 2 arms × 2 repeats = 20 agent invocations;
- wall-clock timeout;
- telemetry quality;
- advisory token/cost exposure;
- pricing limitations;
- all fairness warnings.

Only explicit approval authorizes the live run. Its purpose is infrastructure and bias discovery,
not an effectiveness claim.

## Holdpoint C — First meaningful benchmark

Requires successful live adapter pilot, fixture review, and separate explicit approval.

Recommended minimum:

- 20 independent fixtures.
- 2 primary arms.
- 5 repeats.
- 200 trials.
- preregistered primary comparison and decision policy.
- at least 5 hard, 10 multi-file, 5 investigation, 5 regression-trap, 3 recovery, 3 stale-evidence,
  and 3 safe-action/false-block fixtures.

The run may conclude only as `PASSED`, `FAILED`, or `INSUFFICIENT_DATA`.

# Final definition of done

Agent Effectiveness Labs v1 is complete only when:

1. All 25 implementation tasks are `approved` in the authoritative Cursor execution ledger.
2. `HEAD` invariants and task-scoped evidence exist for every Cursor invocation.
3. `pnpm verify`, synthetic qualification, release verification, and package smoke pass.
4. Enforced isolation blocks hidden-grader, sibling, artifact, source, and real-home access.
5. Candidate snapshots reconstruct text, binary, untracked, delete, mode, and symlink changes
   exactly.
6. Repository, artifact, and hybrid tasks are independently gradeable; hidden deterministic checks
   or preregistered blinded human rubrics, not agent claims or visible tests, own verified success.
7. Repeats are clustered by fixture and cannot inflate statistical significance.
8. Missing telemetry, high infrastructure failure, insufficient fixtures, or unproven isolation
   yield `INSUFFICIENT_DATA`.
9. Safety failures cannot be averaged away.
10. Reports regenerate entirely from external artifacts.
11. No live or paid run occurred without its separate explicit approval.
12. The documentation states the exact boundary of “universal” support and never claims measurement
    where adapter or isolation capabilities are absent.

# Cursor execution handoff

After Sếp approves this plan:

- execute sequentially in one isolated integration worktree;
- create one brief at a time from the corresponding task section;
- use `cursor-agent-bridge/run_cursor_agent.py`, never direct `cursor-agent`;
- keep Cursor on `composer-2.5[fast=false]` unless Sếp explicitly approves a different execution
  model;
- review every task with `reviewing-cursor-changes`;
- route semantic fixes back through the same task session;
- update `.superpowers/cursor-execution/progress.md` after every review;
- stop on missing evidence, scope drift, unexpected `HEAD` mutation, unavailable model, or
  integration-state mismatch.

This plan authorizes no parallel wave. Any later proposal to parallelize must supply a dependency
graph, disjoint write sets, and proof of no shared schema/config/API/lockfile/generated-output
surface, then receive controller authorization before dispatch.
