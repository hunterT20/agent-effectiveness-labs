import { describe, expect, it } from 'vitest';

import { redactSecrets } from '@ael/runtime';

describe('process redaction', () => {
  it('redacts secret patterns before persistence', () => {
    const redacted = redactSecrets('api_key=super-secret-token Bearer abc.def.ghi');
    expect(redacted).not.toContain('super-secret-token');
    expect(redacted).toContain('[REDACTED]');
  });
});
