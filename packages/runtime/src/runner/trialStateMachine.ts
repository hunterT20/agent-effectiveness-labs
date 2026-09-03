import type { TrialStatus } from '@ael/core';

export type TrialTransition =
  | 'start_preparing'
  | 'prepared'
  | 'agent_started'
  | 'agent_finished'
  | 'collection_complete'
  | 'grading_complete'
  | 'agent_failed'
  | 'timed_out'
  | 'infrastructure_failed'
  | 'cancelled';

const TRANSITIONS: Record<TrialStatus, Partial<Record<TrialTransition, TrialStatus>>> = {
  pending: {
    start_preparing: 'preparing',
    cancelled: 'cancelled',
  },
  preparing: {
    prepared: 'running',
    infrastructure_failed: 'infrastructure_failed',
    cancelled: 'cancelled',
  },
  running: {
    agent_finished: 'collecting',
    agent_failed: 'agent_failed',
    timed_out: 'timed_out',
    infrastructure_failed: 'infrastructure_failed',
    cancelled: 'cancelled',
  },
  collecting: {
    collection_complete: 'grading',
    infrastructure_failed: 'infrastructure_failed',
    cancelled: 'cancelled',
  },
  grading: {
    grading_complete: 'completed',
    infrastructure_failed: 'infrastructure_failed',
    cancelled: 'cancelled',
  },
  completed: {},
  agent_failed: {
    collection_complete: 'grading',
    infrastructure_failed: 'infrastructure_failed',
  },
  timed_out: {
    collection_complete: 'grading',
    infrastructure_failed: 'infrastructure_failed',
  },
  infrastructure_failed: {},
  cancelled: {},
};

export function transitionTrialStatus(
  current: TrialStatus,
  event: TrialTransition,
): TrialStatus | null {
  return TRANSITIONS[current][event] ?? null;
}

export function isTerminalStatus(status: TrialStatus): boolean {
  return status === 'completed' || status === 'infrastructure_failed' || status === 'cancelled';
}
