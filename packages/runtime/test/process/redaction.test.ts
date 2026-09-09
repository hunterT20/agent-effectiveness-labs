import { describe, expect, it } from 'vitest';

import { createStreamingRedactor, redactSecrets } from '../../src/process/redaction.js';

describe('process redaction', () => {
  it('redacts secret patterns before persistence', () => {
    const redacted = redactSecrets('api_key=super-secret-token Bearer abc.def.ghi');
    expect(redacted).not.toContain('super-secret-token');
    expect(redacted).not.toContain('abc.def.ghi');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts --api-key <value> and --api-key=<value> while keeping the flag name', () => {
    const spaced = redactSecrets('cursor agent --api-key abcdef123456 --model gpt');
    expect(spaced).toBe('cursor agent --api-key [REDACTED] --model gpt');

    const equals = redactSecrets('cursor agent --api-key=abcdef123456 --model gpt');
    expect(equals).toBe('cursor agent --api-key=[REDACTED] --model gpt');

    const token = redactSecrets('gh auth --token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(token).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('redacts Authorization: Bearer headers as a whole', () => {
    const redacted = redactSecrets('Authorization: Bearer eyJhbGciOi.JIUzI1NiJ9.sig-value');
    expect(redacted).toBe('Authorization: [REDACTED]');
  });

  it('redacts well-known token shapes (sk-, ghp_, AKIA)', () => {
    const text = [
      'openai sk-proj-abcdefghijklmnopqrstuvwxyz',
      'github ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      'aws AKIAIOSFODNN7EXAMPLE',
      'pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
    ].join('\n');
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain('sk-proj-');
    expect(redacted).not.toContain('ghp_');
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).not.toContain('github_pat_');
    expect(redacted.split('[REDACTED]')).toHaveLength(5);
  });

  it('redacts exact literal secrets of length >= 8 and ignores shorter ones', () => {
    const redacted = redactSecrets('value=my-literal-secret and short=abc', {
      literals: ['my-literal-secret', 'abc'],
    });
    expect(redacted).toBe('value=[REDACTED] and short=abc');
  });

  it('removes a literal secret every time it appears', () => {
    const redacted = redactSecrets('s3cretValue... s3cretValue!', { literals: ['s3cretValue'] });
    expect(redacted).toBe('[REDACTED]... [REDACTED]!');
  });

  it('leaves ordinary text untouched', () => {
    const text = 'max_tokens: 100\ntokenizer loaded\nsecretary of state\n';
    expect(redactSecrets(text)).toBe(text);
  });

  describe('streaming redactor', () => {
    it('catches a secret that is split across chunks (line-buffered)', () => {
      const redactor = createStreamingRedactor({ literals: ['split-secret-value'] });
      const out1 = redactor.push('log line one\napi_key=split-se');
      const out2 = redactor.push('cret-value tail sk-abcd');
      const out3 = redactor.push('efghijklmnop\n');
      const flushed = redactor.flush();
      const combined = out1 + out2 + out3 + flushed;

      expect(out1).toBe('log line one\n');
      expect(out2).toBe('');
      expect(combined).not.toContain('split-secret-value');
      expect(combined).not.toContain('sk-abcdefghijklmnop');
      expect(combined).toBe('log line one\napi_key=[REDACTED] tail [REDACTED]\n');
    });

    it('flushes a trailing partial line and redacts it', () => {
      const redactor = createStreamingRedactor();
      expect(redactor.push('Bearer abcdefgh')).toBe('');
      expect(redactor.flush()).toBe('[REDACTED]');
      expect(redactor.flush()).toBe('');
    });

    it('handles multi-byte characters split across Buffer chunks', () => {
      const redactor = createStreamingRedactor();
      const bytes = Buffer.from('héllo sk-abcdefghijklmnop\n', 'utf8');
      const out = redactor.push(bytes.subarray(0, 2)) + redactor.push(bytes.subarray(2));
      expect(out).toBe('héllo [REDACTED]\n');
    });
  });
});
