import { describe, expect, it } from 'vitest';

import { DirectoryOnlyIsolationProvider } from '@ael/runtime';

describe('directory-only isolation', () => {
  it('reports all capabilities false and warns synthetic-only', async () => {
    const provider = new DirectoryOnlyIsolationProvider();
    const result = await provider.doctor({
      requestedCapabilities: { filesystemEnforced: true },
    });
    expect(result.observedCapabilities.filesystemEnforced).toBe(false);
    expect(result.supported).toBe(false);
    expect(result.messages.join(' ')).toContain('synthetic-only');
  });
});
