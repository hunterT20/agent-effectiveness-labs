import { describe, expect, it } from 'vitest';

const liveEnabled = process.env.AEL_LIVE_CURSOR === '1';

describe.skipIf(!liveEnabled)('cursor live smoke', () => {
  it('runs cursor-agent version gate only when explicitly enabled', async () => {
    const { readCursorAgentVersion } = await import('@ael/runtime');
    const version = await readCursorAgentVersion();
    expect(version).not.toBeNull();
    expect(version?.raw.length).toBeGreaterThan(0);
  });
});

describe('cursor live tests gate', () => {
  it('remains disabled unless AEL_LIVE_CURSOR=1', () => {
    expect(process.env.AEL_LIVE_CURSOR).not.toBe('1');
  });
});
