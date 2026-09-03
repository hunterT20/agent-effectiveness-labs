import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/test/**/*.test.ts'],
          environment: 'node',
          coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['packages/core/src/**/*.ts', 'packages/runtime/src/**/*.ts'],
            thresholds: {
              lines: 85,
              functions: 85,
              statements: 85,
              branches: 70,
            },
          },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'adversarial',
          include: ['tests/adversarial/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'live',
          include: ['tests/live/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
