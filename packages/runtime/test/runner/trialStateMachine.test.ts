import { describe, expect, it } from 'vitest';

import { transitionTrialStatus } from '@ael/runtime';

describe('trial state machine', () => {
  it('follows explicit transitions', () => {
    expect(transitionTrialStatus('pending', 'start_preparing')).toBe('preparing');
    expect(transitionTrialStatus('preparing', 'prepared')).toBe('running');
    expect(transitionTrialStatus('running', 'agent_finished')).toBe('collecting');
    expect(transitionTrialStatus('collecting', 'collection_complete')).toBe('grading');
    expect(transitionTrialStatus('grading', 'grading_complete')).toBe('completed');
  });
});
