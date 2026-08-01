import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['packages/**/test/**/*.test.ts'],
      environment: 'node',
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
      },
    },
  },
]);
