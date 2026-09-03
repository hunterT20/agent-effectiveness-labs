import { describe, expect, it } from 'vitest';

import { fixtureRequiresResumeCapability } from '@ael/runtime';

describe('experiment runner helpers', () => {
  it('detects fixtures that require resume capability', () => {
    const requires = fixtureRequiresResumeCapability([
      {
        schemaVersion: 1,
        id: 'multi',
        name: 'multi',
        category: 'recovery',
        outcomeMode: 'repository',
        phases: [
          { id: 'initial', promptFile: './a.md', session: 'new' },
          { id: 'recovery', promptFile: './b.md', session: 'resume' },
        ],
        limits: { timeoutMsPerPhase: 1000, maxChangedFiles: 1 },
        candidate: { allowedPaths: ['src/**'], forbiddenPaths: [] },
        grading: {
          deterministic: [],
          blindedRubric: {
            enabled: false,
            rubricFile: null,
            minimumRaters: 0,
            minimumAgreement: null,
          },
          llmJudge: { role: 'disabled' },
        },
        reference: {},
      },
    ]);
    expect(requires).toBe(true);
  });
});
