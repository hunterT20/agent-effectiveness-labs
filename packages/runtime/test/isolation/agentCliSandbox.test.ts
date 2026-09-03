import { describe, expect, it, vi, beforeEach } from 'vitest';

const probeCursorSandbox = vi.fn();

vi.mock('../../src/adapters/cursorSupport.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/cursorSupport.js')>();
  return {
    ...actual,
    probeCursorSandbox: (...args: Parameters<typeof actual.probeCursorSandbox>) =>
      probeCursorSandbox(...args),
  };
});

import { createCursorAdapter } from '../../src/adapters/cursor.js';
import { AgentCliSandboxIsolationProvider } from '../../src/isolation/agentCliSandbox.js';

describe('agent-cli-sandbox isolation', () => {
  beforeEach(() => {
    probeCursorSandbox.mockReset();
    delete process.env.AEL_SKIP_SANDBOX_PROBE;
  });

  it('records observed capabilities from sandbox probe', async () => {
    probeCursorSandbox.mockResolvedValue({
      readHomeBlocked: true,
      writeOutsideWorkspaceBlocked: true,
      networkBlocked: true,
      messages: ['probe ok'],
    });
    const adapter = createCursorAdapter({
      model: 'composer-2.5',
      timeoutMs: 30_000,
      skipSandboxProbe: true,
    });
    const provider = new AgentCliSandboxIsolationProvider({ adapter });
    const result = await provider.doctor({ requestedCapabilities: { filesystemEnforced: true } });
    expect(result.observedCapabilities.level).toBe('agent-cli-sandbox');
    expect(result.observedCapabilities.filesystemEnforced).toBe(true);
    expect(result.observedCapabilities.networkPolicyEnforced).toBe(true);
    expect(result.supported).toBe(true);
    expect(probeCursorSandbox).toHaveBeenCalled();
  });

  it('never trusts sandbox flag alone when probe is inconclusive', async () => {
    probeCursorSandbox.mockResolvedValue({
      readHomeBlocked: false,
      writeOutsideWorkspaceBlocked: false,
      networkBlocked: false,
      messages: ['no output'],
    });
    const adapter = createCursorAdapter({
      model: 'composer-2.5',
      timeoutMs: 30_000,
      skipSandboxProbe: true,
    });
    const provider = new AgentCliSandboxIsolationProvider({ adapter });
    const result = await provider.doctor({ requestedCapabilities: { filesystemEnforced: true } });
    expect(result.supported).toBe(false);
    expect(result.messages.join(' ')).toContain('never trust');
  });
});
