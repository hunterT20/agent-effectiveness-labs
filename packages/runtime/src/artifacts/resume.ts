import { readFile } from 'node:fs/promises';

import { readAtomicJson } from './atomicWrite.js';
import { resolveArtifactPath } from './paths.js';
import { AttemptStateSchema } from './schemas.js';

export interface Checkpoint {
  readonly trialId: string;
  readonly attemptId: string;
  readonly checkpointSeq: number;
  readonly state: unknown;
}

interface CheckpointEvent {
  readonly type: 'checkpoint';
  readonly trialId: string;
  readonly attemptId: string;
  readonly checkpointSeq: number;
}

function isCheckpointEvent(value: unknown): value is CheckpointEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Partial<CheckpointEvent>;
  return (
    candidate.type === 'checkpoint' &&
    typeof candidate.trialId === 'string' &&
    typeof candidate.attemptId === 'string' &&
    typeof candidate.checkpointSeq === 'number'
  );
}

export async function readLastValidCheckpoint(experimentRoot: string): Promise<Checkpoint | null> {
  const eventsPath = resolveArtifactPath(experimentRoot, 'events.ndjson');
  let raw = '';
  try {
    raw = await readFile(eventsPath, 'utf8');
  } catch {
    return null;
  }

  const events: unknown[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed) as unknown);
    } catch {
      // Skip invalid NDJSON lines.
    }
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isCheckpointEvent(event)) {
      continue;
    }

    const statePath = resolveArtifactPath(
      experimentRoot,
      `attempts/${event.trialId}/${event.attemptId}/state.json`,
    );

    try {
      const state = await readAtomicJson(statePath, AttemptStateSchema);
      return {
        trialId: event.trialId,
        attemptId: event.attemptId,
        checkpointSeq: event.checkpointSeq,
        state,
      };
    } catch {
      // Continue scanning for the previous valid checkpoint.
    }
  }

  return null;
}
