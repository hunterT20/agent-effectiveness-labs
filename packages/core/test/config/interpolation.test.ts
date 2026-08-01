import { describe, expect, it } from 'vitest';

import { interpolateTemplate } from '@ael/core';

describe('interpolateTemplate', () => {
  const context = {
    manifestDir: '/manifests/suite-a',
    suiteId: 'suite-a',
    fixtureId: 'fixture-1',
    armId: 'baseline',
  };

  it('interpolates only documented template variables', () => {
    expect(interpolateTemplate('root=${manifestDir}/data', context)).toBe(
      'root=/manifests/suite-a/data',
    );
    expect(interpolateTemplate('suite=${suiteId}', context)).toBe('suite=suite-a');
    expect(interpolateTemplate('fixture=${fixtureId}', context)).toBe('fixture=fixture-1');
    expect(interpolateTemplate('arm=${armId}', context)).toBe('arm=baseline');
  });

  it('leaves shell expressions literal', () => {
    const input = 'echo $(whoami)';
    expect(interpolateTemplate(input, context)).toBe(input);
  });

  it('does not read ambient environment variables', () => {
    const input = 'home=${HOME} path=$PATH';
    expect(interpolateTemplate(input, context)).toBe(input);
  });

  it('leaves unknown variables literal', () => {
    const input = 'value=${unknownVar}';
    expect(interpolateTemplate(input, context)).toBe(input);
  });

  it('leaves malformed templates literal', () => {
    expect(interpolateTemplate('broken=${manifestDir', context)).toBe('broken=${manifestDir');
    expect(interpolateTemplate('broken=${}', context)).toBe('broken=${}');
  });
});
