import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EventLog } from '@ael/runtime';

describe('event log', () => {
  it('keeps concurrent appends as valid NDJSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ael-events-'));
    const eventsPath = join(dir, 'events.ndjson');
    const log = new EventLog(eventsPath);

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        log.append({ type: 'trial-started', index, trialId: `trial-${index}` }),
      ),
    );

    const raw = await readFile(eventsPath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(50);

    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });
});
