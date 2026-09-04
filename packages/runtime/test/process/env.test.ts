import { describe, expect, it } from 'vitest';

import { DEFAULT_ENV_ALLOWLIST, buildAgentEnvironment } from '../../src/process/env.js';

const base: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/agent',
  AWS_SECRET_ACCESS_KEY: 'aws-secret-value-1234',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  CURSOR_API_KEY: 'cursor-key-value-5678',
  NODE_OPTIONS: '--require /evil.js',
  AEL_TRIAL_ID: 'trial-1',
  AEL_ARM: 'baseline',
};

describe('buildAgentEnvironment', () => {
  it('drops everything that is not allowlisted and keeps PATH', () => {
    const result = buildAgentEnvironment({ base });
    expect(result.env.PATH).toBe('/usr/bin:/bin');
    expect(result.env.HOME).toBe('/home/agent');
    expect(result.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(result.env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(result.env).not.toHaveProperty('CURSOR_API_KEY');
    expect(result.env).not.toHaveProperty('NODE_OPTIONS');
    expect(result.droppedKeys).toEqual([
      'AEL_ARM',
      'AEL_TRIAL_ID',
      'AWS_SECRET_ACCESS_KEY',
      'CURSOR_API_KEY',
      'NODE_OPTIONS',
      'SSH_AUTH_SOCK',
    ]);
  });

  it('never allowlists NODE_OPTIONS by default', () => {
    expect(DEFAULT_ENV_ALLOWLIST).not.toContain('NODE_OPTIONS');
    expect(DEFAULT_ENV_ALLOWLIST).toContain('PATH');
  });

  it('keeps explicitly allowlisted keys and passthrough prefixes', () => {
    const result = buildAgentEnvironment({
      base,
      allowlist: [...DEFAULT_ENV_ALLOWLIST, 'CURSOR_API_KEY'],
      passthroughPrefixes: ['AEL_'],
    });
    expect(result.env.CURSOR_API_KEY).toBe('cursor-key-value-5678');
    expect(result.env.AEL_TRIAL_ID).toBe('trial-1');
    expect(result.env.AEL_ARM).toBe('baseline');
    expect(result.env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(result.droppedKeys).toEqual(['AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS', 'SSH_AUTH_SOCK']);
  });

  it('lets extra win over base and adds keys not present in base', () => {
    const result = buildAgentEnvironment({
      base,
      extra: { PATH: '/sandbox/bin', AEL_MODE: 'synthetic' },
    });
    expect(result.env.PATH).toBe('/sandbox/bin');
    expect(result.env.AEL_MODE).toBe('synthetic');
    expect(result.droppedKeys).not.toContain('PATH');
  });

  it('collects secret values from base and extra for redaction', () => {
    const result = buildAgentEnvironment({
      base,
      extra: { OPENAI_API_KEY: 'sk-extra-secret-value' },
      secretKeys: ['CURSOR_API_KEY', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'MISSING_KEY'],
    });
    expect(result.secretValues).toEqual([
      'aws-secret-value-1234',
      'cursor-key-value-5678',
      'sk-extra-secret-value',
    ]);
  });

  it('produces deterministic key order regardless of input order', () => {
    const a = buildAgentEnvironment({ base: { PATH: '/a', HOME: '/h', TERM: 'xterm' } });
    const b = buildAgentEnvironment({ base: { TERM: 'xterm', HOME: '/h', PATH: '/a' } });
    expect(Object.keys(a.env)).toEqual(['HOME', 'PATH', 'TERM']);
    expect(Object.keys(b.env)).toEqual(['HOME', 'PATH', 'TERM']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('defaults to process.env as the base', () => {
    const result = buildAgentEnvironment();
    if (process.env.PATH !== undefined) {
      expect(result.env.PATH).toBe(process.env.PATH);
    }
    expect(result.env).not.toHaveProperty('NODE_OPTIONS');
  });
});
